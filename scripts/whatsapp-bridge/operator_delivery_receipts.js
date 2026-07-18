import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const OPERATOR_DELIVERY_CONTRACT_VERSION = 'v1';
export const OPERATOR_RECEIPT_SCHEMA = 'hermes.whatsapp_operator_receipt.v1';

const STORE_SCHEMA = 'hermes.whatsapp_operator_receipt_store.v1';
const RECORD_SCHEMA = 'hermes.whatsapp_operator_receipt_record.v1';
const STORE_FILE = 'operator-delivery-receipts.v1.json';
const STORE_LIMIT = 512;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ORIGIN_REF_RE = /^origin:([0-9a-f]{64})$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const QUERY_FIELDS = [
  'schema_version',
  'contract_version',
  'origin_ref',
  'origin_digest',
  'chat_digest',
  'reply_anchor_digest',
  'effect_key_digest',
  'body_digest',
];
const SEND_FIELDS = [...QUERY_FIELDS, 'chat_id', 'reply_to', 'message'];
const RECORD_FIELDS = [
  'schema_version',
  'status',
  'origin_ref',
  'origin_digest',
  'chat_digest',
  'reply_anchor_digest',
  'effect_key_digest',
  'body_digest',
  'message_id',
  'record_digest',
];
const INTERNAL_STATUSES = new Set(['INVOKING', 'EXACT', 'CONFLICT']);

export class OperatorReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OperatorReceiptError';
    this.code = code;
  }
}

function fail(code) {
  throw new OperatorReceiptError(code);
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((field, index) => field === wanted[index]);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function lengthPrefix(size) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(size));
  return output;
}

export function canonicalDigest(value, domain) {
  if (typeof domain !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(domain)) {
    fail('operator_receipt_digest_domain_invalid');
  }
  let encoded;
  try {
    encoded = Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
  } catch {
    fail('operator_receipt_canonical_json_invalid');
  }
  const domainBytes = Buffer.from(domain, 'ascii');
  return createHash('sha256')
    .update(lengthPrefix(domainBytes.length))
    .update(domainBytes)
    .update(lengthPrefix(encoded.length))
    .update(encoded)
    .digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function operatorMessageId(effectKeyDigest) {
  if (typeof effectKeyDigest !== 'string' || !SHA256_RE.test(effectKeyDigest)) {
    fail('operator_receipt_effect_key_invalid');
  }
  return `3EB0${sha256Text(effectKeyDigest).slice(0, 18).toUpperCase()}`;
}

function validateQuery(value) {
  if (!exactFields(value, QUERY_FIELDS)
      || value.schema_version !== OPERATOR_RECEIPT_SCHEMA
      || value.contract_version !== OPERATOR_DELIVERY_CONTRACT_VERSION) {
    fail('operator_receipt_query_invalid');
  }
  const originMatch = typeof value.origin_ref === 'string'
    ? ORIGIN_REF_RE.exec(value.origin_ref)
    : null;
  if (!originMatch || originMatch[1] !== value.origin_digest) {
    fail('operator_receipt_origin_invalid');
  }
  for (const field of [
    'origin_digest',
    'chat_digest',
    'reply_anchor_digest',
    'effect_key_digest',
    'body_digest',
  ]) {
    if (typeof value[field] !== 'string' || !SHA256_RE.test(value[field])) {
      fail('operator_receipt_query_invalid');
    }
  }
  return Object.fromEntries(QUERY_FIELDS.map((field) => [field, value[field]]));
}

function validateRaw(value, field, maxBytes) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail(`operator_receipt_${field}_invalid`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(`operator_receipt_${field}_invalid`);
  }
  return value;
}

function validateSend(value) {
  if (!exactFields(value, SEND_FIELDS)) {
    fail('operator_receipt_send_invalid');
  }
  const query = validateQuery(
    Object.fromEntries(QUERY_FIELDS.map((field) => [field, value[field]])),
  );
  const chatId = validateRaw(value.chat_id, 'chat_id', 1024);
  const replyTo = validateRaw(value.reply_to, 'reply_to', 1024);
  const message = validateRaw(value.message, 'message', MAX_MESSAGE_BYTES);
  if (message !== message.trim()) fail('operator_receipt_message_invalid');
  const chatDigest = canonicalDigest(
    { platform: 'whatsapp', routable_chat_id: chatId },
    'whip.operator_whatsapp_chat.v1',
  );
  if (chatDigest !== query.chat_digest) {
    fail('operator_receipt_chat_digest_mismatch');
  }
  const replyDigest = canonicalDigest(
    { origin_digest: query.origin_digest, quote_message_id: replyTo },
    'whip.operator_whatsapp_reply_anchor.v1',
  );
  if (replyDigest !== query.reply_anchor_digest) {
    fail('operator_receipt_reply_digest_mismatch');
  }
  if (sha256Text(message) !== query.body_digest) {
    fail('operator_receipt_body_digest_mismatch');
  }
  return { query, chatId, replyTo, message };
}

function bindingFields(value) {
  return {
    origin_ref: value.origin_ref,
    origin_digest: value.origin_digest,
    chat_digest: value.chat_digest,
    reply_anchor_digest: value.reply_anchor_digest,
    effect_key_digest: value.effect_key_digest,
    body_digest: value.body_digest,
  };
}

function bindingMatches(record, query) {
  return Object.entries(bindingFields(query))
    .every(([field, expected]) => record[field] === expected);
}

function recordPayload(query, status, messageId) {
  return {
    schema_version: RECORD_SCHEMA,
    status,
    ...bindingFields(query),
    message_id: messageId,
  };
}

function sealRecord(query, status, messageId) {
  const payload = recordPayload(query, status, messageId);
  return {
    ...payload,
    record_digest: canonicalDigest(payload, RECORD_SCHEMA),
  };
}

function validateRecord(value) {
  if (!exactFields(value, RECORD_FIELDS)
      || value.schema_version !== RECORD_SCHEMA
      || !INTERNAL_STATUSES.has(value.status)
      || typeof value.message_id !== 'string'
      || !MESSAGE_ID_RE.test(value.message_id)) {
    fail('operator_receipt_store_invalid');
  }
  validateQuery({
    schema_version: OPERATOR_RECEIPT_SCHEMA,
    contract_version: OPERATOR_DELIVERY_CONTRACT_VERSION,
    ...bindingFields(value),
  });
  const payload = recordPayload(value, value.status, value.message_id);
  if (value.record_digest !== canonicalDigest(payload, RECORD_SCHEMA)) {
    fail('operator_receipt_store_invalid');
  }
  return value;
}

function receiptResponse(query, status, messageId = null) {
  return {
    schema_version: OPERATOR_RECEIPT_SCHEMA,
    contract_version: OPERATOR_DELIVERY_CONTRACT_VERSION,
    status,
    ...bindingFields(query),
    message_id: messageId,
  };
}

function loadRecords(statePath, maxEntries) {
  if (!existsSync(statePath)) return new Map();
  let raw;
  try {
    raw = readFileSync(statePath);
  } catch {
    fail('operator_receipt_store_unreadable');
  }
  if (!raw.length || raw.length > MAX_STORE_BYTES) {
    fail('operator_receipt_store_invalid');
  }
  let state;
  try {
    state = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('operator_receipt_store_invalid');
  }
  if (!exactFields(state, ['schema_version', 'receipts'])
      || state.schema_version !== STORE_SCHEMA
      || !Array.isArray(state.receipts)
      || state.receipts.length > maxEntries) {
    fail('operator_receipt_store_invalid');
  }
  const records = new Map();
  for (const candidate of state.receipts) {
    const record = validateRecord(candidate);
    if (records.has(record.effect_key_digest)) {
      fail('operator_receipt_store_invalid');
    }
    records.set(record.effect_key_digest, record);
  }
  return records;
}

function persistRecords(sessionDir, statePath, records) {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const encoded = `${JSON.stringify({
    schema_version: STORE_SCHEMA,
    receipts: [...records.values()],
  })}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) {
    fail('operator_receipt_store_capacity');
  }
  const temporary = join(
    sessionDir,
    `.${STORE_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, encoded, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, statePath);
    chmodSync(statePath, 0o600);
    try {
      const directoryDescriptor = openSync(sessionDir, 'r');
      fsyncSync(directoryDescriptor);
      closeSync(directoryDescriptor);
    } catch {}
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error instanceof OperatorReceiptError) throw error;
    fail('operator_receipt_store_write_failed');
  }
}

export function createOperatorDeliveryStore(sessionDirectory, options = {}) {
  if (typeof sessionDirectory !== 'string' || !sessionDirectory) {
    fail('operator_receipt_session_invalid');
  }
  const maxEntries = options.maxEntries ?? STORE_LIMIT;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > STORE_LIMIT) {
    fail('operator_receipt_store_limit_invalid');
  }
  const sessionDir = resolve(sessionDirectory);
  const statePath = join(sessionDir, STORE_FILE);
  const records = loadRecords(statePath, maxEntries);

  function persist() {
    persistRecords(sessionDir, statePath, records);
  }

  function receipt(value) {
    const accepted = validateQuery(value);
    const record = records.get(accepted.effect_key_digest);
    if (!record) return receiptResponse(accepted, 'ABSENT');
    if (!bindingMatches(record, accepted) || record.status === 'CONFLICT') {
      return receiptResponse(accepted, 'CONFLICT');
    }
    if (record.status === 'EXACT') {
      return receiptResponse(accepted, 'EXACT', record.message_id);
    }
    return receiptResponse(accepted, 'UNKNOWN');
  }

  function evictSettledIfNeeded() {
    if (records.size < maxEntries) return;
    const candidate = [...records.values()].find((record) => record.status !== 'INVOKING');
    if (!candidate) fail('operator_receipt_store_capacity');
    records.delete(candidate.effect_key_digest);
  }

  function begin(value) {
    const accepted = validateSend(value);
    const current = receipt(accepted.query);
    if (current.status === 'EXACT') {
      return { action: 'REPLAY', messageId: current.message_id, receipt: current };
    }
    if (current.status === 'CONFLICT') {
      return { action: 'CONFLICT', messageId: null, receipt: current };
    }
    if (current.status === 'UNKNOWN') {
      return { action: 'AMBIGUOUS', messageId: null, receipt: current };
    }
    evictSettledIfNeeded();
    const messageId = operatorMessageId(accepted.query.effect_key_digest);
    records.set(
      accepted.query.effect_key_digest,
      sealRecord(accepted.query, 'INVOKING', messageId),
    );
    persist();
    return {
      action: 'SEND',
      messageId,
      receipt: receiptResponse(accepted.query, 'UNKNOWN'),
    };
  }

  function confirm(effectKeyDigest, messageId) {
    if (typeof effectKeyDigest !== 'string' || !SHA256_RE.test(effectKeyDigest)
        || typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
      fail('operator_receipt_confirmation_invalid');
    }
    const record = records.get(effectKeyDigest);
    if (!record) fail('operator_receipt_confirmation_missing');
    const expected = operatorMessageId(effectKeyDigest);
    const status = messageId === expected && record.message_id === expected
      ? 'EXACT'
      : 'CONFLICT';
    const updated = sealRecord(record, status, record.message_id);
    records.set(effectKeyDigest, updated);
    persist();
    return receiptResponse(
      record,
      status === 'EXACT' ? 'EXACT' : 'CONFLICT',
      status === 'EXACT' ? record.message_id : null,
    );
  }

  function confirmProviderEcho({ messageId, chatId, fromMe } = {}) {
    if (fromMe !== true
        || typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)
        || typeof chatId !== 'string' || !chatId || chatId.includes('\0')
        || Buffer.byteLength(chatId, 'utf8') > 1024) {
      return false;
    }
    const chatDigest = canonicalDigest(
      { platform: 'whatsapp', routable_chat_id: chatId },
      'whip.operator_whatsapp_chat.v1',
    );
    const matches = [...records.values()].filter(
      (record) => record.message_id === messageId
        && record.chat_digest === chatDigest
        && record.status === 'INVOKING',
    );
    if (matches.length !== 1) return false;
    confirm(matches[0].effect_key_digest, messageId);
    return true;
  }

  return { begin, confirm, confirmProviderEcho, receipt, statePath };
}

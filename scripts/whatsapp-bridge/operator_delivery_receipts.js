import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const OPERATOR_DELIVERY_CONTRACT_VERSION = 'v1';
export const OPERATOR_RECEIPT_SCHEMA = 'hermes.whatsapp_operator_receipt.v1';

const STORE_SCHEMA = 'hermes.whatsapp_operator_receipt_store.v1';
const RECORD_SCHEMA = 'hermes.whatsapp_operator_receipt_record.v1';
const STORE_FILE = 'operator-delivery-receipts.v1.json';
const ARCHIVE_DIRECTORY = 'operator-delivery-receipts.v1.archive';
const ECHO_ALIAS_DIRECTORY = 'operator-delivery-echo-aliases.v1';
const STORE_LIMIT = 512;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_RECORD_BYTES = 16 * 1024;
const MAX_ECHO_ALIAS_BYTES = 4 * 1024;
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
const ECHO_ALIAS_SCHEMA = 'hermes.whatsapp_operator_echo_alias.v1';
const ECHO_ALIAS_FIELDS = [
  'schema_version',
  'message_id',
  'effect_key_digest',
  'chat_digest',
  'alias_digest',
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

function loadRecords(sessionDirectory, statePath, maxEntries) {
  const raw = readPrivateFile(
    sessionDirectory,
    statePath,
    MAX_STORE_BYTES,
  );
  if (!raw) return new Map();
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
  ensurePrivateDirectory(dirname(sessionDir), sessionDir);
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
    fsyncDirectoryStrict(sessionDir);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error instanceof OperatorReceiptError) throw error;
    fail('operator_receipt_store_write_failed');
  }
}

function ownedByCurrentUser(stats) {
  return typeof process.getuid !== 'function' || stats.uid === process.getuid();
}

function existingPrivateDirectory(directory) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('operator_receipt_store_unreadable');
  }
  if (stats.isSymbolicLink()
      || !stats.isDirectory()
      || !ownedByCurrentUser(stats)
      || (stats.mode & 0o777) !== 0o700) {
    fail('operator_receipt_store_invalid');
  }
  return true;
}

function fsyncDirectoryStrict(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    fail('operator_receipt_store_write_failed');
  }
}

function ensurePrivateDirectory(parentDirectory, directory) {
  if (existingPrivateDirectory(directory)) return;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch {
    fail('operator_receipt_store_write_failed');
  }
  if (!existingPrivateDirectory(directory)) {
    fail('operator_receipt_store_invalid');
  }
  fsyncDirectoryStrict(parentDirectory);
}

function readPrivateFile(directory, filePath, maxBytes) {
  if (!existingPrivateDirectory(directory)) return null;
  let linkStats;
  try {
    linkStats = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('operator_receipt_store_unreadable');
  }
  if (linkStats.isSymbolicLink()
      || !linkStats.isFile()
      || !ownedByCurrentUser(linkStats)
      || (linkStats.mode & 0o777) !== 0o600
      || linkStats.nlink !== 1
      || linkStats.size < 1
      || linkStats.size > maxBytes) {
    fail('operator_receipt_store_invalid');
  }
  let descriptor;
  let raw;
  try {
    descriptor = openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stats = fstatSync(descriptor);
    if (!stats.isFile()
        || !ownedByCurrentUser(stats)
        || (stats.mode & 0o777) !== 0o600
        || stats.nlink !== 1
        || stats.size < 1
        || stats.size > maxBytes
        || stats.dev !== linkStats.dev
        || stats.ino !== linkStats.ino) {
      fail('operator_receipt_store_invalid');
    }
    raw = readFileSync(descriptor);
    const finalStats = fstatSync(descriptor);
    const current = lstatSync(filePath);
    if (!current.isFile()
        || current.isSymbolicLink()
        || !ownedByCurrentUser(current)
        || (current.mode & 0o777) !== 0o600
        || current.nlink !== 1
        || finalStats.nlink !== 1
        || finalStats.size !== raw.length
        || finalStats.dev !== stats.dev
        || finalStats.ino !== stats.ino
        || current.dev !== stats.dev
        || current.ino !== stats.ino) {
      fail('operator_receipt_store_invalid');
    }
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    if (error instanceof OperatorReceiptError) throw error;
    if (error?.code === 'ELOOP' || error?.code === 'ENOENT') {
      fail('operator_receipt_store_invalid');
    }
    fail('operator_receipt_store_unreadable');
  }
  if (!raw.length || raw.length > maxBytes) {
    fail('operator_receipt_store_invalid');
  }
  return raw;
}

function persistPrivateFile(
  parentDirectory,
  directory,
  targetPath,
  temporaryPrefix,
  encoded,
) {
  ensurePrivateDirectory(parentDirectory, directory);
  const temporary = join(
    directory,
    `.${temporaryPrefix}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, encoded, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, targetPath);
    unlinkSync(temporary);
    chmodSync(targetPath, 0o600);
    fsyncDirectoryStrict(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error instanceof OperatorReceiptError) throw error;
    fail('operator_receipt_store_write_failed');
  }
}

function archivePath(archiveDirectory, messageId) {
  if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
    fail('operator_receipt_store_invalid');
  }
  return join(archiveDirectory, `${messageId}.json`);
}

function loadArchivedRecord(archiveDirectory, messageId) {
  const recordPath = archivePath(archiveDirectory, messageId);
  const raw = readPrivateFile(
    archiveDirectory,
    recordPath,
    MAX_ARCHIVE_RECORD_BYTES,
  );
  if (!raw) return null;
  let candidate;
  try {
    candidate = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('operator_receipt_store_invalid');
  }
  const record = validateRecord(candidate);
  if (record.message_id !== messageId || record.status === 'INVOKING') {
    fail('operator_receipt_store_invalid');
  }
  return record;
}

function loadArchivedRecordForEffect(archiveDirectory, effectKeyDigest) {
  const record = loadArchivedRecord(
    archiveDirectory,
    operatorMessageId(effectKeyDigest),
  );
  if (record && record.effect_key_digest !== effectKeyDigest) {
    fail('operator_receipt_store_invalid');
  }
  return record;
}

function persistArchivedRecord(sessionDirectory, archiveDirectory, record) {
  if (record.status === 'INVOKING') {
    fail('operator_receipt_store_invalid');
  }
  const existing = loadArchivedRecord(archiveDirectory, record.message_id);
  if (existing) {
    if (existing.record_digest !== record.record_digest) {
      fail('operator_receipt_store_invalid');
    }
    fsyncDirectoryStrict(archiveDirectory);
    return;
  }

  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARCHIVE_RECORD_BYTES) {
    fail('operator_receipt_store_invalid');
  }
  const recordPath = archivePath(archiveDirectory, record.message_id);
  persistPrivateFile(
    sessionDirectory,
    archiveDirectory,
    recordPath,
    record.message_id,
    encoded,
  );
}

function echoAliasPayload(record, messageId) {
  return {
    schema_version: ECHO_ALIAS_SCHEMA,
    message_id: messageId,
    effect_key_digest: record.effect_key_digest,
    chat_digest: record.chat_digest,
  };
}

function sealEchoAlias(record, messageId) {
  const payload = echoAliasPayload(record, messageId);
  return {
    ...payload,
    alias_digest: canonicalDigest(payload, ECHO_ALIAS_SCHEMA),
  };
}

function validateEchoAlias(value) {
  if (!exactFields(value, ECHO_ALIAS_FIELDS)
      || value.schema_version !== ECHO_ALIAS_SCHEMA
      || typeof value.message_id !== 'string'
      || !MESSAGE_ID_RE.test(value.message_id)
      || typeof value.effect_key_digest !== 'string'
      || !SHA256_RE.test(value.effect_key_digest)
      || typeof value.chat_digest !== 'string'
      || !SHA256_RE.test(value.chat_digest)) {
    fail('operator_receipt_store_invalid');
  }
  const payload = {
    schema_version: value.schema_version,
    message_id: value.message_id,
    effect_key_digest: value.effect_key_digest,
    chat_digest: value.chat_digest,
  };
  if (value.alias_digest !== canonicalDigest(payload, ECHO_ALIAS_SCHEMA)) {
    fail('operator_receipt_store_invalid');
  }
  return value;
}

function echoAliasPath(echoAliasDirectory, messageId) {
  if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
    fail('operator_receipt_store_invalid');
  }
  return join(echoAliasDirectory, `${sha256Text(messageId)}.json`);
}

function loadEchoAlias(echoAliasDirectory, messageId) {
  const aliasPath = echoAliasPath(echoAliasDirectory, messageId);
  const raw = readPrivateFile(
    echoAliasDirectory,
    aliasPath,
    MAX_ECHO_ALIAS_BYTES,
  );
  if (!raw) return null;
  let candidate;
  try {
    candidate = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('operator_receipt_store_invalid');
  }
  const alias = validateEchoAlias(candidate);
  if (alias.message_id !== messageId) {
    fail('operator_receipt_store_invalid');
  }
  return alias;
}

function persistEchoAlias(
  sessionDirectory,
  echoAliasDirectory,
  record,
  messageId,
) {
  const alias = sealEchoAlias(record, messageId);
  const existing = loadEchoAlias(echoAliasDirectory, messageId);
  if (existing) {
    if (existing.alias_digest !== alias.alias_digest) {
      fail('operator_receipt_store_invalid');
    }
    fsyncDirectoryStrict(echoAliasDirectory);
    return;
  }
  const encoded = `${JSON.stringify(alias)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ECHO_ALIAS_BYTES) {
    fail('operator_receipt_store_invalid');
  }
  persistPrivateFile(
    sessionDirectory,
    echoAliasDirectory,
    echoAliasPath(echoAliasDirectory, messageId),
    sha256Text(messageId),
    encoded,
  );
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
  ensurePrivateDirectory(dirname(sessionDir), sessionDir);
  const statePath = join(sessionDir, STORE_FILE);
  const archiveDirectory = join(sessionDir, ARCHIVE_DIRECTORY);
  const echoAliasDirectory = join(sessionDir, ECHO_ALIAS_DIRECTORY);
  const records = loadRecords(sessionDir, statePath, maxEntries);

  function persist() {
    persistRecords(sessionDir, statePath, records);
  }

  function receipt(value) {
    const accepted = validateQuery(value);
    const record = records.get(accepted.effect_key_digest)
      ?? loadArchivedRecordForEffect(archiveDirectory, accepted.effect_key_digest);
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
    persistArchivedRecord(sessionDir, archiveDirectory, candidate);
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
    const alias = loadEchoAlias(echoAliasDirectory, messageId);
    if (alias && alias.effect_key_digest !== accepted.query.effect_key_digest) {
      fail('operator_receipt_store_invalid');
    }
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
    if (messageId !== expected) {
      const activeCollision = [...records.values()].find(
        (candidate) => candidate.effect_key_digest !== effectKeyDigest
          && candidate.message_id === messageId,
      );
      const archivedCollision = loadArchivedRecord(
        archiveDirectory,
        messageId,
      );
      if (activeCollision
          || (archivedCollision
            && archivedCollision.effect_key_digest !== effectKeyDigest)) {
        fail('operator_receipt_store_invalid');
      }
      persistEchoAlias(sessionDir, echoAliasDirectory, record, messageId);
    }
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
    const matches = new Map();
    for (const record of records.values()) {
      if (record.message_id === messageId && record.chat_digest === chatDigest) {
        matches.set(record.effect_key_digest, record);
      }
    }
    const archived = loadArchivedRecord(archiveDirectory, messageId);
    if (archived?.chat_digest === chatDigest) {
      matches.set(archived.effect_key_digest, archived);
    }
    const alias = loadEchoAlias(echoAliasDirectory, messageId);
    if (alias?.chat_digest === chatDigest) {
      const aliasedRecord = records.get(alias.effect_key_digest)
        ?? loadArchivedRecordForEffect(
          archiveDirectory,
          alias.effect_key_digest,
        );
      if (!aliasedRecord || aliasedRecord.chat_digest !== alias.chat_digest) {
        fail('operator_receipt_store_invalid');
      }
      matches.set(aliasedRecord.effect_key_digest, aliasedRecord);
    }
    if (matches.size > 1) return false;
    if (matches.size !== 1) return false;
    const [match] = matches.values();
    if (match.status === 'INVOKING') {
      confirm(match.effect_key_digest, messageId);
    }
    return true;
  }

  return { begin, confirm, confirmProviderEcho, receipt, statePath };
}

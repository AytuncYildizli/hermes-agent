import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  OperatorReceiptError,
  canonicalDigest,
  createOperatorDeliveryStore,
  operatorMessageId,
} from './operator_delivery_receipts.js';

const SHA = (character) => character.repeat(64);

function query(overrides = {}) {
  return {
    schema_version: 'hermes.whatsapp_operator_receipt.v1',
    contract_version: 'v1',
    origin_ref: `origin:${SHA('1')}`,
    origin_digest: SHA('1'),
    chat_digest: canonicalDigest(
      { platform: 'whatsapp', routable_chat_id: 'owner-chat-private' },
      'whip.operator_whatsapp_chat.v1',
    ),
    reply_anchor_digest: canonicalDigest(
      { origin_digest: SHA('1'), quote_message_id: 'wamid.original.private' },
      'whip.operator_whatsapp_reply_anchor.v1',
    ),
    effect_key_digest: SHA('4'),
    body_digest: SHA('5'),
    ...overrides,
  };
}

function sendRequest(overrides = {}) {
  return {
    ...query(),
    chat_id: 'owner-chat-private',
    reply_to: 'wamid.original.private',
    message: 'Governor verified production delivery.',
    ...overrides,
  };
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  try {
    await run(directory, createOperatorDeliveryStore(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('receipt lifecycle is durable, idempotent, and contains no raw route or body', async () => {
  await withStore(async (directory, store) => {
    const request = sendRequest({
      body_digest: createHash('sha256')
        .update('Governor verified production delivery.', 'utf8')
        .digest('hex'),
    });
    const prepared = store.begin(request);

    assert.equal(prepared.action, 'SEND');
    assert.equal(prepared.messageId, operatorMessageId(request.effect_key_digest));
    assert.equal(store.receipt(query({ body_digest: request.body_digest })).status, 'UNKNOWN');

    const exact = store.confirm(request.effect_key_digest, prepared.messageId);
    assert.equal(exact.status, 'EXACT');
    assert.equal(exact.message_id, prepared.messageId);

    const replay = store.begin(request);
    assert.equal(replay.action, 'REPLAY');
    assert.equal(replay.receipt.status, 'EXACT');

    const reloaded = createOperatorDeliveryStore(directory);
    assert.equal(
      reloaded.receipt(query({ body_digest: request.body_digest })).message_id,
      prepared.messageId,
    );
    const persisted = readFileSync(
      join(directory, 'operator-delivery-receipts.v1.json'),
      'utf8',
    );
    assert.equal(
      statSync(join(directory, 'operator-delivery-receipts.v1.json')).mode & 0o777,
      0o600,
    );
    assert.equal(persisted.includes(request.chat_id), false);
    assert.equal(persisted.includes(request.reply_to), false);
    assert.equal(persisted.includes(request.message), false);
  });
});

test('missing, conflicting, and crash-recovered receipts remain explicit', async () => {
  await withStore(async (directory, store) => {
    const message = 'Governor verified production delivery.';
    const bodyDigest = createHash('sha256').update(message, 'utf8').digest('hex');
    const request = sendRequest({ body_digest: bodyDigest });

    assert.equal(store.receipt(query({ body_digest: bodyDigest })).status, 'ABSENT');
    const prepared = store.begin(request);
    const substitutedMessage = 'Substituted production delivery.';
    assert.equal(
      store.begin({
        ...request,
        message: substitutedMessage,
        body_digest: createHash('sha256')
          .update(substitutedMessage, 'utf8')
          .digest('hex'),
      }).action,
      'CONFLICT',
    );

    const reloaded = createOperatorDeliveryStore(directory);
    assert.equal(reloaded.confirmProviderEcho({
      messageId: prepared.messageId,
      chatId: request.chat_id,
      fromMe: false,
    }), false);
    assert.equal(reloaded.confirmProviderEcho({
      messageId: prepared.messageId,
      chatId: 'substituted-chat',
      fromMe: true,
    }), false);
    assert.equal(reloaded.confirmProviderEcho({
      messageId: prepared.messageId,
      chatId: request.chat_id,
      fromMe: true,
    }), true);
    assert.equal(reloaded.receipt(query({ body_digest: bodyDigest })).status, 'EXACT');
  });
});

test('raw-to-digest substitutions and malformed stores fail closed', async () => {
  await withStore(async (directory, store) => {
    assert.throws(
      () => store.begin(sendRequest()),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_body_digest_mismatch',
    );
    const message = 'Governor verified production delivery.';
    const bodyDigest = createHash('sha256').update(message, 'utf8').digest('hex');
    assert.throws(
      () => store.begin(sendRequest({ body_digest: bodyDigest, chat_id: 'attacker-chat' })),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_chat_digest_mismatch',
    );

    const statePath = join(directory, 'operator-delivery-receipts.v1.json');
    await writeFile(
      statePath,
      '{"schema_version":"wrong","receipts":[]}',
      'utf8',
    );
    assert.throws(
      () => createOperatorDeliveryStore(directory),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_store_invalid',
    );
  });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalDigest,
  createOperatorDeliveryStore,
} from './operator_delivery_receipts.js';
import {
  createBoundedMessageStore,
  createOperatorMessageSender,
  isGovernedOperatorEcho,
} from './operator_delivery_transport.js';

test('operator sender binds deterministic id and native reply anchor', async () => {
  const messageStore = createBoundedMessageStore(2);
  const quoted = {
    key: { id: 'wamid.original', remoteJid: 'owner-chat', fromMe: true },
    message: { conversation: 'original task' },
  };
  messageStore.remember(quoted);
  const calls = [];
  const sender = createOperatorMessageSender({
    messageStore,
    sendWithTimeout: async (...args) => {
      calls.push(args);
      return {
        key: { id: args[2].messageId, remoteJid: args[0], fromMe: true },
        message: args[1],
      };
    },
    trackSentMessageId: () => {},
  });

  const sent = await sender({
    chatId: 'owner-chat',
    replyTo: 'wamid.original',
    message: 'Governor final',
    messageId: '3EB0ABCDEF123456789012',
  });

  assert.equal(sent.key.id, '3EB0ABCDEF123456789012');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'owner-chat',
    { text: 'Governor final' },
    { messageId: '3EB0ABCDEF123456789012', quoted },
  ]);
});

test('operator sender keeps the reply id after a bridge restart', async () => {
  const calls = [];
  const sender = createOperatorMessageSender({
    messageStore: createBoundedMessageStore(2),
    sendWithTimeout: async (...args) => {
      calls.push(args);
      return { key: { id: args[2].messageId } };
    },
    trackSentMessageId: () => {},
  });

  await sender({
    chatId: 'owner-chat',
    replyTo: 'wamid.original',
    message: 'Governor final',
    messageId: '3EB0ABCDEF123456789012',
  });

  assert.equal(calls[0][2].quoted.key.id, 'wamid.original');
  assert.equal(calls[0][2].quoted.key.remoteJid, 'owner-chat');
  assert.equal(calls[0][2].quoted.key.fromMe, false);
  assert.deepEqual(calls[0][2].quoted.message, { conversation: '' });
});

test('operator sender reserves its deterministic correlation before transport', async () => {
  const events = [];
  const sender = createOperatorMessageSender({
    messageStore: createBoundedMessageStore(2),
    sendWithTimeout: async (...args) => {
      events.push('send');
      assert.deepEqual(events, ['track:3EB0ABCDEF123456789012', 'send']);
      return { key: { id: args[2].messageId, remoteJid: args[0], fromMe: true } };
    },
    trackSentMessageId: (sent) => events.push(`track:${sent.key.id}`),
  });

  await sender({
    chatId: 'owner-chat',
    replyTo: 'wamid.original',
    message: 'Governor final',
    messageId: '3EB0ABCDEF123456789012',
  });

  assert.deepEqual(events, [
    'track:3EB0ABCDEF123456789012',
    'send',
    'track:3EB0ABCDEF123456789012',
  ]);
});

test('governed self-chat echo classification is an explicit skip decision', () => {
  const observed = [];
  const store = {
    confirmProviderEcho(value) {
      observed.push(value);
      return true;
    },
  };
  const message = {
    key: {
      id: '3EB0ABCDEF123456789012',
      remoteJid: 'owner-chat',
      fromMe: true,
    },
    message: { conversation: 'Governor final' },
  };

  assert.equal(isGovernedOperatorEcho(store, message), true);
  assert.deepEqual(observed, [{
    messageId: message.key.id,
    chatId: message.key.remoteJid,
    fromMe: true,
  }]);
});

test('append after restart cannot enqueue a governed provider-conflict echo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-transport-'));
  try {
    const sha = (character) => character.repeat(64);
    const message = 'Governed provider-conflict final.';
    const request = {
      schema_version: 'hermes.whatsapp_operator_receipt.v1',
      contract_version: 'v1',
      origin_ref: `origin:${sha('1')}`,
      origin_digest: sha('1'),
      chat_digest: canonicalDigest(
        { platform: 'whatsapp', routable_chat_id: 'owner-chat-private' },
        'whip.operator_whatsapp_chat.v1',
      ),
      reply_anchor_digest: canonicalDigest(
        { origin_digest: sha('1'), quote_message_id: 'wamid.original.private' },
        'whip.operator_whatsapp_reply_anchor.v1',
      ),
      effect_key_digest: sha('4'),
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      chat_id: 'owner-chat-private',
      reply_to: 'wamid.original.private',
      message,
    };
    const providerMessageId = '3EB0PROVIDERCONFLICT1';
    const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    store.begin(request);
    store.confirm(request.effect_key_digest, providerMessageId);
    const nextMessage = 'Archive conflict receipt.';
    store.begin({
      ...request,
      effect_key_digest: sha('6'),
      message: nextMessage,
      body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
    });

    const restarted = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    const append = {
      type: 'append',
      message: {
        key: {
          id: providerMessageId,
          remoteJid: request.chat_id,
          fromMe: true,
        },
        message: { conversation: message },
      },
    };
    const messageQueue = [];
    if (!isGovernedOperatorEcho(restarted, append.message)) {
      messageQueue.push(append.message);
    }

    assert.equal(append.type, 'append');
    assert.deepEqual(messageQueue, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded message store evicts oldest messages', () => {
  const store = createBoundedMessageStore(2);
  store.remember({ key: { id: 'first' }, message: { conversation: '1' } });
  store.remember({ key: { id: 'second' }, message: { conversation: '2' } });
  store.remember({ key: { id: 'third' }, message: { conversation: '3' } });

  assert.equal(store.get('first'), null);
  assert.equal(store.get('second').key.id, 'second');
  assert.equal(store.get('third').key.id, 'third');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBoundedMessageStore,
  createOperatorMessageSender,
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

test('bounded message store evicts oldest messages', () => {
  const store = createBoundedMessageStore(2);
  store.remember({ key: { id: 'first' }, message: { conversation: '1' } });
  store.remember({ key: { id: 'second' }, message: { conversation: '2' } });
  store.remember({ key: { id: 'third' }, message: { conversation: '3' } });

  assert.equal(store.get('first'), null);
  assert.equal(store.get('second').key.id, 'second');
  assert.equal(store.get('third').key.id, 'third');
});

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
import { registerOperatorDeliveryRoutes } from './operator_delivery_routes.js';

const SHA = (character) => character.repeat(64);
const MESSAGE = 'Governor verified production delivery.';

function sendRequest() {
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
    body_digest: createHash('sha256').update(MESSAGE, 'utf8').digest('hex'),
    chat_id: 'owner-chat-private',
    reply_to: 'wamid.original.private',
    message: MESSAGE,
  };
}

function queryFrom(request) {
  const { chat_id, reply_to, message, ...query } = request;
  void chat_id;
  void reply_to;
  void message;
  return query;
}

function fakeApp() {
  const routes = new Map();
  return {
    post(path, handler) { routes.set(path, handler); },
    route(path) { return routes.get(path); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function invoke(handler, body) {
  const response = fakeResponse();
  await handler({ body }, response);
  return response;
}

test('operator routes send exactly once and replay the durable receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-routes-'));
  try {
    const app = fakeApp();
    const store = createOperatorDeliveryStore(directory);
    const sends = [];
    registerOperatorDeliveryRoutes({
      app,
      store,
      isConnected: () => true,
      sendOperatorMessage: async (request) => {
        sends.push(request);
        return { key: { id: request.messageId } };
      },
    });
    const request = sendRequest();

    const first = await invoke(app.route('/operator-send'), request);
    const second = await invoke(app.route('/operator-send'), request);
    const receipt = await invoke(
      app.route('/operator-receipt'),
      queryFrom(request),
    );

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(receipt.statusCode, 200);
    assert.equal(first.payload.status, 'EXACT');
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(receipt.payload, first.payload);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].chatId, request.chat_id);
    assert.equal(sends[0].replyTo, request.reply_to);
    assert.equal(sends[0].message, request.message);
    assert.equal(sends[0].messageId, first.payload.message_id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('disconnects, ambiguous sends, and provider id conflicts fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-routes-'));
  try {
    const request = sendRequest();
    const app = fakeApp();
    const store = createOperatorDeliveryStore(directory);
    let connected = false;
    let sends = 0;
    registerOperatorDeliveryRoutes({
      app,
      store,
      isConnected: () => connected,
      sendOperatorMessage: async () => {
        sends += 1;
        return { key: { id: '3EB0WRONGPROVIDERID12' } };
      },
    });

    const disconnected = await invoke(app.route('/operator-send'), request);
    assert.equal(disconnected.statusCode, 503);
    assert.equal(store.receipt(queryFrom(request)).status, 'ABSENT');

    connected = true;
    const conflict = await invoke(app.route('/operator-send'), request);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.payload.status, 'CONFLICT');
    assert.equal(sends, 1);

    const otherDirectory = await mkdtemp(join(tmpdir(), 'hermes-operator-routes-'));
    try {
      const otherApp = fakeApp();
      const otherStore = createOperatorDeliveryStore(otherDirectory);
      otherStore.begin(request);
      registerOperatorDeliveryRoutes({
        app: otherApp,
        store: otherStore,
        isConnected: () => true,
        sendOperatorMessage: async () => assert.fail('ambiguous send must not retry'),
      });
      const ambiguous = await invoke(otherApp.route('/operator-send'), request);
      assert.equal(ambiguous.statusCode, 409);
      assert.equal(ambiguous.payload.status, 'UNKNOWN');
    } finally {
      await rm(otherDirectory, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('route reserves durable authority before an early substituted-id echo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-routes-'));
  try {
    const request = sendRequest();
    const app = fakeApp();
    const store = createOperatorDeliveryStore(directory);
    const providerMessageId = '3EB0EARLYROUTEECHO1';
    registerOperatorDeliveryRoutes({
      app,
      store,
      isConnected: () => true,
      sendOperatorMessage: async () => {
        assert.equal(store.receipt(queryFrom(request)).status, 'UNKNOWN');
        assert.equal(store.confirmProviderEcho({
          messageId: providerMessageId,
          chatId: request.chat_id,
          fromMe: true,
          body: request.message,
        }), false);
        return {
          key: {
            id: providerMessageId,
            remoteJid: request.chat_id,
            fromMe: true,
          },
        };
      },
    });

    const response = await invoke(app.route('/operator-send'), request);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.status, 'CONFLICT');

    const restarted = createOperatorDeliveryStore(directory);
    assert.equal(restarted.confirmProviderEcho({
      messageId: providerMessageId,
      chatId: request.chat_id,
      fromMe: true,
      body: request.message,
    }), true);
    assert.equal(restarted.receipt(queryFrom(request)).status, 'CONFLICT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

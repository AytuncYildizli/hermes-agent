import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

import {
  BRIDGE_CAPABILITY_FILE,
  BridgeAuthError,
  createBridgeAuthMiddleware,
  createLoopbackHostMiddleware,
  loadOrCreateBridgeCapability,
} from './bridge_auth.js';

test('bridge capability is durable private and exposes only an opaque id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-bridge-auth-'));
  try {
    const first = loadOrCreateBridgeCapability(directory);
    const second = loadOrCreateBridgeCapability(directory);
    const capabilityPath = join(directory, BRIDGE_CAPABILITY_FILE);
    const metadata = await stat(capabilityPath);
    const persisted = (await readFile(capabilityPath, 'utf8')).trim();

    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.capabilityId, /^[0-9a-f]{64}$/);
    assert.notEqual(first.capabilityId, first.token);
    assert.equal(first.token, persisted);
    assert.deepEqual(second, first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsafe or linked capability files fail startup closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-bridge-auth-'));
  const outside = await mkdtemp(join(tmpdir(), 'hermes-bridge-auth-outside-'));
  try {
    const capabilityPath = join(directory, BRIDGE_CAPABILITY_FILE);
    await writeFile(capabilityPath, 'a'.repeat(43) + '\n', { mode: 0o600 });
    await chmod(capabilityPath, 0o644);
    assert.throws(
      () => loadOrCreateBridgeCapability(directory),
      (error) => error instanceof BridgeAuthError
        && error.code === 'bridge_auth_capability_invalid',
    );

    await rm(capabilityPath);
    const outsidePath = join(outside, 'token');
    await writeFile(outsidePath, 'b'.repeat(43) + '\n', { mode: 0o600 });
    await symlink(outsidePath, capabilityPath);
    assert.throws(
      () => loadOrCreateBridgeCapability(directory),
      (error) => error instanceof BridgeAuthError
        && error.code === 'bridge_auth_capability_invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('one middleware protects health polling sends and receipt routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-bridge-auth-'));
  let server;
  try {
    const capability = loadOrCreateBridgeCapability(directory);
    const app = express();
    app.use(createLoopbackHostMiddleware());
    app.use(createBridgeAuthMiddleware(capability));
    app.use(express.json());
    for (const route of ['/health', '/messages', '/send', '/operator-receipt']) {
      const method = route === '/health' || route === '/messages' ? 'get' : 'post';
      app[method](route, (_req, res) => res.json({ ok: true }));
    }
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    let invalidHostStatus = null;
    let invalidHostNext = false;
    createLoopbackHostMiddleware()(
      { headers: { host: 'evil.example' } },
      {
        status(code) {
          invalidHostStatus = code;
          return this;
        },
        json() { return this; },
      },
      () => { invalidHostNext = true; },
    );
    assert.equal(invalidHostStatus, 400);
    assert.equal(invalidHostNext, false);

    for (const [path, method] of [
      ['/health', 'GET'],
      ['/messages', 'GET'],
      ['/send', 'POST'],
      ['/operator-receipt', 'POST'],
    ]) {
      const missing = await fetch(`${base}${path}`, { method });
      const wrong = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: 'Bearer wrong' },
      });
      const correct = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${capability.token}` },
      });
      assert.equal(missing.status, 401, path);
      assert.equal(wrong.status, 401, path);
      assert.equal(correct.status, 200, path);
      assert.deepEqual(await correct.json(), { ok: true });
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

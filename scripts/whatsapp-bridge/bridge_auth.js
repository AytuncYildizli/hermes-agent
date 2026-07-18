import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BRIDGE_CAPABILITY_FILE = 'bridge-auth-token.v1';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_FILE_BYTES = 64;

export class BridgeAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeAuthError';
    this.code = code;
  }
}

function fail(code) {
  throw new BridgeAuthError(code);
}

function ownedByCurrentUser(metadata) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid();
}

function privateDirectory(directory) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    fail('bridge_auth_directory_invalid');
  }
  if (metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || !ownedByCurrentUser(metadata)
      || (metadata.mode & 0o777) !== 0o700) {
    fail('bridge_auth_directory_invalid');
  }
  return true;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    fail('bridge_auth_capability_write_failed');
  }
}

function ensurePrivateDirectory(directory) {
  if (privateDirectory(directory)) return;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch {
    fail('bridge_auth_capability_write_failed');
  }
  if (!privateDirectory(directory)) fail('bridge_auth_directory_invalid');
  fsyncDirectory(dirname(directory));
}

function validateFileMetadata(metadata) {
  if (metadata.isSymbolicLink()
      || !metadata.isFile()
      || !ownedByCurrentUser(metadata)
      || (metadata.mode & 0o777) !== 0o600
      || metadata.nlink !== 1
      || metadata.size < 1
      || metadata.size > MAX_TOKEN_FILE_BYTES) {
    fail('bridge_auth_capability_invalid');
  }
}

function readPrivateCapability(directory, capabilityPath) {
  if (!privateDirectory(directory)) fail('bridge_auth_directory_invalid');
  let visible;
  try {
    visible = lstatSync(capabilityPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('bridge_auth_capability_invalid');
  }
  validateFileMetadata(visible);
  let descriptor;
  try {
    descriptor = openSync(
      capabilityPath,
      fsConstants.O_RDONLY
        | (fsConstants.O_CLOEXEC || 0)
        | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    validateFileMetadata(opened);
    if (opened.dev !== visible.dev || opened.ino !== visible.ino) {
      fail('bridge_auth_capability_invalid');
    }
    const payload = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    let size = 0;
    while (size < payload.length) {
      const count = readSync(
        descriptor,
        payload,
        size,
        payload.length - size,
        null,
      );
      if (count === 0) break;
      size += count;
    }
    const final = fstatSync(descriptor);
    if (size !== opened.size || final.dev !== opened.dev || final.ino !== opened.ino) {
      fail('bridge_auth_capability_invalid');
    }
    const encoded = payload.subarray(0, size).toString('utf8');
    const token = encoded.endsWith('\n') ? encoded.slice(0, -1) : '';
    if (!TOKEN_RE.test(token) || encoded !== `${token}\n`) {
      fail('bridge_auth_capability_invalid');
    }
    return token;
  } catch (error) {
    if (error instanceof BridgeAuthError) throw error;
    fail('bridge_auth_capability_invalid');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function createPrivateCapability(directory, capabilityPath) {
  const token = randomBytes(32).toString('base64url');
  const payload = Buffer.from(`${token}\n`, 'ascii');
  let descriptor;
  try {
    descriptor = openSync(
      capabilityPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_CLOEXEC || 0)
        | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < payload.length) {
      const count = writeSync(
        descriptor,
        payload,
        offset,
        payload.length - offset,
      );
      if (count <= 0) fail('bridge_auth_capability_write_failed');
      offset += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    if (error?.code === 'EEXIST') {
      return readPrivateCapability(directory, capabilityPath);
    }
    fail('bridge_auth_capability_write_failed');
  }
  return readPrivateCapability(directory, capabilityPath);
}

function capabilityId(token) {
  return createHash('sha256')
    .update('hermes.whatsapp.bridge.capability.v1\0', 'ascii')
    .update(token, 'ascii')
    .digest('hex');
}

export function loadOrCreateBridgeCapability(sessionDirectory) {
  if (typeof sessionDirectory !== 'string' || !sessionDirectory) {
    fail('bridge_auth_directory_invalid');
  }
  const directory = resolve(sessionDirectory);
  ensurePrivateDirectory(directory);
  const capabilityPath = join(directory, BRIDGE_CAPABILITY_FILE);
  const token = readPrivateCapability(directory, capabilityPath)
    || createPrivateCapability(directory, capabilityPath);
  if (!token) fail('bridge_auth_capability_invalid');
  return Object.freeze({
    token,
    capabilityId: capabilityId(token),
    path: capabilityPath,
  });
}

function authorizationMatches(presented, expected) {
  const presentedDigest = createHash('sha256')
    .update(typeof presented === 'string' ? presented : '', 'utf8')
    .digest();
  const expectedDigest = createHash('sha256').update(expected, 'ascii').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

export function createBridgeAuthMiddleware(capability) {
  if (!capability
      || typeof capability.token !== 'string'
      || !TOKEN_RE.test(capability.token)) {
    fail('bridge_auth_capability_invalid');
  }
  const expected = `Bearer ${capability.token}`;
  return function bridgeBearerAuth(req, res, next) {
    const presented = req.headers?.authorization;
    if (!authorizationMatches(presented, expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function createLoopbackHostMiddleware() {
  return function loopbackHost(req, res, next) {
    const raw = typeof req.headers?.host === 'string'
      ? req.headers.host.trim()
      : '';
    if (!raw) return res.status(400).json({ error: 'Missing Host header' });
    const hostOnly = (raw.includes(':')
      ? raw.substring(0, raw.lastIndexOf(':'))
      : raw
    ).replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(hostOnly)) {
      return res.status(400).json({
        error: 'Invalid Host header. Bridge accepts loopback hosts only.',
      });
    }
    return next();
  };
}

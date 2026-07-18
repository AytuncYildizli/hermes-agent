import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('bridge fails startup closed when governed receipt authority is unsafe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-bridge-startup-'));
  try {
    await writeFile(
      join(directory, 'operator-delivery-receipts.v1.json'),
      '{"schema_version":"hermes.whatsapp_operator_receipt_store.v1","receipts":[]}\n',
      { mode: 0o644 },
    );
    const result = spawnSync(
      process.execPath,
      ['bridge.js', '--session', directory, '--port', '0'],
      {
        cwd: new URL('.', import.meta.url),
        encoding: 'utf8',
        timeout: 5000,
      },
    );

    assert.notEqual(result.error?.code, 'ETIMEDOUT');
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /operator_receipt_store_invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

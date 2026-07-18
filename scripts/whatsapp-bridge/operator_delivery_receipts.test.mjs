import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

function assertStoreInvalid(run) {
  assert.throws(
    run,
    (error) => error instanceof OperatorReceiptError
      && error.code === 'operator_receipt_store_invalid',
  );
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

test('settled receipt authority survives capacity rollover and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  try {
    const store = createOperatorDeliveryStore(directory, { maxEntries: 2 });
    const requestFor = (effectCharacter, message) => sendRequest({
      effect_key_digest: SHA(effectCharacter),
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const exactRequest = requestFor('4', 'First governed final.');
    const conflictRequest = requestFor('6', 'Second governed final.');
    const thirdRequest = requestFor('7', 'Third governed final.');
    const fourthRequest = requestFor('8', 'Fourth governed final.');

    const exactPrepared = store.begin(exactRequest);
    store.confirm(exactRequest.effect_key_digest, exactPrepared.messageId);
    store.begin(conflictRequest);
    store.confirm(conflictRequest.effect_key_digest, '3EB0PROVIDERCONFLICT1');

    const thirdPrepared = store.begin(thirdRequest);
    store.confirm(thirdRequest.effect_key_digest, thirdPrepared.messageId);
    const fourthPrepared = store.begin(fourthRequest);
    store.confirm(fourthRequest.effect_key_digest, fourthPrepared.messageId);

    const archiveDirectory = join(
      directory,
      'operator-delivery-receipts.v1.archive',
    );
    assert.equal(existsSync(archiveDirectory), true);
    assert.equal(statSync(archiveDirectory).mode & 0o777, 0o700);
    const archiveFiles = readdirSync(archiveDirectory).sort();
    assert.equal(archiveFiles.length, 2);
    for (const archiveFile of archiveFiles) {
      const archivePath = join(archiveDirectory, archiveFile);
      const archived = readFileSync(archivePath, 'utf8');
      assert.equal(statSync(archivePath).mode & 0o777, 0o600);
      for (const request of [exactRequest, conflictRequest]) {
        assert.equal(archived.includes(request.chat_id), false);
        assert.equal(archived.includes(request.reply_to), false);
        assert.equal(archived.includes(request.message), false);
      }
    }

    const reloaded = createOperatorDeliveryStore(directory, { maxEntries: 2 });
    const exactQuery = query({
      effect_key_digest: exactRequest.effect_key_digest,
      body_digest: exactRequest.body_digest,
    });
    const conflictQuery = query({
      effect_key_digest: conflictRequest.effect_key_digest,
      body_digest: conflictRequest.body_digest,
    });

    assert.equal(reloaded.receipt(exactQuery).status, 'EXACT');
    assert.equal(reloaded.begin(exactRequest).action, 'REPLAY');
    assert.equal(reloaded.receipt(conflictQuery).status, 'CONFLICT');
    assert.equal(reloaded.begin(conflictRequest).action, 'CONFLICT');
    assert.equal(reloaded.confirmProviderEcho({
      messageId: exactPrepared.messageId,
      chatId: exactRequest.chat_id,
      fromMe: true,
    }), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupted archived authority fails closed instead of becoming absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  try {
    const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    const message = 'Archived governed final.';
    const request = sendRequest({
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const prepared = store.begin(request);
    store.confirm(request.effect_key_digest, prepared.messageId);

    const nextMessage = 'Capacity rollover trigger.';
    store.begin(sendRequest({
      effect_key_digest: SHA('6'),
      message: nextMessage,
      body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
    }));

    const archiveDirectory = join(
      directory,
      'operator-delivery-receipts.v1.archive',
    );
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(join(archiveDirectory, `${prepared.messageId}.json`), '{}\n', 'utf8');

    const reloaded = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    assert.throws(
      () => reloaded.receipt(query({ body_digest: request.body_digest })),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_store_invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider conflict echo correlation survives rollover and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  try {
    const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    const message = 'Conflict governed final.';
    const request = sendRequest({
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const providerMessageId = '3EB0PROVIDERCONFLICT1';
    store.begin(request);
    store.confirm(request.effect_key_digest, providerMessageId);
    const echoAliasDirectory = join(
      directory,
      'operator-delivery-echo-aliases.v1',
    );
    assert.equal(statSync(echoAliasDirectory).mode & 0o777, 0o700);
    const [aliasFile] = readdirSync(echoAliasDirectory);
    const aliasPath = join(echoAliasDirectory, aliasFile);
    const alias = readFileSync(aliasPath, 'utf8');
    assert.equal(statSync(aliasPath).mode & 0o777, 0o600);
    assert.equal(alias.includes(request.chat_id), false);
    assert.equal(alias.includes(request.reply_to), false);
    assert.equal(alias.includes(request.message), false);

    const nextMessage = 'Archive the conflict.';
    store.begin(sendRequest({
      effect_key_digest: SHA('6'),
      message: nextMessage,
      body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
    }));

    const reloaded = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    assert.equal(reloaded.confirmProviderEcho({
      messageId: providerMessageId,
      chatId: request.chat_id,
      fromMe: true,
    }), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('body-only provider echo never claims or suppresses receipt authority', async () => {
  await withStore(async (directory, store) => {
    const message = 'Provider returned a substituted id.';
    const request = sendRequest({
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const providerMessageId = '3EB0EARLYPROVIDERECHO1';
    store.begin(request);

    assert.equal(store.confirmProviderEcho({
      messageId: providerMessageId,
      chatId: request.chat_id,
      fromMe: true,
      body: message,
    }), false);
    assert.equal(
      store.receipt(query({ body_digest: request.body_digest })).status,
      'UNKNOWN',
    );

    const reloaded = createOperatorDeliveryStore(directory);
    assert.equal(reloaded.confirmProviderEcho({
      messageId: providerMessageId,
      chatId: request.chat_id,
      fromMe: true,
      body: message,
    }), false);
  });
});

test('ambiguous governed body echoes remain ordinary messages', async () => {
  await withStore(async (_directory, store) => {
    const message = 'Identical governed blocker final.';
    const first = sendRequest({
      effect_key_digest: SHA('4'),
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const second = sendRequest({
      effect_key_digest: SHA('6'),
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    store.begin(first);
    store.begin(second);

    assert.equal(store.confirmProviderEcho({
      messageId: '3EB0AMBIGUOUSPROVIDER1',
      chatId: first.chat_id,
      fromMe: true,
      body: message,
    }), false);
    assert.equal(store.receipt(query({
      effect_key_digest: first.effect_key_digest,
      body_digest: first.body_digest,
    })).status, 'UNKNOWN');
    assert.equal(store.receipt(query({
      effect_key_digest: second.effect_key_digest,
      body_digest: second.body_digest,
    })).status, 'UNKNOWN');
  });
});

test('active receipt authority rejects unsafe mode, links, and session permissions', async (t) => {
  await t.test('active file mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    try {
      const store = createOperatorDeliveryStore(directory);
      const message = 'Persist active receipt state.';
      store.begin(sendRequest({
        message,
        body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      }));
      await chmod(join(directory, 'operator-delivery-receipts.v1.json'), 0o644);
      assertStoreInvalid(() => createOperatorDeliveryStore(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('active file symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    const external = await mkdtemp(join(tmpdir(), 'hermes-operator-external-'));
    try {
      const store = createOperatorDeliveryStore(directory);
      const message = 'Persist symlink target state.';
      store.begin(sendRequest({
        message,
        body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      }));
      const statePath = join(directory, 'operator-delivery-receipts.v1.json');
      const externalPath = join(external, 'receipt-state.json');
      await rename(statePath, externalPath);
      await symlink(externalPath, statePath, 'file');
      assertStoreInvalid(() => createOperatorDeliveryStore(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  await t.test('active file hard link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    try {
      const store = createOperatorDeliveryStore(directory);
      const message = 'Persist hard-linked receipt authority.';
      store.begin(sendRequest({
        message,
        body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      }));
      const statePath = join(directory, 'operator-delivery-receipts.v1.json');
      await link(statePath, join(directory, 'receipt-authority-hardlink.json'));
      assertStoreInvalid(() => createOperatorDeliveryStore(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('session directory mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    try {
      await chmod(directory, 0o755);
      assertStoreInvalid(() => createOperatorDeliveryStore(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('provider aliases cannot collide with deterministic receipt authority', async (t) => {
  await t.test('existing deterministic id', async () => {
    await withStore(async (_directory, store) => {
      const firstMessage = 'First governed delivery.';
      const secondMessage = 'Second governed delivery.';
      const first = sendRequest({
        effect_key_digest: SHA('4'),
        message: firstMessage,
        body_digest: createHash('sha256').update(firstMessage, 'utf8').digest('hex'),
      });
      const second = sendRequest({
        effect_key_digest: SHA('6'),
        message: secondMessage,
        body_digest: createHash('sha256').update(secondMessage, 'utf8').digest('hex'),
      });
      store.begin(first);
      const secondPrepared = store.begin(second);

      assertStoreInvalid(
        () => store.confirm(first.effect_key_digest, secondPrepared.messageId),
      );
    });
  });

  await t.test('future deterministic id', async () => {
    await withStore(async (_directory, store) => {
      const firstMessage = 'Alias arrives before the second effect.';
      const secondMessage = 'Future deterministic collision.';
      const first = sendRequest({
        effect_key_digest: SHA('4'),
        message: firstMessage,
        body_digest: createHash('sha256').update(firstMessage, 'utf8').digest('hex'),
      });
      const second = sendRequest({
        effect_key_digest: SHA('6'),
        message: secondMessage,
        body_digest: createHash('sha256').update(secondMessage, 'utf8').digest('hex'),
      });
      store.begin(first);
      store.confirm(first.effect_key_digest, operatorMessageId(second.effect_key_digest));

      assertStoreInvalid(() => store.begin(second));
    });
  });

  await t.test('legacy alias and deterministic candidates remain ambiguous', async () => {
    await withStore(async (directory, store) => {
      const firstMessage = 'Previously settled governed delivery.';
      const secondMessage = 'Current invoking governed delivery.';
      const first = sendRequest({
        effect_key_digest: SHA('4'),
        message: firstMessage,
        body_digest: createHash('sha256').update(firstMessage, 'utf8').digest('hex'),
      });
      const second = sendRequest({
        effect_key_digest: SHA('6'),
        message: secondMessage,
        body_digest: createHash('sha256').update(secondMessage, 'utf8').digest('hex'),
      });
      const firstPrepared = store.begin(first);
      store.confirm(first.effect_key_digest, firstPrepared.messageId);
      const secondPrepared = store.begin(second);

      const aliasDirectory = join(directory, 'operator-delivery-echo-aliases.v1');
      await mkdir(aliasDirectory, { mode: 0o700 });
      const aliasPayload = {
        schema_version: 'hermes.whatsapp_operator_echo_alias.v1',
        message_id: secondPrepared.messageId,
        effect_key_digest: first.effect_key_digest,
        chat_digest: first.chat_digest,
      };
      const alias = {
        ...aliasPayload,
        alias_digest: canonicalDigest(
          aliasPayload,
          'hermes.whatsapp_operator_echo_alias.v1',
        ),
      };
      const aliasPath = join(
        aliasDirectory,
        `${createHash('sha256').update(secondPrepared.messageId, 'utf8').digest('hex')}.json`,
      );
      await writeFile(aliasPath, `${JSON.stringify(alias)}\n`, { mode: 0o600 });

      assert.equal(store.confirmProviderEcho({
        messageId: secondPrepared.messageId,
        chatId: second.chat_id,
        fromMe: true,
        body: second.message,
      }), false);
      assert.equal(store.receipt(query({
        effect_key_digest: second.effect_key_digest,
        body_digest: second.body_digest,
      })).status, 'UNKNOWN');
    });
  });
});

test('unsafe archive directory permissions fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  try {
    const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    const message = 'First settled record.';
    const request = sendRequest({
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const prepared = store.begin(request);
    store.confirm(request.effect_key_digest, prepared.messageId);
    const archiveDirectory = join(
      directory,
      'operator-delivery-receipts.v1.archive',
    );
    await mkdir(archiveDirectory, { mode: 0o700 });
    await chmod(archiveDirectory, 0o755);

    const nextMessage = 'Trigger unsafe archive use.';
    assert.throws(
      () => store.begin(sendRequest({
        effect_key_digest: SHA('6'),
        message: nextMessage,
        body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
      })),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_store_invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('symlinked archive directory fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
  const external = await mkdtemp(join(tmpdir(), 'hermes-operator-external-'));
  try {
    const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
    const message = 'First settled record.';
    const request = sendRequest({
      message,
      body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    const prepared = store.begin(request);
    store.confirm(request.effect_key_digest, prepared.messageId);
    await symlink(
      external,
      join(directory, 'operator-delivery-receipts.v1.archive'),
      'dir',
    );

    const nextMessage = 'Trigger symlinked archive use.';
    assert.throws(
      () => store.begin(sendRequest({
        effect_key_digest: SHA('6'),
        message: nextMessage,
        body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
      })),
      (error) => error instanceof OperatorReceiptError
        && error.code === 'operator_receipt_store_invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('unsafe archive and alias files fail closed on read', async (t) => {
  await t.test('archive file mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    try {
      const store = createOperatorDeliveryStore(directory, { maxEntries: 1 });
      const message = 'Archive authority with unsafe mode.';
      const request = sendRequest({
        message,
        body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      });
      const prepared = store.begin(request);
      store.confirm(request.effect_key_digest, prepared.messageId);
      const nextMessage = 'Trigger archive creation.';
      store.begin(sendRequest({
        effect_key_digest: SHA('6'),
        message: nextMessage,
        body_digest: createHash('sha256').update(nextMessage, 'utf8').digest('hex'),
      }));
      const archivePath = join(
        directory,
        'operator-delivery-receipts.v1.archive',
        `${prepared.messageId}.json`,
      );
      await chmod(archivePath, 0o644);

      const reloaded = createOperatorDeliveryStore(directory, { maxEntries: 1 });
      assertStoreInvalid(() => reloaded.receipt(query({
        body_digest: request.body_digest,
      })));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test('echo alias file mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hermes-operator-receipts-'));
    try {
      const store = createOperatorDeliveryStore(directory);
      const message = 'Alias authority with unsafe mode.';
      const request = sendRequest({
        message,
        body_digest: createHash('sha256').update(message, 'utf8').digest('hex'),
      });
      store.begin(request);
      const providerMessageId = '3EB0UNSAFEALIASFILE1';
      store.confirm(request.effect_key_digest, providerMessageId);
      const aliasDirectory = join(
        directory,
        'operator-delivery-echo-aliases.v1',
      );
      const [aliasFile] = readdirSync(aliasDirectory);
      await chmod(join(aliasDirectory, aliasFile), 0o644);

      const reloaded = createOperatorDeliveryStore(directory);
      assertStoreInvalid(() => reloaded.confirmProviderEcho({
        messageId: providerMessageId,
        chatId: request.chat_id,
        fromMe: true,
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename as fsRename, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openWelcomeSettings } from '../src/welcome-settings.js';

const guildId = '234567890123456789';
const channelId = '123456789012345678';
const config = { channelId, template: 'สวัสดี {member}' };

async function withTempFile(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'welcome-settings-'));
  const path = join(directory, 'welcome.json');
  try {
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('starts disabled, persists settings in version 1 format and reloads them', async () => {
  await withTempFile(async (path) => {
    const store = await openWelcomeSettings(path, guildId);
    assert.deepEqual(await store.get(), { channelId: null, template: null });
    await store.set(config);

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      version: 1,
      guildId,
      channelId,
      template: 'สวัสดี {member}',
    });
    assert.deepEqual(await (await openWelcomeSettings(path, guildId)).get(), config);

    await store.disable();
    assert.deepEqual(await (await openWelcomeSettings(path, guildId)).get(), { channelId: null, template: null });
  });
});

test('rejects corrupt or mismatched guild settings rather than replacing them', async (t) => {
  await t.test('corrupt JSON', async () => withTempFile(async (path) => {
    await fsWriteFile(path, '{not json');
    await assert.rejects(openWelcomeSettings(path, guildId));
    assert.equal(await readFile(path, 'utf8'), '{not json');
  }));

  await t.test('different guild', async () => withTempFile(async (path) => {
    const original = JSON.stringify({ version: 1, guildId: '987654321098765432', channelId, template: 'Hello' });
    await fsWriteFile(path, original);
    await assert.rejects(openWelcomeSettings(path, guildId), /guild/i);
    assert.equal(await readFile(path, 'utf8'), original);
  }));
});

test('rejects unsupported versions, malformed IDs, partial disabled config and invalid templates', async (t) => {
  const invalidRecords = [
    { version: 2, guildId, channelId, template: 'Hello' },
    { version: 1, guildId, channelId: 'bad-id', template: 'Hello' },
    { version: 1, guildId, channelId: null, template: 'Hello' },
    { version: 1, guildId, channelId, template: '   ' },
    { version: 1, guildId, channelId, template: '{member}'.repeat(100) },
  ];

  for (const [index, record] of invalidRecords.entries()) {
    await t.test(`invalid record ${index + 1}`, async () => withTempFile(async (path) => {
      await fsWriteFile(path, JSON.stringify(record));
      await assert.rejects(openWelcomeSettings(path, guildId));
    }));
  }
});

test('serializes set and disable operations in call order', async () => {
  await withTempFile(async (path) => {
    const store = await openWelcomeSettings(path, guildId);
    const lastConfig = { channelId: '567890123456789012', template: 'Last {member}' };
    await Promise.all([store.set(config), store.disable(), store.set(lastConfig)]);

    assert.deepEqual(await store.get(), lastConfig);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      version: 1,
      guildId,
      ...lastConfig,
    });
  });
});

test('preserves the active setting after write or rename failure and accepts a later update', async (t) => {
  for (const failurePoint of ['write', 'rename']) {
    await t.test(`${failurePoint} failure`, async () => withTempFile(async (path) => {
      let fail = false;
      const store = await openWelcomeSettings(path, guildId, {
        writeFile: async (...args) => {
          if (fail && failurePoint === 'write') throw new Error('injected write failure');
          return fsWriteFile(...args);
        },
        rename: async (...args) => {
          if (fail && failurePoint === 'rename') throw new Error('injected rename failure');
          return fsRename(...args);
        },
      });
      await store.set(config);
      const replacement = { channelId: '567890123456789012', template: 'Replacement' };
      fail = true;
      await assert.rejects(store.set(replacement), new RegExp(`injected ${failurePoint} failure`));
      assert.deepEqual(await store.get(), config);

      fail = false;
      await store.set(replacement);
      assert.deepEqual(await store.get(), replacement);
      assert.deepEqual(await (await openWelcomeSettings(path, guildId)).get(), replacement);
    }));
  }
});

test('returns copies so callers cannot mutate active settings', async () => {
  await withTempFile(async (path) => {
    const store = await openWelcomeSettings(path, guildId);
    await store.set(config);
    const returned = await store.get();
    returned.channelId = '987654321098765432';
    returned.template = 'tampered';

    assert.deepEqual(await store.get(), config);
  });
});

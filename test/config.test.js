import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
const discord = { DISCORD_TOKEN: ' token ', DISCORD_CLIENT_ID: ' client ', DISCORD_GUILD_ID: ' guild ' };
test('Gemini configuration is optional without affecting required Discord setup', () => {
  assert.deepEqual(readConfig(discord), { token: 'token', clientId: 'client', guildId: 'guild', geminiApiKey: undefined, geminiModel: 'gemini-2.5-flash' });
  assert.equal(readConfig({ ...discord, GEMINI_API_KEY: ' key ' }).geminiApiKey, 'key');
  assert.equal(readConfig({ ...discord, GEMINI_MODEL: ' gemini-2.5-flash-lite ' }).geminiModel, 'gemini-2.5-flash-lite');
  assert.equal(readConfig({ ...discord, GEMINI_MODEL: '  ' }).geminiModel, 'gemini-2.5-flash');
  assert.throws(() => readConfig({ GEMINI_API_KEY: 'key' }), /DISCORD_TOKEN/);
});
test('invalid Gemini model is rejected without echoing the configured value', () => {
  assert.throws(() => readConfig({ ...discord, GEMINI_MODEL: 'https://invalid.test/private' }), (error) => error.message === 'invalid_model');
});

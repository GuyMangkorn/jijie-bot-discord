import test from 'node:test';
import assert from 'node:assert/strict';
import { getJijiPrompt } from '../src/jiji/jiji-trigger.js';
const botId = '523456789012345678';
const message = content => ({ content });

test('leading whitespace/name prefix triggers and strips only the leading name', () => {
  assert.equal(getJijiPrompt(message(' \n จีจี้ช่วยหน่อย'), botId), 'ช่วยหน่อย');
  assert.equal(getJijiPrompt(message('จีจี้ สวัสดี'), botId), 'สวัสดี');
  assert.equal(getJijiPrompt(message('คุยเรื่องจีจี้'), botId), null);
});
test('explicit own mention anywhere triggers, strips own mentions and preserves other mentions', () => {
  assert.equal(getJijiPrompt(message(`ช่วย <@${botId}> หน่อย <@!${botId}> <@123>`), botId), 'ช่วย  หน่อย  <@123>');
  assert.equal(getJijiPrompt(message('<@123> hi'), botId), null);
});
test('only a reply to this bot triggers without a name/mention', () => {
  assert.equal(getJijiPrompt(message('ขอต่อ'), botId, { replyAuthorId: botId }), 'ขอต่อ');
  assert.equal(getJijiPrompt(message('ขอต่อ'), botId, { replyAuthorId: '123' }), null);
  assert.equal(getJijiPrompt(message('ขอต่อ'), botId), null);
});
test('bare name, mention and empty bot reply produce empty greeting prompts', () => {
  for (const content of ['จีจี้', ' จีจี้ ', `<@${botId}>`, `<@!${botId}>`]) assert.equal(getJijiPrompt(message(content), botId), '');
  assert.equal(getJijiPrompt(message('  '), botId, { replyAuthorId: botId }), '');
});

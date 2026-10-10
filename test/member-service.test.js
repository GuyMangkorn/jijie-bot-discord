import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestMembers } from '../src/members/member-service.js';
import { handleLatestMembers } from '../src/members/latest-members-command.js';

const member = (id, joinedTimestamp, extra = {}) => ({
  id, joinedTimestamp, displayName: `name-${id}`, user: { bot: false }, ...extra,
});

test('full member retrieval failure rejects without using the partial cache', async () => {
  const failure = new Error('offline');
  await assert.rejects(fetchLatestMembers({ members: {
    fetch: async () => { throw failure; }, cache: new Map([['1', member('1', 1000)]]),
  } }), (error) => error === failure);
});

test('member service returns only ten newest humans and needed fields with stable ties', async () => {
  const members = [...Array.from({ length: 12 }, (_, i) => member(String(i + 10), i * 1000)),
    member('01', 11000), member('bot', 99999, { user: { bot: true } }), member('missing', null)];
  const result = await fetchLatestMembers({ members: { fetch: async (...args) => {
    assert.deepEqual(args, []);
    return new Map(members.map((value) => [value.id, value]));
  } } });
  assert.deepEqual(result, [
    { userId: '01', name: 'name-01', joinedAt: 11000 },
    { userId: '21', name: 'name-21', joinedAt: 11000 },
    ...['20', '19', '18', '17', '16', '15', '14', '13'].map((userId, i) =>
      ({ userId, name: `name-${userId}`, joinedAt: 10000 - i * 1000 })),
  ]);
});

test('slash member response still defers publicly before fetch and produces the same embed', async () => {
  const events = [];
  await handleLatestMembers({
    isChatInputCommand: () => true, commandName: 'ล่าสุด',
    guild: { members: { fetch: async () => {
      assert.deepEqual(events, ['deferred']);
      return new Map([['1', member('1', 5000)]]);
    } } },
    deferReply: async (...args) => { assert.deepEqual(args, []); events.push('deferred'); },
    editReply: async (reply) => {
      assert.deepEqual(reply.embeds[0].toJSON(), {
        title: 'สมาชิกที่เข้าร่วมล่าสุด', description: '1. <@1> — <t:5:f>', color: 0x5865f2,
      });
      assert.deepEqual(reply.allowedMentions, { parse: [] });
      events.push('replied');
    },
  });
  assert.deepEqual(events, ['deferred', 'replied']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJijiDiagnostics, readJijiDiagnostic } from '../src/jiji/jiji-diagnostics.js';

const traceId = '00000000-0000-4000-8000-000000000001';
const fields = {
  event: 'jiji_turn_failed', traceId, stage: 'google_search', category: 'search_failed',
  status: 429, reason: 'http', durationMs: 123, requestCount: 2, toolCount: 1,
  answer: 'SECRET answer', query: 'SECRET query', headers: 'SECRET headers',
};

test('allowlisted JSON line includes only normalized safe fields', () => {
  const lines = [];
  const diagnostics = createJijiDiagnostics({ write: line => lines.push(line), now: () => 0 });
  const result = diagnostics.record(fields);
  const parsed = JSON.parse(lines[0]);
  assert.equal(result, undefined);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.equal(parsed.timestamp, '1970-01-01T00:00:00.000Z');
  assert.equal(parsed.httpStatus, 429);
  assert.equal(parsed.event, 'jiji_turn_failed');
  assert.deepEqual(Object.keys(parsed).sort(), [
    'category', 'durationMs', 'event', 'httpStatus', 'reason', 'requestCount',
    'stage', 'timestamp', 'toolCount', 'traceId',
  ].sort());
  assert.ok(!lines.join('').includes('SECRET'));
  assert.deepEqual(readJijiDiagnostic(Object.assign(new Error('SECRET message'), {
    category: 'http', status: 429,
    diagnostic: { stage: 'google_search', reason: 'http', status: 503, secret: 'SECRET' },
  })), { category: 'http', stage: 'google_search', reason: 'http', status: 503 });
});

test('hostile metadata is ignored and malformed values are normalized', () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'category', { get() { getterCalls++; return 'SECRET'; } });
  Object.defineProperty(hostile, 'status', { get() { getterCalls++; return 429; } });
  const diagnostic = readJijiDiagnostic(hostile);
  assert.equal(getterCalls, 0);
  assert.deepEqual(diagnostic, { category: 'unknown' });
  assert.equal(readJijiDiagnostic({ category: 'SECRET' }).category, 'unknown');

  const lines = [];
  const diagnostics = createJijiDiagnostics({ write: line => lines.push(line), now: () => 0 });
  diagnostics.record({ ...fields, event: 'SECRET', traceId: 'not-a-uuid', stage: 'SECRET', category: 'SECRET',
    reason: 'SECRET', status: 99, durationMs: -1, requestCount: 99, toolCount: 99 });
  diagnostics.record({ ...fields, status: 600, durationMs: Number.NaN, requestCount: Number.POSITIVE_INFINITY, toolCount: -9 });
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.event, 'jiji_turn_failed');
  assert.equal(first.traceId, undefined);
  assert.equal(first.stage, 'unknown');
  assert.equal(first.category, 'unknown');
  assert.equal(first.reason, 'unknown');
  assert.equal(first.httpStatus, undefined);
  assert.equal(first.durationMs, 0);
  assert.equal(first.requestCount, 3);
  assert.equal(first.toolCount, 4);
  assert.equal(second.httpStatus, undefined);
  assert.equal(second.durationMs, 0);
  assert.equal(second.requestCount, 0);
  assert.equal(second.toolCount, 0);
  diagnostics.record({ ...fields, durationMs: Number.POSITIVE_INFINITY, requestCount: 8, toolCount: 8 });
  const third = JSON.parse(lines[2]);
  assert.equal(third.durationMs, 0);
  assert.equal(third.requestCount, 3);
  assert.equal(third.toolCount, 4);
});

test('throwing sink does not escape the conversation lifecycle', () => {
  const broken = createJijiDiagnostics({ write: () => { throw new Error('SECRET sink'); }, now: () => 0 });
  assert.doesNotThrow(() => broken.record(fields));
});

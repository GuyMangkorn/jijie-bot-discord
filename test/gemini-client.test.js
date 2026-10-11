import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient, JIJI_TIRED_MESSAGE } from '../src/jiji/gemini-client.js';
import { jijiToolDeclarations, searchGoogleDeclaration, createJijiTools } from '../src/jiji/jiji-tools.js';
const reply = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...extra }] });
const jsonResponse = (data) => ({ ok: true, json: async () => data });
const call = (name = 'activity_help') => ({ functionCall: { name, args: {} }, thoughtSignature: 'signature' });
const secret = 'fake-private-key';
function fixture(responses) {
  const requests = [];
  return { requests, client: createGeminiClient({ apiKey: secret, fetchImpl: async (url, options) => {
    requests.push({ url, ...options, payload: JSON.parse(options.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  } }) };
}

const searchCall = query => ({ functionCall: { name: 'search_google', args: { query } } });
const grounded = (overrides = {}) => reply([{ text: 'ข้อมูลจาก Google' }], { groundingMetadata: {
  webSearchQueries: ['weather Bangkok'],
  groundingChunks: [{ web: { uri: 'https://example.com/weather', title: 'Weather' } }],
  searchEntryPoint: { renderedContent: '<a href="https://www.google.com/search?q=weather&amp;hl=th">weather</a>' },
  ...overrides,
} });
function searchTools(checkAccess = async () => true) {
  return createJijiTools({ guild: { id: '1' }, guildId: '1', channelId: '2', userId: '3', checkAccess });
}

test('search tool uses isolated Google grounding then continues with sources; counts all three requests', async () => {
  const { client, requests } = fixture([
    jsonResponse(reply([searchCall('weather Bangkok')])), jsonResponse(grounded()),
    jsonResponse(reply([{ text: 'คำตอบล่าสุด' }])),
  ]);
  const result = await client.respond({ text: 'อากาศวันนี้', history: [{ user: 'private history', assistant: 'private answer' }], tools: searchTools() });
  assert.equal(result.usedTools, true);
  assert.match(result.text, /คำตอบล่าสุด\n\nแหล่งอ้างอิง/);
  assert.match(result.text, /<https:\/\/example.com\/weather>/);
  assert.match(result.text, /<https:\/\/www.google.com\/search\?q=weather&hl=th>/);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].payload.tools, [{ google_search: {} }]);
  assert.deepEqual(requests[1].payload.contents, [{ role: 'user', parts: [{ text: 'weather Bangkok' }] }]);
  assert.equal(JSON.stringify(requests[1].payload).includes('private'), false);
  assert.equal(requests[1].headers['x-goog-api-key'], secret);
  assert.equal(requests[1].redirect, 'error');
  assert.equal(requests[1].payload.generationConfig.maxOutputTokens, 512);
  assert.equal(requests[2].payload.contents.at(-1).parts[0].functionResponse.response.data.text, 'ข้อมูลจาก Google');
});

test('search arguments reject empty, oversized, extra and prototype values before tool dispatch', async () => {
  for (const args of [{}, { query: '' }, { query: '  ' }, { query: 'x'.repeat(501) },
    { query: 'weather', url: 'https://evil.test' }, { query: 7 }, null, []]) {
    const { client, requests } = fixture([jsonResponse(reply([{ functionCall: { name: 'search_google', args } }]))]);
    await assert.rejects(client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'invalid_tool_call' });
    assert.equal(requests.length, 1);
  }
});

test('denied access never starts Google Search; failed search never becomes an ungrounded answer', async () => {
  const denied = fixture([jsonResponse(reply([searchCall('weather')]))]);
  await assert.rejects(denied.client.respond({ text: 'ค้น', tools: searchTools(async () => false) }), { category: 'access_denied' });
  assert.equal(denied.requests.length, 1);
  for (const data of [grounded({ webSearchQueries: [] }), grounded({ groundingChunks: [] }),
    grounded({ searchEntryPoint: { renderedContent: '<script>private</script>' } }),
    grounded({ groundingChunks: [{ web: { uri: 'javascript:private' } }] }),
    grounded({ searchEntryPoint: { renderedContent: '<a href="https://user:password@evil.test">bad</a>' } }),
    reply([{ text: 'guess without search' }])]) {
    const f = fixture([jsonResponse(reply([searchCall('weather')])), jsonResponse(data)]);
    await assert.rejects(f.client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'search_failed' });
    assert.equal(f.requests.length, 2);
  }
  const http = fixture([jsonResponse(reply([searchCall('weather')])), { ok: false, status: 429, json: () => assert.fail('body must not be read') }]);
  await assert.rejects(http.client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'search_failed' });
  assert.equal(http.requests.length, 2);
});

test('search and Discord tools may share a batch; excess nested calls reserve the final request', async () => {
  const f = fixture([jsonResponse(reply([call(), searchCall('weather')])), jsonResponse(grounded()), jsonResponse(reply([{ text: 'done' }]))]);
  assert.equal((await f.client.respond({ text: 'ค้นและกิจกรรม', tools: searchTools() })).usedTools, true);
  assert.equal(f.requests[2].payload.contents.at(-1).parts.length, 2);
  const duplicate = fixture([jsonResponse(reply([searchCall('one'), searchCall('two')]))]);
  await assert.rejects(duplicate.client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'tool_budget' });
  assert.equal(duplicate.requests.length, 1);
  const late = fixture([jsonResponse(reply([call()])), jsonResponse(reply([searchCall('weather')]))]);
  await assert.rejects(late.client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'request_budget' });
  assert.equal(late.requests.length, 2);
  const long = fixture([jsonResponse(reply([searchCall('weather')])), jsonResponse(grounded()), jsonResponse(reply([{ text: 'x'.repeat(1900) }]))]);
  await assert.rejects(long.client.respond({ text: 'ค้น', tools: searchTools() }), { category: 'output_too_long' });
});

test('cancelling uncancellable search discards late results and never starts continuation', async () => {
  const controller = new AbortController();
  let release, enter;
  const started = new Promise(resolve => { enter = resolve; });
  let count = 0;
  const client = createGeminiClient({ apiKey: secret, fetchImpl: async () => {
    count += 1;
    if (count === 1) return jsonResponse(reply([searchCall('weather')]));
    enter(); return new Promise(resolve => { release = resolve; });
  } });
  const pending = client.respond({ text: 'ค้น', tools: searchTools(), signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, { category: 'cancelled' });
  release(jsonResponse(grounded()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2);
});
test('stateless Google transport sends ordered history, persona and only approved functions', async () => {
  const { client, requests } = fixture([jsonResponse(reply([{ text: 'สวัสดี 😊' }]))]);
  const signal = new AbortController().signal;
  assert.deepEqual(await client.respond({ history: [{ user: 'ก่อน', assistant: 'ตอบก่อน', at: 1 }], text: 'วันนี้', signal }), { text: 'สวัสดี 😊', usedTools: false });
  const request = requests[0];
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(request.headers['x-goog-api-key'], secret);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.signal, signal);
  assert.deepEqual(request.payload.contents, [{ role: 'user', parts: [{ text: 'ก่อน' }] }, { role: 'model', parts: [{ text: 'ตอบก่อน' }] }, { role: 'user', parts: [{ text: 'วันนี้' }] }]);
  assert.deepEqual(request.payload.tools, [{ functionDeclarations: [...jijiToolDeclarations, searchGoogleDeclaration].map(({ parameters, ...tool }) => ({ ...tool, parametersJsonSchema: parameters })) }]);
  assert.equal(request.payload.generationConfig.maxOutputTokens, 512);
  const systemPrompt = request.payload.systemInstruction.parts[0].text;
  assert.match(systemPrompt, /จีจี้/);
  assert.match(systemPrompt, /ใช้ภาษาธรรมชาติเหมือนคนแชทกัน/);
  assert.match(systemPrompt, /ถ้าเป็นการคุยเล่นหรือเล่าเรื่องให้ตอบสั้นประมาณ 1–2 ประโยค/);
  assert.match(systemPrompt, /ถ้าผู้ใช้ถามข้อมูล ขอคำอธิบายหรือขั้นตอน ให้ตอบครบตามที่จำเป็น/);
  assert.match(systemPrompt, /ไม่จำกัดไว้ที่ 1–2 ประโยค/);
  assert.match(systemPrompt, /ไม่ใส่อีโมจิเป็นค่าเริ่มต้น ใช้บ้างเฉพาะเมื่อเข้ากับอารมณ์หรือบริบท ไม่ต้องมีทุกคำตอบ/);
  assert.match(systemPrompt, /คุยหัวข้อทั่วไปได้/);
  assert.match(systemPrompt, /ดูดวงหรือทำนายได้เพื่อความสนุก/);
  assert.match(systemPrompt, /อย่าปฏิเสธเพียงเพราะหัวข้อไม่เกี่ยวกับเซิร์ฟเวอร์/);
  assert.match(systemPrompt, /ไม่แต่งข้อมูลเซิร์ฟเวอร์/);
  assert.match(systemPrompt, /search_google/);
  assert.match(systemPrompt, /ใช้ get_latest_members หรือ get_recent_departures เมื่อถามข้อมูลสมาชิกหรือเหตุการณ์การออก/);
  assert.match(systemPrompt, /activity_help/);
  assert.equal(JSON.stringify(request.payload).includes(secret), false);
  assert.deepEqual(Object.keys(request.payload).sort(), ['contents', 'generationConfig', 'systemInstruction', 'tools']);
  assert.equal(JIJI_TIRED_MESSAGE, 'จีจี้เหนื่อยแล้ว 😴 รอก่อนแล้วค่อยมาคุยกันใหม่นะ');
});
test('tool continuation preserves every model part and pairs approved function responses', async () => {
  const parts = [{ text: 'กำลังดู', thought: true }, call(), { text: 'pending' }];
  const { client, requests } = fixture([jsonResponse(reply(parts)), jsonResponse(reply([{ text: 'ผลสุดท้าย' }]))]);
  const result = { ok: true, data: { message: 'ใช้ /กิจกรรม' } };
  const executions = [];
  assert.deepEqual(await client.respond({ text: 'กิจกรรม', tools: { execute: async (...args) => { executions.push(args); return result; } } }), { text: 'ผลสุดท้าย', usedTools: true });
  assert.equal(executions.length, 1);
  assert.deepEqual(requests[1].payload.contents[1], { role: 'model', parts });
  assert.deepEqual(requests[1].payload.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'activity_help', response: result } }] });
});
test('provider failures use local errors only and never retry or consume provider bodies', async () => {
  for (const status of [401, 429, 500, 503]) {
    let read = false;
    const { client, requests } = fixture([{ ok: false, status, json: async () => { read = true; throw Error(secret); } }]);
    await assert.rejects(client.respond({ text: 'hello' }), (error) => error.category === 'http' && error.status === status && error.message === 'http' && !error.cause);
    assert.equal(requests.length, 1);
    assert.equal(read, false);
  }
  const { client, requests } = fixture([Error(`provider body ${secret}`)]);
  await assert.rejects(client.respond({ text: 'hello' }), (error) => error.category === 'network' && error.message === 'network' && !JSON.stringify(error).includes(secret));
  assert.equal(requests.length, 1);
});
test('blocked, empty, malformed and overlong successful responses fail closed', async () => {
  const cases = [
    [null, 'malformed_response'], [{}, 'empty_response'], [{ promptFeedback: { blockReason: 'SAFETY' } }, 'blocked_response'],
    [reply([{ text: 'secret body' }], { finishReason: 'SAFETY' }), 'blocked_response'],
    [reply([{ text: 5 }]), 'malformed_response'], [reply([null]), 'malformed_response'],
    [reply([{ thought: true, text: 'private reasoning' }]), 'empty_response'],
    [reply([{ text: 'x'.repeat(2001) }]), 'output_too_long'],
    [{ candidates: [{ content: { role: 'user', parts: [{ text: 'bad role' }] } }] }, 'malformed_response'],
  ];
  for (const [data, category] of cases) {
    const { client, requests } = fixture([jsonResponse(data)]);
    await assert.rejects(client.respond({ text: 'hello' }), (error) => error.category === category && error.message === category);
    assert.equal(requests.length, 1);
  }
  const { client } = fixture([{ ok: true, json: async () => { throw Error(secret); } }]);
  await assert.rejects(client.respond({ text: 'hello' }), { message: 'malformed_response' });
});
test('validated model rejects arbitrary URLs and sensitive config without echoes', () => {
  for (const model of ['https://evil.test', '../model', 'gemini-flash?key=secret', 'gemini/a', '', 'gemini-flash\n']) {
    assert.throws(() => createGeminiClient({ apiKey: secret, model }), { message: 'invalid_model' });
  }
});
test('bounded tool loop rejects unknown or nonempty calls before execution', async () => {
  for (const part of [call('unknown'), { functionCall: { name: 'activity_help', args: { secret } } }, { functionCall: { name: 'activity_help', args: null } }]) {
    let executions = 0;
    const { client, requests } = fixture([jsonResponse(reply([part]))]);
    await assert.rejects(client.respond({ text: 'hi', tools: { execute: async () => { executions += 1; } } }), { message: 'invalid_tool_call' });
    assert.equal(executions, 0);
    assert.equal(requests.length, 1);
  }
});
test('three-request and four-tool budgets cap work before dispatching excess', async () => {
  let executions = 0;
  const tools = { execute: async () => { executions += 1; return { ok: true, data: {} }; } };
  const requestLimited = fixture(Array.from({ length: 3 }, () => jsonResponse(reply([call()]))));
  await assert.rejects(requestLimited.client.respond({ text: 'hi', tools }), { message: 'request_budget' });
  assert.equal(requestLimited.requests.length, 3);
  assert.equal(executions, 2);
  executions = 0;
  const toolLimited = fixture([jsonResponse(reply([call(), call(), call()])), jsonResponse(reply([call(), call()]))]);
  await assert.rejects(toolLimited.client.respond({ text: 'hi', tools }), { message: 'tool_budget' });
  assert.equal(executions, 3);
  const allowed = fixture([jsonResponse(reply([call(), call()])), jsonResponse(reply([call(), call()])), jsonResponse(reply([{ text: 'done' }]))]);
  executions = 0;
  assert.deepEqual(await allowed.client.respond({ text: 'hi', tools }), { text: 'done', usedTools: true });
  assert.equal(executions, 4);
});
test('tool failure categories are preserved locally for operational Thai errors', async () => {
  const { client, requests } = fixture([jsonResponse(reply([call('get_latest_members')]))]);
  await assert.rejects(client.respond({ text: 'hi', tools: { execute: async () => ({ ok: false, error: 'member_fetch_failed' }) } }), { category: 'member_fetch_failed' });
  assert.equal(requests.length, 1);
});
test('abort before fetch, during fetch, body read or tool execution discards late results', async () => {
  const controller = new AbortController();
  controller.abort(Error(secret));
  const before = fixture([]);
  await assert.rejects(before.client.respond({ text: 'hi', signal: controller.signal }), { message: 'cancelled' });
  assert.equal(before.requests.length, 0);
  for (const phase of ['fetch', 'body', 'tool']) {
    const control = new AbortController();
    const client = createGeminiClient({ apiKey: secret, fetchImpl: async () => {
      if (phase === 'fetch') return new Promise(() => {});
      return { ok: true, json: async () => phase === 'body' ? new Promise(() => {}) : reply([call()]) };
    } });
    const pending = client.respond({ text: 'hi', signal: control.signal, tools: { execute: async () => new Promise(() => {}) } });
    setTimeout(() => control.abort(Error(secret)), 5);
    await assert.rejects(pending, { message: 'cancelled' });
  }
});
test('history is bounded to ten local pairs and thought text is never public', async () => {
  const { client, requests } = fixture([jsonResponse(reply([{ thought: true, text: 'private' }, { text: 'public' }]))]);
  const history = Array.from({ length: 11 }, (_, i) => ({ user: `u${i}`, assistant: `a${i}`, at: i }));
  assert.deepEqual(await client.respond({ text: 'hi', history }), { text: 'public', usedTools: false });
  assert.equal(requests[0].payload.contents.length, 21);
  assert.equal(requests[0].payload.contents[0].parts[0].text, 'u1');
});
test('error tool result and function id round trip without dropping model signature', async () => {
  const part = call();
  part.functionCall.id = 'call-1';
  const result = { ok: false, error: 'tool_failed' };
  const { client, requests } = fixture([jsonResponse(reply([part])), jsonResponse(reply([{ text: 'ไม่ได้ข้อมูล' }]))]);
  assert.deepEqual(await client.respond({ text: 'hi', tools: { execute: async () => result } }), { text: 'ไม่ได้ข้อมูล', usedTools: true });
  assert.deepEqual(requests[1].payload.contents[2].parts[0].functionResponse, { name: 'activity_help', id: 'call-1', response: result });
});
test('input and missing-key bounds avoid any provider request', async () => {
  const { client, requests } = fixture([]);
  for (const text of ['', ' ', 'x'.repeat(2001)]) await assert.rejects(client.respond({ text }), { message: 'invalid_input' });
  assert.equal(requests.length, 0);
  await assert.rejects(createGeminiClient({}).respond({ text: 'hi' }), { message: 'missing_key' });
});

test('nested Search HTTP diagnostic survives tool result', async () => {
  const { client, requests } = fixture([
    jsonResponse(reply([searchCall('weather Bangkok')])),
    { ok: false, status: 429, json: () => assert.fail('HTTP body must not be read') },
  ]);
  const progress = [];
  let failure;
  await assert.rejects(client.respond({ text: 'ค้นอากาศ', tools: searchTools(), onProgress: snapshot => progress.push(snapshot) }), error => {
    failure = error;
    return error.category === 'search_failed';
  });
  assert.deepEqual(failure.diagnostic, { stage: 'google_search', reason: 'http', status: 429 });
  assert.deepEqual(progress.at(-1), { stage: 'google_search', requestCount: 2, toolCount: 1 });
  assert.equal(requests.length, 2);
});

test('diagnostic metadata never reaches a Gemini function response', async () => {
  const { client, requests } = fixture([
    jsonResponse(reply([call()])), jsonResponse(reply([{ text: 'จบ' }])),
  ]);
  const tools = { execute: async () => ({ ok: false, error: 'tool_failed', diagnostic: {
    stage: 'tool', reason: 'http', status: 429, detail: 'SENSITIVE_DIAGNOSTIC',
  } }) };
  await client.respond({ text: 'ถาม', tools });
  const functionResponse = requests[1].payload.contents.at(-1).parts[0].functionResponse.response;
  assert.deepEqual(functionResponse, { ok: false, error: 'tool_failed' });
  assert.equal(JSON.stringify(requests.map(request => request.payload)).includes('SENSITIVE_DIAGNOSTIC'), false);
});

test('throwing progress callback is harmless and progress is emitted', async () => {
  const { client } = fixture([jsonResponse(reply([{ text: 'ตอบได้' }]))]);
  let calls = 0;
  const result = await client.respond({ text: 'ถาม', onProgress: () => { calls++; throw new Error('private callback'); } });
  assert.equal(result.text, 'ตอบได้');
  assert.equal(calls, 2);
});

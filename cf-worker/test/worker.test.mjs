// Offline regression tests: node --test test/ (no network, no Cloudflare runtime).
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChat, classify, equalSecret, normalizeAccount, jwtExpiry, aggregateSSE, GatewayError } from '../src/protocol.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { Upstream } from '../src/upstream.mjs';

test('prepareChat validates and forces stream', () => {
  assert.throws(() => prepareChat({ messages: [] }), GatewayError);
  const out = prepareChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, tool_choice: 'none', tools: [{}] });
  assert.equal(out.stream, true);
  assert.equal(out.tools, undefined);
});

test('classify maps statuses and keywords', () => {
  assert.equal(classify(200, { code: 40100 }), 'session_dead');
  assert.equal(classify(401, {}), 'unauthorized');
  assert.equal(classify(402, ''), 'no_credit');
  assert.equal(classify(200, { msg: '积分不足' }), 'no_credit');
  assert.equal(classify(500, ''), 'upstream_server');
  assert.equal(classify(400, { msg: 'bad' }), 'upstream_rejected');
});

test('equalSecret is constant-ish and correct', async () => {
  assert.equal(await equalSecret('a', 'a'), true);
  assert.equal(await equalSecret('a', 'b'), false);
  assert.equal(await equalSecret(undefined, 'a'), false);
});

test('normalizeAccount accepts nested and flat docs', () => {
  const a = normalizeAccount({ auth: { accessToken: 't', refreshToken: 'r', uid: 'u1' }, account: { uid: 'u1' } });
  assert.equal(a.uid, 'u1');
  assert.equal(a.refreshToken, 'r');
  const b = normalizeAccount({ accessToken: 't', uid: 'u2' });
  assert.equal(b.uid, 'u2');
  assert.throws(() => normalizeAccount({ accessToken: 't' }), GatewayError);
});

test('jwtExpiry decodes payload exp', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString('base64url');
  assert.equal(jwtExpiry(`h.${payload}.s`), 1893456000);
  assert.equal(jwtExpiry('not-a-jwt'), 0);
});

test('aggregateSSE merges deltas, tools, usage; requires DONE', async () => {
  const sse = [
    'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"he"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"llo"}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"index":0,"finish_reason":"tool_calls"}],"usage":{"total_tokens":5}}',
    'data: [DONE]', ''
  ].join('\n\n');
  const res = await aggregateSSE(new Response(sse).body);
  assert.equal(res.object, 'chat.completion');
  assert.equal(res.choices[0].message.content, 'hello');
  assert.deepEqual(res.choices[0].message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
  assert.equal(res.usage.total_tokens, 5);
  await assert.rejects(aggregateSSE(new Response('data: {"choices":[]}').body), e => e.code === 'incomplete_stream');
});

// Minimal fake storage + DO state to exercise coordinator flows offline.
function fakeStorage() {
  const map = new Map();
  return {
    map,
    async get(k) { return structuredClone(map.get(k)); },
    async put(k, v) { for (const [key, val] of (typeof k === 'string' ? [[k, v]] : Object.entries(k))) map.set(key, structuredClone(val)); },
    async list({ prefix } = {}) { return structuredClone(new Map([...map].filter(([k]) => !prefix || k.startsWith(prefix)))); },
    async delete(k) { map.delete(k); },
    async setAlarm() { this.alarms = (this.alarms || 0) + 1; },
    async getAlarm() { return null; },
    async deleteAlarm() {}
  };
}
function makeCoordinator(env) {
  env.storage = fakeStorage();
  return new Coordinator({ storage: env.storage }, env);
}

test('coordinator: import, status, pick skips cooled-down accounts', async () => {
  const env = {}; const c = makeCoordinator(env);
  const res = await c.importAccounts(new Request('https://x/admin/accounts', { method: 'POST', body: JSON.stringify([
    { auth: { accessToken: 'a', refreshToken: 'r', uid: 'u1' }, account: { uid: 'u1' } },
    { accessToken: 'b', uid: 'u2' }
  ]) }));
  assert.deepEqual((await res.json()).imported, ['u1', 'u2']);
  const updated = await c.importAccounts(new Request('https://x/admin/accounts', { method: 'POST', body: '[{"accessToken":"z","uid":"u1"}]' }));
  assert.equal((await updated.json()).total, 2);
  await assert.rejects(c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"z","uid":"u1"},{"accessToken":"z","uid":"u1"}]' })), /Duplicate/);
  const a1 = await c.storage.get('account:u1');
  a1.cooldownUntil = Date.now() + 60000;
  await c.save(a1);
  const picked = await c.pick();
  assert.equal(picked.uid, 'u2');
});

test('coordinator: refresh failure with session_dead disables; success stores rotated tokens', async () => {
  const env = {}; const c = makeCoordinator(env);
  const a = { uid: 'u1', accessToken: 'old', refreshToken: 'r', expiresAt: 1 };
  await c.save(a);
  // Failing upstream.
  c.upstream = { refresh: async () => { throw new GatewayError(401, 'session_dead', 'rejected'); } };
  await assert.rejects(c.refresh(a, true), /rejected/);
  assert.equal((await c.storage.get('account:u1')).disabled, true);
  // Succeeding upstream.
  const a2 = { uid: 'u2', accessToken: 'old', refreshToken: 'r', expiresAt: 1 };
  await c.save(a2);
  c.upstream = { refresh: async () => ({ accessToken: 'new', refreshToken: 'r2', expiresIn: 3600 }) };
  await c.refresh(a2, true);
  const saved = await c.storage.get('account:u2');
  assert.equal(saved.accessToken, 'new');
  assert.equal(saved.refreshToken, 'r2');
  assert.equal(saved.refreshPending, false);
});

test('coordinator: unauthorized chat triggers one refresh retry then upstream retry', async () => {
  const env = {}; const c = makeCoordinator(env);
  await c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"t","refreshToken":"r","uid":"u1"}]' }));
  let calls = 0;
  c.upstream = {
    refresh: async () => ({ accessToken: 'fresh', expiresIn: 3600 }),
    chat: async (acct) => { calls++; if (acct.accessToken === 't') throw new GatewayError(401, 'unauthorized', 'expired'); return new Response('ok'); }
  };
  const res = await c.chat(new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) }));
  assert.equal(await res.text(), 'ok');
  assert.equal(calls, 2);
});

test('maintenance: checkin once per day, cooldown lifted when balance returns', async () => {
  const env = {}; const c = makeCoordinator(env);
  await c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"t","refreshToken":"r","uid":"u1"}]' }));
  let checkins = 0;
  c.upstream = {
    refresh: async () => ({ accessToken: 'fresh', expiresIn: 3600 }),
    checkin: async () => { checkins++; return { ok: true }; },
    api: async (path) => path === '/api/user/profile-summary' ? { totalCreditsRemaining: 300 } : []
  };
  const a = await c.storage.get('account:u1');
  a.reason = 'no_credit'; a.cooldownUntil = Date.now() + 12 * 3600000;
  await c.save(a);
  await c.maintain(a);
  assert.equal(checkins, 1);
  const saved = await c.storage.get('account:u1');
  assert.equal(saved.cooldownUntil, 0);
  assert.equal(saved.credits, 300);
  assert.equal(saved.checkinDay, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  const key = saved.checkinKey;
  await c.maintain(saved); // Same-day retry reuses the persisted idempotency key.
  assert.equal(checkins, 2);
  assert.equal((await c.storage.get('account:u1')).checkinKey, key);
});

test('upstream: validates base URL and maps envelope errors', async () => {
  const u = new Upstream({ UPSTREAM_BASE: 'http://insecure.example' });
  assert.throws(() => u.base(), /HTTPS/);
  const ok = new Upstream({ UPSTREAM_BASE: 'https://upstream.example' }, async () => new Response(JSON.stringify({ code: 429, msg: 'rate' }), { status: 429 }));
  await assert.rejects(ok.api('/api/x', { token: 't' }), e => e.code === 'rate_limit' && e.status === 429);
});

test('regression: transport failure during refresh clears refreshPending and parks briefly', async () => {
  const env = {}; const c = makeCoordinator(env);
  const a = { uid: 'u1', accessToken: 'old', refreshToken: 'r', expiresAt: 1 };
  await c.save(a);
  c.upstream = { refresh: async () => { throw new TypeError('fetch failed'); } };
  await assert.rejects(c.refresh(a, true), TypeError);
  const saved = await c.storage.get('account:u1');
  assert.equal(saved.refreshPending, false); // Used to stay true forever, silently dropping the account.
  assert.equal(saved.reason, 'refresh_transport_error');
  assert.ok(saved.cooldownUntil > Date.now() && saved.cooldownUntil <= Date.now() + 10 * 60000 + 1000);
  assert.notEqual(saved.disabled, true);
});

test('regression: re-import keeps pool state while clearing trip flags', async () => {
  const env = {}; const c = makeCoordinator(env);
  await c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"t","refreshToken":"r","uid":"u1"}]' }));
  const a = await c.storage.get('account:u1');
  Object.assign(a, { cooldownUntil: Date.now() + 3600000, reason: 'no_credit', credits: 0, checkinDay: '2026-09-17', checkinKey: 'fixed-key', disabled: true, errCount: 2 });
  await c.save(a);
  await c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"fresh","refreshToken":"r2","uid":"u1"}]' }));
  const saved = await c.storage.get('account:u1');
  assert.equal(saved.cooldownUntil > Date.now(), true); // no_credit cooldown survives a credential refresh
  assert.equal(saved.reason, 'no_credit');
  assert.equal(saved.checkinKey, 'fixed-key');
  assert.equal(saved.checkinDay, '2026-09-17');
  assert.equal(saved.disabled, false); // exporting fresh credentials clears the disable flag
  assert.equal(saved.refreshPending, false);
});

test('regression: chat rotates to the next account on 429 then reports the last error', async () => {
  const env = {}; const c = makeCoordinator(env);
  await c.importAccounts(new Request('https://x', { method: 'POST', body: '[{"accessToken":"a","uid":"u1"},{"accessToken":"b","uid":"u2"}]' }));
  const seen = [];
  c.upstream = {
    chat: async (acct) => { seen.push(acct.uid); throw new GatewayError(429, 'rate_limit', 'slow down'); }
  };
  await assert.rejects(c.chat(new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) })), e => e.code === 'rate_limit');
  assert.deepEqual(seen.sort(), ['u1', 'u2']); // both accounts were tried, not just the first
  assert.ok((await c.storage.get('account:u1')).cooldownUntil > Date.now());
  assert.ok((await c.storage.get('account:u2')).cooldownUntil > Date.now());
});

test('regression: repeated transport errors park an account after the threshold', async () => {
  const env = {}; const c = makeCoordinator(env);
  const a = { uid: 'u1', accessToken: 't', refreshToken: 'r', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  await c.save(a);
  c.upstream = { chat: async () => { throw new GatewayError(502, 'upstream_server', 'boom'); } };
  const call = () => c.chat(new Request('https://x/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) }));
  for (let i = 0; i < 2; i++) await assert.rejects(call(), e => e.code === 'upstream_server');
  assert.equal((await c.storage.get('account:u1')).errCount, 2);
  await assert.rejects(call(), e => e.code === 'upstream_server'); // third error triggers the cooldown
  const parked = await c.storage.get('account:u1');
  assert.equal(parked.reason, 'error_threshold');
  assert.ok(parked.cooldownUntil > Date.now());
  await assert.rejects(call(), e => e.code === 'no_available_account'); // parked account is skipped
});

test('regression: models falls back to the static table when upstream is unusable', async () => {
  const env = {}; const c = makeCoordinator(env); // no accounts at all
  const res = await c.models();
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.equal(body.source, 'static');
  assert.equal(body.data.length, 19);
  assert.ok(body.data.some(m => m.id === 'glm-5'));
});

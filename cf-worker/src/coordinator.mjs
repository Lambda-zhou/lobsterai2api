import { GatewayError, json, errorResponse, readJSON, normalizeAccount, jwtExpiry, prepareChat } from './protocol.mjs';
import { Upstream } from './upstream.mjs';

// Cooldown policy, aligned with the Go build (cmd/server/config.go defaults).
const HARD_CREDIT_COOLDOWN = 12 * 3600000; // no_credit: 12h
const SOFT_RATE_COOLDOWN = 60000;          // rate_limit / upstream 404: 60s
const ERR_THRESHOLD = 3;                   // consecutive transport/server errors before cooldown
const ERR_COOLDOWN = 10 * 60000;           // error_threshold / failed refresh: 10m
const MAX_ROTATE = 3;                      // accounts tried per chat request
const MODELS_TTL = 3600000;                // dynamic model list cache: 1h

// Errors that swapping accounts cannot fix: the request itself is unusable.
const NON_ROTATABLE = new Set(['invalid_request', 'configuration_error', 'cancelled']);

// Static model table, measured 2026-08-06 from GET /api/models/available (19 entries, same as the Go build).
const STATIC_MODEL_IDS = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'MiniMax-M3', 'MiniMax-M2.7', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
  'qwen3.5-plus-2026-04-20', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5',
  'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-code-preview-260215',
  'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'glm-5'
];
const STATIC_MODELS = STATIC_MODEL_IDS.map(id => ({ id, object: 'model', created: 1753600000, owned_by: 'lobsterai', context_length: 131072 }));

// All account mutations go through this explicit queue. DO awaits may otherwise interleave.
export class Coordinator {
  constructor(state, env) { this.state = state; this.env = env; this.storage = state.storage; this.upstream = new Upstream(env); this.tail = Promise.resolve(); this.cursor = 0; }
  locked(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async accounts() { return [...(await this.storage.list({ prefix: 'account:' })).values()]; }
  async save(a) { await this.storage.put(`account:${a.uid}`, a); }
  async refresh(a, force = false) {
    if (a.refreshPending) throw new GatewayError(503, 'refresh_uncertain', 'A previous refresh was interrupted; reimport fresh login credentials.');
    if (!force && (!a.expiresAt || a.expiresAt > Date.now() / 1000 + 120)) return a;
    if (!a.refreshToken) throw new GatewayError(401, 'credentials_expired', 'Reimport account with a refreshToken.');
    // Intent record makes a crash between upstream rotation and local save visible.
    a.refreshPending = true;
    await this.save(a);
    let result;
    try { result = await this.upstream.refresh(a); }
    catch (e) {
      // The intent flag must always be cleared: a transport failure (TypeError/AbortError, no
      // GatewayError) used to leave refreshPending set forever, silently dropping the account
      // from the pool until someone re-imported it.
      const code = e instanceof GatewayError ? e.code : 'refresh_transport_error';
      a.refreshPending = false;
      a.reason = code;
      if (code === 'session_dead' || code === 'unauthorized') a.disabled = true;
      else if (code !== 'credentials_expired') a.cooldownUntil = Math.max(a.cooldownUntil || 0, Date.now() + (code === 'no_credit' ? HARD_CREDIT_COOLDOWN : code === 'rate_limit' ? SOFT_RATE_COOLDOWN : ERR_COOLDOWN));
      await this.save(a);
      throw e;
    }
    a.accessToken = result.accessToken;
    if (typeof result.refreshToken === 'string' && result.refreshToken) a.refreshToken = result.refreshToken;
    a.expiresAt = Number(result.expiresIn) > 0 ? Math.floor(Date.now() / 1000) + Number(result.expiresIn) : jwtExpiry(result.accessToken);
    a.refreshPending = false;
    // Refresh repairs authentication, not quota/rate/error cooldowns: those are released by their
    // own expiry (or by a later successful chat for error_threshold), exactly like the Go build
    // where credentials and pool state live in separate stores.
    if (!['no_credit', 'rate_limit', 'error_threshold'].includes(a.reason)) a.reason = null;
    await this.save(a); // Must complete before the new credential is used.
    return a;
  }
  async pick(exclude = null) {
    const all = await this.accounts();
    // `exclude` holds the uids already tried by this request, so rotating never retries the same
    // account; accounts parked by the failure we just recorded are filtered out too.
    const available = all.filter(a => !a.disabled && !a.refreshPending && (a.cooldownUntil || 0) <= Date.now() && !(exclude && exclude.has(a.uid)));
    if (!available.length) throw new GatewayError(503, 'no_available_account', 'No available account; inspect authenticated admin status.');
    const a = available[this.cursor++ % available.length];
    return this.refresh(a);
  }
  async markFailure(a, e) {
    const code = e.code || 'transport_error';
    a.reason = code;
    if (code === 'session_dead' || code === 'unauthorized') a.disabled = true;
    else if (code === 'no_credit') a.cooldownUntil = Date.now() + HARD_CREDIT_COOLDOWN;
    else if (code === 'rate_limit') a.cooldownUntil = Date.now() + SOFT_RATE_COOLDOWN;
    else {
      // Unknown/transport/server errors accumulate: after ERR_THRESHOLD in a row the account is
      // parked for ERR_COOLDOWN instead of being hammered on every request.
      a.errCount = (a.errCount || 0) + 1;
      if (a.errCount >= ERR_THRESHOLD) { a.cooldownUntil = Date.now() + ERR_COOLDOWN; a.reason = 'error_threshold'; }
    }
    await this.save(a);
  }
  async markSuccess(a) {
    if (!a.errCount && a.reason !== 'error_threshold') return;
    a.errCount = 0;
    if (a.reason === 'error_threshold') a.reason = null;
    await this.save(a);
  }
  async chat(request) {
    const body = prepareChat(await readJSON(request));
    const tried = new Set();
    let lastError = null;
    // Rotate accounts on quota/rate/server failures (Go parity); only request-level errors abort.
    for (let i = 0; i < MAX_ROTATE; i++) {
      let a;
      try { a = await this.pick(tried); }
      catch (e) { throw lastError || e; }
      tried.add(a.uid);
      if (request.signal?.aborted) throw new GatewayError(499, 'cancelled', 'Request cancelled.');
      try {
        const response = await this.upstream.chat(a, body, request.signal);
        await this.markSuccess(a);
        return response;
      } catch (e) {
        lastError = e;
        if (e.code === 'unauthorized' && a.refreshToken) {
          try {
            await this.refresh(a, true);
            const response = await this.upstream.chat(a, body, request.signal);
            await this.markSuccess(a);
            return response;
          } catch (retryError) {
            lastError = retryError;
            await this.markFailure(a, retryError);
            if (NON_ROTATABLE.has(retryError.code)) throw retryError;
            continue;
          }
        }
        // A retry after SSE bytes already left the DO would duplicate output, so stream-level
        // failures (post-headers) only rotate when nothing was written yet; those carry
        // upstream_stream_error/response_too_large and are marked as received failures.
        await this.markFailure(a, e);
        if (NON_ROTATABLE.has(e.code)) throw e;
        continue;
      }
    }
    throw lastError || new GatewayError(503, 'no_available_account', 'All candidate accounts failed.');
  }
  async models() {
    const cached = await this.storage.get('modelsCache');
    if (cached && cached.until > Date.now() && Array.isArray(cached.data)) return json({ object: 'list', data: cached.data });
    try {
      const a = await this.pick();
      const q = new URLSearchParams({ firstKeyfrom: a.firstKeyfrom || '', latestKeyfrom: a.latestKeyfrom || '', version: '0.1.0' });
      if (a.uuid) q.set('uuid', a.uuid);
      if (a.userId) q.set('userId', a.userId);
      const data = await this.upstream.api('/api/models/available?' + q, { token: a.accessToken });
      if (!Array.isArray(data)) throw new GatewayError(502, 'invalid_models', 'Upstream models response is not an array.');
      const list = data.filter(m => typeof m.modelId === 'string').map(m => ({ id: m.modelId, object: 'model', created: 0, owned_by: m.provider || 'lobsterai' }));
      if (!list.length) throw new GatewayError(502, 'invalid_models', 'Upstream returned an empty model list.');
      await this.storage.put('modelsCache', { until: Date.now() + MODELS_TTL, data: list });
      return json({ object: 'list', data: list });
    } catch (e) {
      // Serve the static fallback so clients can still start up when the dynamic endpoint is down.
      return json({ object: 'list', data: STATIC_MODELS, source: 'static', error: e.code || 'models_unavailable' });
    }
  }
  // Re-import must refresh credentials without wiping pool state (cooldowns, credits, check-in keys).
  mergeAccount(old, next) {
    if (!old) return next;
    const merged = { ...old, ...next };
    const cooling = (old.cooldownUntil || 0) > Date.now() && ['no_credit', 'rate_limit', 'error_threshold'].includes(old.reason);
    merged.cooldownUntil = cooling ? old.cooldownUntil : 0;
    merged.reason = cooling ? old.reason : null;
    merged.errCount = cooling ? (old.errCount || 0) : 0;
    merged.credits = old.credits ?? next.credits ?? null;
    merged.checkinDay = old.checkinDay;
    merged.checkinKey = old.checkinKey;
    merged.lastMaintenance = old.lastMaintenance;
    // A successful re-import means the operator supplied fresh credentials: clear the trip flags.
    merged.disabled = false;
    merged.refreshPending = false;
    return merged;
  }
  async bootstrapAccounts() {
    const raw = this.env.LB2A_AUTHS;
    if (raw === undefined || raw === null || raw === '') return;
    let docs;
    try {
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 1048576) throw new Error();
      const input = JSON.parse(raw);
      docs = Array.isArray(input) ? input : [input];
      if (!docs.length || docs.length > 20) throw new Error();
      docs = docs.map(normalizeAccount);
      if (new Set(docs.map(a => a.uid)).size !== docs.length) throw new Error();
    } catch {
      throw new GatewayError(503, 'configuration_error', 'LB2A_AUTHS must contain 1–20 valid, unique account objects.');
    }
    const existing = await this.accounts();
    const previous = new Map(existing.map(a => [a.uid, a]));
    if (new Set([...previous.keys(), ...docs.map(a => a.uid)]).size > 20) {
      throw new GatewayError(503, 'configuration_error', 'LB2A_AUTHS would exceed the 20-account pool limit.');
    }
    const writes = {};
    for (const a of docs) {
      // Hash normalized credentials, not raw JSON: whitespace/order changes and adding
      // another account must never restore old tokens over a refreshed account.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(a)));
      const fingerprint = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const marker = `secret-import:${a.uid}`;
      if (await this.storage.get(marker) === fingerprint) continue;
      writes[`account:${a.uid}`] = this.mergeAccount(previous.get(a.uid), a);
      writes[marker] = fingerprint;
    }
    // One atomic multi-key write: credentials and their dedup marker commit together.
    // Deleting the Secret (or an entry) does not delete the persisted accounts.
    if (Object.keys(writes).length) await this.storage.put(writes);
  }
  async importAccounts(request) {
    const input = await readJSON(request);
    const docs = Array.isArray(input) ? input : [input];
    if (!docs.length || docs.length > 20) throw new GatewayError(400, 'account_limit', 'Import 1–20 accounts per request.');
    const accounts = docs.map(normalizeAccount);
    if (new Set(accounts.map(a => a.uid)).size !== accounts.length) throw new GatewayError(400, 'duplicate_uid', 'Duplicate account uid in import.');
    const existing = await this.accounts();
    if (new Set([...existing, ...accounts].map(a => a.uid)).size > 20) throw new GatewayError(400, 'account_limit', 'This initial release supports at most 20 accounts.');
    const previous = new Map(existing.map(a => [a.uid, a]));
    // Atomic upsert; never deletes accounts absent from the submitted batch.
    await this.storage.put(Object.fromEntries(accounts.map(a => [`account:${a.uid}`, this.mergeAccount(previous.get(a.uid), a)])));
    return json({ imported: accounts.map(a => a.uid), total: new Set([...existing, ...accounts].map(a => a.uid)).size });
  }
  async status() {
    return json({ accounts: (await this.accounts()).map(a => ({ uid: a.uid, disabled: a.disabled, expiresAt: a.expiresAt, refreshPending: !!a.refreshPending, cooldownUntil: a.cooldownUntil, reason: a.reason, credits: a.credits ?? null, lastMaintenance: a.lastMaintenance ?? null })), maintenance: await this.storage.get('maintenance') || null });
  }
  async startMaintenance() {
    const old = await this.storage.get('maintenance');
    if (old?.pending?.length) { await this.storage.setAlarm(Date.now() + 1000); return json({ status: 'already_queued' }, 202); }
    const accounts = (await this.accounts()).filter(a => !a.disabled && !a.refreshPending);
    const job = { pending: accounts.map(a => a.uid), startedAt: Date.now(), completedAt: null };
    // Alarm first, then durable queue: a failure cannot leave a queue without a wakeup.
    await this.storage.setAlarm(Date.now() + 1000);
    await this.storage.put('maintenance', job);
    return json({ status: 'queued', accounts: accounts.length }, 202);
  }
  async maintain(a) {
    if (a.disabled || a.refreshPending) return;
    const report = { at: Date.now() };
    try {
      await this.refresh(a, !!a.refreshToken);
      // Persist the same idempotency key for retries within the Beijing calendar day.
      const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (a.checkinDay !== day) { a.checkinDay = day; a.checkinKey = crypto.randomUUID(); await this.save(a); }
      report.checkin = await this.upstream.checkin(a, a.checkinKey);
    } catch (e) { report.error = e.code || 'maintenance_transport_error'; }
    if (!a.refreshPending && !a.disabled) {
      try {
        const p = await this.upstream.api('/api/user/profile-summary', { token: a.accessToken });
        if (!Number.isFinite(p.totalCreditsRemaining)) throw new GatewayError(502, 'invalid_balance', 'No numeric balance.');
        a.credits = p.totalCreditsRemaining;
        if (a.credits > 0 && a.reason === 'no_credit') { a.cooldownUntil = 0; a.reason = null; }
      } catch (e) { report.balanceError = e.code || 'balance_transport_error'; }
    }
    a.lastMaintenance = report;
    await this.save(a);
  }
  async alarm() {
    return this.locked(async () => {
      const job = await this.storage.get('maintenance');
      if (!job || !job.pending.length) return;
      const uid = job.pending[0], a = await this.storage.get(`account:${uid}`);
      if (a) await this.maintain(a);
      job.pending.shift();
      if (job.pending.length) await this.storage.setAlarm(Date.now() + 1000);
      else job.completedAt = Date.now();
      await this.storage.put('maintenance', job);
    });
  }
  async fetch(request) {
    return this.locked(async () => {
      try {
        const path = new URL(request.url).pathname;
        await this.bootstrapAccounts();
        if (path === '/v1/chat/completions' && request.method === 'POST') return await this.chat(request);
        if (path === '/v1/models' && request.method === 'GET') return await this.models();
        if (path === '/admin/accounts' && request.method === 'POST') return await this.importAccounts(request);
        if (path === '/admin/status' && request.method === 'GET') return await this.status();
        if (path === '/admin/maintenance' && request.method === 'POST') return await this.startMaintenance();
        return json({ error: { message: 'Not found.' } }, 404);
      } catch (e) { return errorResponse(e); }
    });
  }
}

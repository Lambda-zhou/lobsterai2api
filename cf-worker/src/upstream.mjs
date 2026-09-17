import { GatewayError, classify, readTextBounded } from './protocol.mjs';

const UPDATE_API = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update';
export class Upstream {
  constructor(env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; this.cachedVersion = null; }
  base() {
    const url = new URL(this.env.UPSTREAM_BASE || 'https://lobsterai-server.youdao.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new GatewayError(503, 'configuration_error', 'UPSTREAM_BASE must be an HTTPS origin.');
    return url.origin;
  }
  headers(token, version = '0.1.0') {
    return { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `LobsterAI/${version}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  async jsonURL(url, { method = 'GET', token, body, version = '0.1.0' } = {}) {
    const response = await this.fetcher(url, { method, redirect: 'error', headers: this.headers(token, version), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const raw = await readTextBounded(response.body);
    let data;
    try { data = JSON.parse(raw); } catch { throw new GatewayError(502, 'invalid_upstream_json', 'Upstream did not return JSON.'); }
    if (!response.ok || (data.code !== undefined && data.code !== 0)) {
      const kind = classify(response.status, data);
      const status = kind === 'rate_limit' ? 429 : kind === 'no_credit' ? 402 : ['session_dead', 'unauthorized'].includes(kind) ? 401 : 502;
      throw new GatewayError(status, kind, `Upstream operation failed (${kind}).`);
    }
    return data;
  }
  async api(path, options) {
    const data = await this.jsonURL(this.base() + path, options);
    if (data.data === undefined || data.data === null) throw new GatewayError(502, 'invalid_upstream_data', 'Upstream returned no data.');
    return data.data;
  }
  async refresh(a) {
    if (!a.refreshToken) throw new GatewayError(401, 'credentials_expired', 'Account needs new login credentials.');
    const body = { firstKeyfrom: a.firstKeyfrom || '', latestKeyfrom: a.latestKeyfrom || '', version: '0.1.0', refreshToken: a.refreshToken };
    if (a.uuid) body.uuid = a.uuid;
    if (a.userId) body.userId = a.userId;
    const envelope = await this.jsonURL(this.base() + '/api/auth/refresh', { method: 'POST', body });
    const result = envelope.data ?? envelope;
    if (typeof result.accessToken !== 'string' || !result.accessToken) throw new GatewayError(502, 'invalid_refresh', 'Refresh returned no accessToken; account requires review.');
    return result;
  }
  async version() {
    if (this.env.CLIENT_VERSION) {
      if (!/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(this.env.CLIENT_VERSION)) throw new GatewayError(503, 'configuration_error', 'Invalid CLIENT_VERSION.');
      return this.env.CLIENT_VERSION;
    }
    if (this.cachedVersion && this.cachedVersion.until > Date.now()) return this.cachedVersion.value;
    const data = await this.jsonURL(UPDATE_API);
    const value = data?.data?.value?.version;
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw new GatewayError(502, 'version_lookup_failed', 'Official update API returned no valid client version.');
    this.cachedVersion = { value, until: Date.now() + 3600000 };
    return value;
  }
  async checkin(a, idempotencyKey) {
    const version = await this.version();
    const q = new URLSearchParams({ placement: 'desktop_sidebar', clientVersion: version, containerApiVersion: '2', platform: 'win32' });
    const options = { token: a.accessToken, version };
    const slot = await this.api(`/api/client-activities/slot?${q}`, options);
    if (slot.slotState !== 'available' || !slot.activity) return { status: 'no_activity' };
    const { activityCode, configRevision } = slot.activity;
    if (typeof activityCode !== 'string' || configRevision === undefined) throw new GatewayError(502, 'invalid_activity', 'Invalid activity metadata.');
    const path = `/api/client-activities/${encodeURIComponent(activityCode)}`;
    const ctx = await this.api(`${path}/context?configRevision=${encodeURIComponent(configRevision)}`, options);
    if (ctx.state?.claimedToday) return { status: 'already_claimed' };
    if (!Array.isArray(ctx.actions) || !ctx.actions.includes('check_in')) return { status: 'not_claimable' };
    const result = await this.api(`${path}/actions/check_in`, { ...options, method: 'POST', body: { configRevision, idempotencyKey, payload: {} } });
    const r = result.result || {};
    const gained = [r.creditsGranted, r.rewardCredits, r.credits].find(Number.isFinite);
    return { status: 'claimed', ...(gained !== undefined ? { gained } : {}) };
  }
  // Header timeout ends once headers arrive; no artificial total SSE timeout.
  async chat(a, body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    try {
      const response = await this.fetcher(this.base() + '/api/proxy/v1/chat/completions', { method: 'POST', redirect: 'error', headers: { ...this.headers(a.accessToken), Accept: 'text/event-stream', 'X-LobsterAI-Client-Capabilities': 'kimi-k3-agentic-v1', 'X-LobsterAI-Client-Version': '0.1.0' }, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        // Bounded error body; also terminate stalled error bodies.
        const errorTimer = setTimeout(abort, 10000);
        try {
          const raw = await readTextBounded(response.body, 65536), kind = classify(response.status, raw);
          throw new GatewayError(response.status >= 400 && response.status < 500 ? response.status : 502, kind, `Chat rejected by upstream (${kind}).`);
        } finally { clearTimeout(errorTimer); }
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await response.body?.cancel();
        throw new GatewayError(502, 'unexpected_content_type', 'Expected upstream SSE stream.');
      }
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(c) {
          try { const v = await reader.read(); if (v.done) { cleanup(); c.close(); } else c.enqueue(v.value); }
          catch (e) { cleanup(); c.error(e); }
        },
        async cancel(reason) { controller.abort(); cleanup(); await reader.cancel(reason).catch(() => {}); }
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
    } catch (e) { controller.abort(); cleanup(); throw e; }
  }
}

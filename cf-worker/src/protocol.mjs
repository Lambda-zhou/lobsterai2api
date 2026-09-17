// Pure protocol helpers. No secrets, I/O or Cloudflare-specific imports.
export class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
export function errorResponse(e) {
  const known = e instanceof GatewayError;
  return json({ error: { message: known ? e.message : 'Internal or upstream transport failure; retry later.', type: known ? e.code : 'gateway_error', code: known ? e.code : 'gateway_error' } }, known ? e.status : 502);
}
export async function equalSecret(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const xx = new Uint8Array(x), yy = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xx.length; i++) diff |= xx[i] ^ yy[i];
  return diff === 0;
}
export async function readTextBounded(stream, limit = 1048576) {
  if (!stream) return '';
  const reader = stream.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new GatewayError(413, 'size_limit', 'Request or upstream response exceeds size limit.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
}
export async function readJSON(request, limit = 1048576) {
  try { return JSON.parse(await readTextBounded(request.body, limit)); }
  catch (e) { if (e instanceof GatewayError) throw e; throw new GatewayError(400, 'invalid_json', 'Invalid JSON body.'); }
}
export function jwtExpiry(token) {
  try {
    const s = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const n = JSON.parse(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '='))).exp;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
export function normalizeAccount(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new GatewayError(400, 'invalid_account', 'Each account must be an object.');
  const a = doc.auth || doc, meta = doc.account || doc;
  const uid = meta.uid || a.uid;
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_.@-]{1,128}$/.test(uid)) throw new GatewayError(400, 'invalid_account', 'Account uid is missing or invalid.');
  if (typeof a.accessToken !== 'string' || !a.accessToken.trim() || a.accessToken.length > 16384) throw new GatewayError(400, 'invalid_account', 'Account requires an accessToken.');
  const out = { uid, accessToken: a.accessToken, expiresAt: Number(a.expiresAt) || jwtExpiry(a.accessToken), disabled: false, cooldownUntil: 0, reason: null };
  for (const k of ['refreshToken', 'uuid', 'firstKeyfrom', 'latestKeyfrom']) {
    if (a[k] !== undefined && (typeof a[k] !== 'string' || a[k].length > 16384)) throw new GatewayError(400, 'invalid_account', 'Invalid credential field.');
    out[k] = a[k] || '';
  }
  out.userId = String(meta.userId || a.userId || '');
  return out;
}
export function prepareChat(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !body.model.trim() || !Array.isArray(body.messages) || !body.messages.length) throw new GatewayError(400, 'invalid_request', 'model and a nonempty messages array are required.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new GatewayError(400, 'invalid_request', 'stream must be boolean.');
  const out = { ...body, stream: true };
  if (out.tool_choice === 'none') { delete out.tools; delete out.tool_choice; }
  else if (out.tool_choice === '' || out.tool_choice === null) delete out.tool_choice;
  return out;
}
export function classify(status, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (/40100|40101|refresh token was rejected|token rejected/i.test(text)) return 'session_dead';
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limit';
  if (status === 402 || /insufficient credit|no credit|quota exhaust|quota exceeded|积分不足|额度不足|余额不足/i.test(text)) return 'no_credit';
  return status >= 500 ? 'upstream_server' : 'upstream_rejected';
}

// Parse UTF-8 and SSE boundaries incrementally, preserving choice and tool indices.
// Require DONE or explicit finish reasons: a broken connection must not become a fake success.
export async function aggregateSSE(stream, { maxBytes = 8388608, signal } = {}) {
  if (!stream) throw new GatewayError(502, 'empty_stream', 'Upstream returned no stream.');
  const reader = stream.getReader(), decoder = new TextDecoder();
  const choices = new Map();
  let buffer = '', eventLines = [], bytes = 0, finished = false, seen = false;
  let id = '', model = '', created = 0, usage;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  function event() {
    if (!eventLines.length) return;
    const payload = eventLines.join('\n'); eventLines = [];
    if (payload.trim() === '[DONE]') { finished = true; return; }
    let obj;
    try { obj = JSON.parse(payload); } catch { throw new GatewayError(502, 'invalid_sse', 'Malformed upstream SSE JSON.'); }
    if (obj.error) throw new GatewayError(502, 'upstream_stream_error', 'Upstream reported an error within the stream.');
    id ||= obj.id || ''; model ||= obj.model || ''; created ||= obj.created || 0;
    if (obj.usage) usage = obj.usage;
    for (const c of obj.choices || []) {
      const index = c.index ?? 0;
      if (!Number.isInteger(index) || index < 0) throw new GatewayError(502, 'invalid_sse', 'Invalid choice index.');
      seen = true;
      if (!choices.has(index)) choices.set(index, { index, message: { role: 'assistant', content: '' }, finish_reason: null, tools: new Map() });
      const dst = choices.get(index), delta = c.delta || c.message || {};
      if (delta.role) dst.message.role = delta.role;
      if (typeof delta.content === 'string') dst.message.content += delta.content;
      if (typeof delta.reasoning_content === 'string') dst.message.reasoning_content = (dst.message.reasoning_content || '') + delta.reasoning_content;
      if (c.finish_reason !== undefined && c.finish_reason !== null) dst.finish_reason = c.finish_reason;
      for (const t of delta.tool_calls || []) {
        const ti = t.index ?? 0;
        if (!Number.isInteger(ti) || ti < 0) throw new GatewayError(502, 'invalid_sse', 'Invalid tool index.');
        if (!dst.tools.has(ti)) dst.tools.set(ti, { id: '', type: 'function', function: { name: '', arguments: '' } });
        const target = dst.tools.get(ti);
        if (t.id) target.id = t.id;
        if (t.type) target.type = t.type;
        if (t.function?.name) target.function.name = t.function.name;
        if (typeof t.function?.arguments === 'string') target.function.arguments += t.function.arguments;
      }
    }
  }
  function line(s) {
    if (s.endsWith('\r')) s = s.slice(0, -1);
    if (!s) event();
    else if (s.startsWith('data:')) eventLines.push(s.slice(5).replace(/^ /, ''));
  }
  try {
    if (signal?.aborted) throw new GatewayError(499, 'cancelled', 'Request cancelled.');
    while (!finished) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new GatewayError(499, 'cancelled', 'Request cancelled.');
      if (done) { buffer += decoder.decode(); if (buffer) line(buffer); event(); break; }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new GatewayError(502, 'response_too_large', 'Aggregated response exceeds limit; use stream=true.');
      buffer += decoder.decode(value, { stream: true });
      let pos;
      while (!finished && (pos = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); }
    }
    if (!seen || (!finished && [...choices.values()].some(c => c.finish_reason === null))) throw new GatewayError(502, 'incomplete_stream', 'Upstream stream ended without a completion marker.');
    return { id: id || `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: created || Math.floor(Date.now() / 1000), model, choices: [...choices.values()].sort((a, b) => a.index - b.index).map(({ tools, ...c }) => {
      if (tools.size) c.message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
      return c;
    }), ...(usage ? { usage } : {}) };
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

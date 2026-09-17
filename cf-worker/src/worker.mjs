import { GatewayError, json, errorResponse, equalSecret, readJSON, prepareChat, aggregateSSE } from './protocol.mjs';
export { Coordinator } from './coordinator.mjs';

function coordinator(env) {
  if (!env.COORDINATOR) throw new GatewayError(503, 'configuration_error', 'Missing Durable Object binding.');
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('primary'));
}
function configured(env) {
  if (typeof env.API_KEY !== 'string' || env.API_KEY.length < 32 || typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < 32 || env.API_KEY === env.ADMIN_KEY) throw new GatewayError(503, 'configuration_error', 'Configure distinct API_KEY and ADMIN_KEY secrets of at least 32 characters.');
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (path === '/health' && request.method === 'GET') return json({ status: 'alive', note: 'Liveness only; not upstream readiness.' });
      configured(env);
      const routes = { '/v1/models': 'GET', '/v1/chat/completions': 'POST', '/admin/accounts': 'POST', '/admin/status': 'GET', '/admin/maintenance': 'POST' };
      if (!routes[path]) return json({ error: { message: 'Not found.' } }, 404);
      if (request.method !== routes[path]) return json({ error: { message: 'Method not allowed.' } }, 405, { Allow: routes[path] });
      const supplied = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
      if (!await equalSecret(supplied, path.startsWith('/admin/') ? env.ADMIN_KEY : env.API_KEY)) return json({ error: { message: 'Invalid bearer key.', type: 'authentication_error' } }, 401, { 'www-authenticate': 'Bearer' });
      const stub = coordinator(env);
      if (path === '/v1/chat/completions') {
        const body = await readJSON(request);
        prepareChat(body); // Validate before reaching the serialized coordinator.
        const response = await stub.fetch(new Request('https://coordinator' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal }));
        if (!response.ok || body.stream === true) return response;
        // Aggregation is outside the DO lock, so a long answer does not block refresh.
        return json(await aggregateSSE(response.body, { signal: request.signal }));
      }
      if (path === '/admin/accounts') {
        const docs = await readJSON(request);
        return await stub.fetch(new Request('https://coordinator' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(docs) }));
      }
      return await stub.fetch(new Request('https://coordinator' + path, { method: request.method }));
    } catch (e) { return errorResponse(e); }
  },
  async scheduled(_controller, env, ctx) {
    configured(env);
    ctx.waitUntil((async () => {
      const response = await coordinator(env).fetch(new Request('https://coordinator/admin/maintenance', { method: 'POST' }));
      if (!response.ok) throw new Error('Failed to queue scheduled maintenance.');
      await response.body?.cancel();
    })());
  }
};

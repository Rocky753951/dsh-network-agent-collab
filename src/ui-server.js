import { createServer } from 'node:http';

const MAX_BYTES = 32 * 1024;

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function bodyOf(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REQUEST_BODY_INVALID');
  return value;
}

export function createUiHandler(api, prefix = '') {
  return async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, null);
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname.slice(prefix.length) || '/';
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/snapshot') return json(res, 200, await api.snapshot());
      if (req.method === 'GET' && path === '/setup/status') {
        if (typeof api.setupStatus !== 'function') return json(res, 404, { error: 'NOT_FOUND' });
        return json(res, 200, await api.setupStatus());
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'NOT_FOUND' });
      const args = await bodyOf(req);
      const routes = {
        '/approve': 'approve', '/message': 'message', '/activate': 'activate', '/task': 'task',
        '/setup': 'setup', '/host/create': 'hostCreate', '/join/request': 'joinRequest',
        '/join/decide': 'joinDecide', '/direct/offer': 'directOffer', '/direct/answer': 'directAnswer', '/direct/grant': 'directGrant',
        '/members/remove': 'membersRemove', '/pair/leave': 'pairLeave',
        '/relay/retry': 'relayRetry',
      };
      const method = routes[path];
      if (!method || typeof api[method] !== 'function') return json(res, 404, { error: 'NOT_FOUND' });
      return json(res, 200, await api[method](args));
    } catch (error) {
      json(res, 400, { error: error?.message || 'BAD_REQUEST' });
    }
  };
}

/** Loopback-only fallback bridge for direct local development. */
export function startUiServer({ port = 8788, api }) {
  const server = createServer(createUiHandler(api));
  server.listen(port, '127.0.0.1');
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

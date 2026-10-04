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
      if (req.method !== 'POST') return json(res, 404, { error: 'NOT_FOUND' });
      const args = await bodyOf(req);
      if (path === '/approve') return json(res, 200, await api.approve(args));
      if (path === '/message') return json(res, 200, await api.message(args));
      if (path === '/activate') return json(res, 200, await api.activate(args));
      if (path === '/task') return json(res, 200, await api.task(args));
      return json(res, 404, { error: 'NOT_FOUND' });
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

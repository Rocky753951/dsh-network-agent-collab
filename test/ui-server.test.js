import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createUiHandler } from '../src/ui-server.js';

async function withServer(api, run) {
  const server = createServer(createUiHandler(api));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

for (const [path, method] of [
  ['/setup', 'setup'], ['/host/create', 'hostCreate'], ['/join/request', 'joinRequest'],
  ['/join/decide', 'joinDecide'], ['/members/remove', 'membersRemove'], ['/pair/leave', 'pairLeave'], ['/relay/retry', 'relayRetry'],
]) test(`routes POST ${path} to ${method}`, async () => {
  const calls = [];
  await withServer({ [method]: async (args) => { calls.push(args); return { method }; } }, async (base) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: path }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method });
  });
  assert.deepEqual(calls, [{ value: path }]);
});

test('routes GET /setup/status and returns 404 for unavailable routes', async () => {
  await withServer({ setupStatus: async () => ({ stage: 'ready' }) }, async (base) => {
    const good = await fetch(`${base}/setup/status`);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { stage: 'ready' });
    const missing = await fetch(`${base}/host/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'NOT_FOUND' });
  });
});

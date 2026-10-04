import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SetupState } from '../src/setup-state.js';

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-collab-setup-'));
  const setup = new SetupState({ path: join(dir, 'setup.json'), identityPath: join(dir, 'identity.json'), displayName: 'Desk' });
  await setup.load();
  return { setup, dir };
}

test('setup state retains identity and redacts secrets', async () => {
  const { setup, dir } = await manager();
  const identity = setup.status().identity;
  await setup.configure({ network: 'lan', lanTransport: 'tailscale', role: 'host', groupName: 'Home' });
  const result = await setup.createHost({ transport: 'tailscale', endpoint: 'ws://home.tailnet:8787', now: 1000, ttlMs: 300_000 });
  assert.equal(result.status.group.name, 'Home');
  const secret = setup.pairing().secret;
  assert.ok(secret);
  assert.equal(JSON.stringify(result.status).includes(secret), false);
  assert.equal(JSON.stringify(result.status).includes(result.invite.signature), false);
  const reloaded = new SetupState({ path: join(dir, 'setup.json'), identityPath: join(dir, 'identity.json') });
  await reloaded.load();
  assert.equal(reloaded.status().identity.id, identity.id);
  assert.equal((await stat(join(dir, 'setup.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'setup.json'), 'utf8'), /"secret"/);
});

test('setup state validates modes and leaving clears pairing', async () => {
  const { setup } = await manager();
  await assert.rejects(() => setup.configure({ network: 'lan', lanTransport: 'bad', role: 'host' }), /SETUP_LAN_TRANSPORT_INVALID/);
  await setup.configure({ network: 'public', role: 'host', groupName: 'P2P' });
  await assert.rejects(() => setup.createHost({ transport: 'lan', endpoint: 'wss://x' }), /SETUP_TRANSPORT_MISMATCH/);
  await setup.createHost({ transport: 'public', endpoint: 'wss://x', now: 1000 });
  const before = setup.status().identity.id;
  await setup.leave();
  assert.equal(setup.status().configured, false);
  assert.equal(setup.status().group, null);
  assert.equal(setup.status().identity.id, before);
});

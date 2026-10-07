import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodePairingInvite } from '../src/onboarding.js';
import { SetupState } from '../src/setup-state.js';

async function state(label) {
  const dir = await mkdtemp(join(tmpdir(), `dsh-collab-${label}-`));
  const value = new SetupState({ path: join(dir, 'setup.json'), identityPath: join(dir, 'identity.json'), displayName: label });
  await value.load(); return value;
}

test('client receives room material only after host approval and client confirmation', async () => {
  const host = await state('Host');
  const client = await state('Client');
  await host.configure({ network: 'lan', lanTransport: 'local', role: 'host' });
  const created = await host.createHost({ transport: 'local', endpoint: 'ws://host.local:8787', now: 1_000_000, ttlMs: 60_000 });
  await client.configure({ network: 'lan', lanTransport: 'local', role: 'client' });
  const prepared = await client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: 1_000_001 });
  assert.equal(client.pairing(), null);
  await host.receiveJoinRequest({ request: prepared.request, now: 1_000_002 });
  const pending = host.status().pendingRequests[0];
  assert.ok(pending);
  const approved = await host.decideJoin({ requestId: pending.id, decision: 'approved', now: 1_000_003 });
  assert.ok(approved.grant.secret);
  await client.acceptJoinGrant({ grant: approved.grant, now: 1_000_004 });
  assert.equal(client.pairing().roomId, host.pairing().roomId);
  assert.equal(client.pairing().secret, host.pairing().secret);
  assert.equal(JSON.stringify(client.status()).includes(host.pairing().secret), false);
  await assert.rejects(() => host.receiveJoinRequest({ request: prepared.request, now: 1_000_004 }), /PAIRING_INVITE_ALREADY_USED/);
});

test('host member removal is visible in status and rotates the room secret', async () => {
  const host = await state('Host-remove'); const client = await state('Client-remove');
  await host.configure({ network: 'lan', lanTransport: 'local', role: 'host' });
  const created = await host.createHost({ transport: 'local', endpoint: 'ws://host.local:8787', now: 2_000_000, ttlMs: 60_000 });
  await client.configure({ network: 'lan', lanTransport: 'local', role: 'client' });
  const prepared = await client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: 2_000_001 });
  await host.receiveJoinRequest({ request: prepared.request, now: 2_000_002 });
  const pending = host.status().pendingRequests[0];
  const approved = await host.decideJoin({ requestId: pending.id, decision: 'approved', now: 2_000_003 });
  const previousSecret = host.pairing().secret;
  assert.equal(host.status().members[0].id, client.status().identity.id);
  const status = await host.removeMember({ memberId: client.status().identity.id });
  assert.equal(status.members.length, 0);
  assert.notEqual(host.pairing().secret, previousSecret);
  assert.notEqual(host.pairing().secret, approved.grant.secret);
});

test('once grants remain valid until confirmation and are consumed once', async () => {
  const host = await state('Host-once'); const client = await state('Client-once');
  const now = Date.now();
  await host.configure({ network: 'lan', lanTransport: 'local', role: 'host' });
  const created = await host.createHost({ transport: 'local', endpoint: 'ws://host.local:8787', now, ttlMs: 60_000 });
  await client.configure({ network: 'lan', lanTransport: 'local', role: 'client' });
  const prepared = await client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: now + 1 });
  await host.receiveJoinRequest({ request: prepared.request, now: now + 2 });
  const approved = await host.decideJoin({ requestId: prepared.request.id, decision: 'approved', now: now + 3 });
  assert.equal(approved.grant.expiresAt, null);
  await client.acceptJoinGrant({ grant: approved.grant, now: now + 5 });
  assert.equal(client.pairing().roomId, host.pairing().roomId);
  await assert.rejects(() => client.acceptJoinGrant({ grant: approved.grant, now: now + 6 }), /PAIRING_CLIENT_CONFIRMATION_REQUIRED/);
});

test('client rejects forged or tampered host grants', async () => {
  const host = await state('Host'); const client = await state('Client');
  await host.configure({ network: 'lan', lanTransport: 'local', role: 'host' });
  const created = await host.createHost({ transport: 'local', endpoint: 'ws://host.local:8787', now: 2_000_000, ttlMs: 60_000 });
  await client.configure({ network: 'lan', lanTransport: 'local', role: 'client' });
  const prepared = await client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: 2_000_001 });
  await host.receiveJoinRequest({ request: prepared.request, now: 2_000_002 });
  const approved = await host.decideJoin({ requestId: prepared.request.id, decision: 'approved', now: 2_000_003 });
  for (const field of ['hostId', 'roomId', 'secret', 'endpoint']) {
    const forged = { ...approved.grant, [field]: field === 'secret' ? 'A'.repeat(43) : `forged-${field}` };
    await assert.rejects(() => client.acceptJoinGrant({ grant: forged }), /PAIRING_GRANT_INVALID/);
  }
  // An attacker who knows every invitation field still cannot produce an Ed25519 signature.
  await assert.rejects(() => client.acceptJoinGrant({ grant: { ...approved.grant, signature: Buffer.alloc(64, 7).toString('base64url') } }), /PAIRING_GRANT_INVALID/);
});

test('expired and rejected pairing requests cannot deliver grants', async () => {
  const host = await state('Host'); const client = await state('Client');
  await host.configure({ network: 'lan', role: 'host' });
  const created = await host.createHost({ transport: 'local', endpoint: 'ws://host:1', now: 10_000, ttlMs: 30_000 });
  await client.configure({ network: 'lan', role: 'client' });
  await assert.rejects(() => client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: 40_001 }), /PAIRING_INVITE_INVALID/);
  const prepared = await client.requestJoin({ invitation: encodePairingInvite(created.invite), code: created.pairingCode, now: 10_001 });
  await host.receiveJoinRequest({ request: prepared.request, now: 10_002 });
  const rejected = await host.decideJoin({ requestId: prepared.request.id, decision: 'rejected' });
  assert.equal(rejected.decision, 'rejected');
  await assert.rejects(() => client.acceptJoinGrant({ grant: {} }), /PAIRING_GRANT_INVALID/);
});

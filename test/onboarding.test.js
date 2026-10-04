import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPairingCode, createPairingInvite, decodePairingInvite, encodePairingInvite, loadOrCreateLocalIdentity, validatePairingInvite, verifyPairingCode } from '../src/onboarding.js';

test('local identity is durable and contains a 256-bit pairing secret', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dsh-collab-identity-')), 'identity.json');
  const first = await loadOrCreateLocalIdentity(path, { name: 'Workstation' });
  const second = await loadOrCreateLocalIdentity(path, { name: 'Ignored later name' });
  assert.equal(first.id, second.id);
  assert.equal(first.secret, second.secret);
  assert.equal(first.name, 'Workstation');
  assert.ok(Buffer.from(first.secret, 'base64url').length >= 32);
  assert.match(await readFile(path, 'utf8'), /agent-/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('pairing invite is short lived, serializable and code gated', () => {
  const now = 1_000_000;
  const identity = { id: 'agent-host', name: 'Host', secret: 'A'.repeat(43) };
  const invite = createPairingInvite({ identity, endpoint: 'wss://host.example/collab', now, ttlMs: 60_000, code: '004201' });
  assert.equal(validatePairingInvite(invite, now), null);
  assert.equal(verifyPairingCode(invite, '004201', now), null);
  assert.equal(verifyPairingCode(invite, '004202', now), 'pairing code mismatch');
  const decoded = decodePairingInvite(encodePairingInvite(invite), now);
  assert.equal(decoded.id, invite.id);
  assert.equal(validatePairingInvite(invite, now + 60_001), 'pairing invite expired');
});

test('pairing codes are six decimal digits', () => {
  for (let index = 0; index < 10; index += 1) assert.match(createPairingCode(), /^\d{6}$/);
});

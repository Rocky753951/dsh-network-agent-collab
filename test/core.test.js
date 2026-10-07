import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyEnvelope, createEnvelope, defaultState, FederationClient, JsonStore, validateEnvelope } from '../src/core.js';

const base = { roomId: 'alpha', sender: 'agent-a', secret: 'correct horse battery staple' };

test('envelopes are canonical HMAC authenticated and expiry bounded', () => {
  const envelope = createEnvelope({ ...base, kind: 'message', body: { text: 'hello' }, timestamp: 1_000 });
  assert.equal(validateEnvelope(envelope, base.secret, 1_100), null);
  assert.equal(validateEnvelope({ ...envelope, body: { text: 'tampered' } }, base.secret, 1_100), 'invalid signature');
  assert.equal(validateEnvelope(envelope, base.secret, 1_000 + 300_001), 'timestamp outside permitted clock skew');
});

test('state application deduplicates and merges collaboration records', () => {
  const state = defaultState({ id: 'local', name: 'local', capabilities: [] });
  const message = createEnvelope({ ...base, kind: 'message', body: { text: 'ready', to: 'all', topic: 'ops' } });
  assert.equal(applyEnvelope(state, message), true);
  assert.equal(applyEnvelope(state, message), false);
  assert.equal(state.messages.length, 1);
  const task = createEnvelope({ ...base, kind: 'task', body: { id: 'T-1', action: 'create', title: 'Ship' } });
  assert.equal(applyEnvelope(state, task), true);
  assert.equal(state.tasks['T-1'].title, 'Ship');
  const activation = createEnvelope({ ...base, kind: 'activation', body: { id: 'A-1', target: 'local', title: 'Review', approvalLevel: 'peer' } });
  assert.equal(applyEnvelope(state, activation), true);
  const forgedApproval = createEnvelope({ ...base, kind: 'approval', body: { activationId: 'A-1', target: 'local', approvalLevel: 'peer', decision: 'approved' } });
  assert.equal(applyEnvelope(state, forgedApproval), true);
  assert.equal(state.activations['A-1'].approval, undefined);
  const approval = createEnvelope({ roomId: 'alpha', sender: 'local', secret: base.secret, kind: 'approval', body: { activationId: 'A-1', target: 'local', approvalLevel: 'peer', decision: 'approved' } });
  assert.equal(applyEnvelope(state, approval), true);
  assert.equal(state.activations['A-1'].approval, 'approved');
});

test('approved target activation invokes the local delivery bridge exactly once', async () => {
  const delivered = [];
  class FakeWebSocket { static OPEN = 1; }
  const client = new FederationClient({
    relayUrl: 'ws://relay.invalid', roomId: 'alpha', secret: base.secret,
    identity: { id: 'local', name: 'local', capabilities: [] },
    store: { async load(value) { return value; }, async save() {} }, WebSocketImpl: FakeWebSocket,
    onActivation: async (activation) => { delivered.push(activation); return { sessionId: 'session-1' }; },
  });
  client.state = defaultState(client.identity);
  const activation = createEnvelope({ ...base, kind: 'activation', body: { id: 'A-2', target: 'local', title: 'Work', approvalLevel: 'none' } });
  applyEnvelope(client.state, activation);
  assert.equal(await client.deliverActivation('A-2'), true);
  assert.equal(await client.deliverActivation('A-2'), false);
  assert.equal(delivered.length, 1);
  assert.equal(client.state.activations['A-2'].deliveryStatus, 'started');
});

test('host access remains valid after invitation TTL expires', async () => {
  const sent = [];
  const transport = { isOpen: () => true, send(value) { sent.push(value); }, setMessageHandler() {} };
  const client = new FederationClient({
    relayUrl: 'direct://manual', roomId: 'alpha', secret: base.secret,
    identity: { id: 'host', name: 'host', capabilities: [] }, transport,
    accessPermissionLevel: 'trusted', accessExpiresAt: null,
    store: { async load(value) { return value; }, async save() {} },
  });
  client.state = defaultState(client.identity);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 6 * 60 * 1000;
    await client.message({ text: 'still available' });
    assert.equal(sent.length, 1);
  } finally { Date.now = originalNow; }
});

test('wake-approval cannot downgrade activation to immediate execution', async () => {
  const sent = [];
  const transport = { isOpen: () => true, send(value) { sent.push(JSON.parse(value)); }, setMessageHandler() {} };
  const client = new FederationClient({
    relayUrl: 'direct://manual', roomId: 'alpha', secret: base.secret,
    identity: { id: 'sender', name: 'sender', capabilities: [] }, transport,
    accessPermissionLevel: 'wake-approval', store: { async load(value) { return value; }, async save() {} },
  });
  client.state = defaultState(client.identity);
  await client.activate({ target: 'receiver', title: 'Work', approvalLevel: 'none' });
  assert.equal(sent[0].body.approvalLevel, 'peer');
});

test('paired ACL rejects forged and expired senders before state application', async () => {
  let receive;
  const transport = { isOpen: () => true, send() {}, setMessageHandler(handler) { receive = handler; } };
  const client = new FederationClient({
    relayUrl: 'direct://manual', roomId: 'alpha', secret: base.secret,
    identity: { id: 'local', name: 'local', capabilities: [] }, transport,
    allowedPeerIds: ['host'], peerExpiresAt: { host: Date.now() - 1 },
    store: { async load(value) { return value; }, async save() {} },
  });
  await client.start();
  const forged = createEnvelope({ roomId: 'alpha', sender: 'host', secret: base.secret, kind: 'message', body: { text: 'stale' } });
  await receive(JSON.stringify(forged));
  assert.equal(client.state.messages.length, 0);
});

test('JSON state storage writes a private atomic JSON document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-collab-'));
  const path = join(dir, 'state.json'); const store = new JsonStore(path);
  await store.save({ version: 1, peers: { a: { id: 'a' } } });
  assert.deepEqual(await store.load({ version: 0, peers: {} }), { version: 1, peers: { a: { id: 'a' } } });
  assert.match(await readFile(path, 'utf8'), /"version": 1/);
  await store.save({ version: 1, peers: {}, messages: [], tasks: {}, seenIds: [] });
  const migrated = await store.load(defaultState({ id: 'local', name: 'local', capabilities: [] }));
  assert.deepEqual(migrated.activations, {});
  assert.deepEqual(migrated.approvals, {});
});

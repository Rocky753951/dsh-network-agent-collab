import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createEnvelope } from '../src/core.js';
import { apply, ensureLocalSharedSecret, needsPublicReconnect, resolveNostrSignEvent } from '../index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('inbound approved activation creates a local agent and submits its prompt', async () => {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    static instance;
    constructor() {
      this.readyState = 0; this.listeners = new Map(); FakeWebSocket.instance = this;
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.emit('open', {}); });
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, event) { this.listeners.get(type)?.(event); }
    send() {}
    close() { this.readyState = 3; this.emit('close', {}); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const tools = []; let dispose;
  const created = []; const prompts = [];
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    effect(callback) { dispose = callback(); },
    agentLoop: { async create(id, options, meta) {
      created.push({ id, options, meta });
      return { id, followup(message) { prompts.push(message); } };
    } },
  };
  try {
    apply(ctx, {
      mode: 'lan', relayUrl: 'ws://test.invalid', roomId: 'room', agentId: 'receiver', agentName: 'Receiver',
      sharedSecret: '0123456789abcdef0123456789abcdef', dataDir: `/tmp/dsh-network-agent-collab-test-${Date.now()}`, 
      activationRuntime: { enabled: true, agentOptions: { maxTokens: 42 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const envelope = createEnvelope({
      roomId: 'room', sender: 'sender', kind: 'activation', secret: '0123456789abcdef0123456789abcdef',
      body: { id: 'activate-1', target: 'receiver', title: 'Review', detail: 'Check the release', approvalLevel: 'none' },
    });
    FakeWebSocket.instance.emit('message', { data: JSON.stringify(envelope) });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(tools.length, 7);
    const status = await tools.find((tool) => tool.name === 'network_agent_status').execute();
    assert.equal(status.activations['activate-1'].deliveryStatus, 'started');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].options, { maxTokens: 42 });
    assert.match(created[0].id, /^network-collab-activate-1$/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].content[0].text, /Requester: sender/);
    assert.match(prompts[0].content[0].text, /Check the release/);
  } finally {
    dispose?.(); globalThis.WebSocket = originalWebSocket;
  }
});

test('Nostr signer created with LAN defaults produces a cryptographically valid event', async () => {
  const signEvent = resolveNostrSignEvent({ networkScope: 'lan' });
  try {
    const event = await signEvent({ kind: 20000, created_at: 1, tags: [], content: 'test' });
    const expectedId = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest('hex');
    assert.equal(event.id, expectedId);
    assert.equal(schnorr.verify(event.sig, event.id, event.pubkey), true);
  } finally {
    signEvent.close?.();
  }
});

test('public Host setup auto-starts Nostr with static LAN plugin config', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-network-agent-public-host-'));
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => relay.once('listening', resolve));
  const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  relay.on('connection', (socket) => socket.on('message', (raw) => {
    const packet = JSON.parse(raw.toString());
    if (packet[0] === 'REQ') socket.send(JSON.stringify(['EOSE', packet[1]]));
  }));

  let uiHandler; let dispose;
  const ctx = {
    tools: { register() { return () => {}; } },
    agentLoop: { async create() { return { id: 'unused', followup() {} }; } },
    get(name) {
      if (name !== 'webServer') return undefined;
      return { register({ handler }) { uiHandler = handler; return () => {}; } };
    },
    effect(callback) { dispose = callback(); return dispose; },
  };
  let httpServer;
  try {
    apply(ctx, { mode: 'internet', networkScope: 'lan', dataDir, nostrRelays: [relayUrl], pairingTimeoutMs: 1000, ui: { enabled: true } });
    httpServer = createServer((req, res) => uiHandler(req, res));
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}/network-agent-collab`;
    const setup = await fetch(`${base}/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: 'public', role: 'host' }) });
    assert.equal(setup.status, 200);
    const created = await fetch(`${base}/host/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(created.status, 200);
    const result = await created.json();
    assert.equal(result.publicMode, 'nostr');
    assert.equal(result.automaticPairing, true);
    assert.equal(result.endpoint, `nostr://${relayUrl}`);
  } finally {
    dispose?.();
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => relay.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('public direct pairing requires explicit re-pair after restart', () => {
  assert.equal(needsPublicReconnect({ endpoint: 'direct://manual' }, null), true);
  assert.equal(needsPublicReconnect({ endpoint: 'direct://manual' }, { isOpen() { return false; } }), false);
  assert.equal(needsPublicReconnect({ endpoint: 'ws://127.0.0.1:8787' }, null), false);
});

test('plugin starts LAN setup without manual secrets and rejects invalid explicit secrets', () => {
  let dispose;
  const ctx = { agentLoop: { create() {} }, tools: { register() { return () => {}; } }, effect(callback) { dispose = callback(); return dispose; } };
  apply(ctx, { mode: 'lan' });
  assert.equal(typeof dispose, 'function');
  dispose();
  for (const sharedSecret of ['short', '1234567890123456789012345678901', 'CHANGE_ME']) {
    assert.throws(
      () => apply(ctx, { mode: 'lan', sharedSecret }),
      /LAN mode sharedSecret must be at least 32 bytes when provided/,
    );
  }
});

test('generated LAN secret permissions are repaired on reuse', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-network-agent-collab-secret-'));
  try {
    ensureLocalSharedSecret(stateDir);
    const secretPath = join(stateDir, 'shared-secret');
    assert.ok(Buffer.byteLength(readFileSync(secretPath, 'utf8').trim()) >= 32);
    chmodSync(secretPath, 0o644);
    ensureLocalSharedSecret(stateDir);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('plugin refuses to start without an Agent loop', () => {
  assert.throws(() => apply({ tools: { register() {} }, effect() {} }), /NETWORK_AGENT_COLLAB_REQUIRES_AGENT/);
});

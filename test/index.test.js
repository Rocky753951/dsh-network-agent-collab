import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvelope } from '../src/core.js';
import { apply } from '../index.js';

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

test('plugin refuses LAN mode without a sufficiently long shared secret', () => {
  const ctx = { agentLoop: { create() {} }, tools: { register() {} }, effect() {} };
  for (const sharedSecret of [undefined, 'short', '1234567890123456789012345678901']) {
    assert.throws(
      () => apply(ctx, { mode: 'lan', sharedSecret }),
      /LAN mode requires sharedSecret of at least 32 bytes/,
    );
  }
});

test('plugin refuses to start without an Agent loop', () => {
  assert.throws(() => apply({ tools: { register() {} }, effect() {} }), /NETWORK_AGENT_COLLAB_REQUIRES_AGENT/);
});

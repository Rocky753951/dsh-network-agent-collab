import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptNostrSignal, encryptNostrSignal, probeNostrRelay, startNostrSignal } from '../src/nostr-signal.js';
import { createEphemeralNostrSignEvent } from '../src/nostr-identity.js';
const key = Buffer.alloc(32, 7).toString('base64url');

test('Nostr signal envelope is authenticated and hides SDP', () => {
  const packet = encryptNostrSignal({ type: 'offer', sdp: 'secret-sdp' }, key);
  assert.equal(decryptNostrSignal(packet, key).sdp, 'secret-sdp'); assert.equal(decryptNostrSignal(`${packet}x`, key), null); assert.equal(JSON.stringify(packet).includes('secret-sdp'), false);
});

test('ephemeral Nostr signer creates a valid memory-only event signer', async () => {
  const signEvent = createEphemeralNostrSignEvent();
  const event = await signEvent({ kind: 20000, tags: [], content: 'encrypted' });
  assert.match(event.pubkey, /^[0-9a-f]{64}$/);
  assert.match(event.id, /^[0-9a-f]{64}$/);
  assert.match(event.sig, /^[0-9a-f]{128}$/);
  signEvent.close();
  await assert.rejects(() => signEvent({ kind: 20000, tags: [], content: 'closed' }), /NOSTR_SIGNER_CLOSED/);
});

class FakeWS {
  static OPEN = 1; static instances = [];
  constructor() { this.readyState = 1; this.handlers = {}; this.sent = []; FakeWS.instances.push(this); queueMicrotask(() => this.handlers.open?.()); }
  once(name, fn) { this.handlers[name] = fn; } on(name, fn) { this.handlers[name] = this.handlers[name] ? [this.handlers[name], fn] : fn; }
  send(value, cb) { const packet = JSON.parse(value); this.sent.push(packet); cb?.(); if (packet[0] === 'EVENT') queueMicrotask(() => this.emit(JSON.stringify(['OK', packet[1].id, true, '']))); }
  emit(value) { const fn = this.handlers.message; if (Array.isArray(fn)) fn.forEach((item) => item(value)); else fn?.(value); }
  close() { this.readyState = 3; }
}
const signer = async (event) => ({ ...event, id: 'a'.repeat(64), pubkey: 'b'.repeat(64), sig: 'c'.repeat(128) });

test('Nostr adapter publishes on one OK=true and validates session direction, expiry, sequence, nonce', async () => {
  FakeWS.instances = [];
  const signal = await startNostrSignal({ inviteId: 'a'.repeat(16), sessionKey: key, relays: ['wss://one'], role: 'client', signEvent: signer, onSignal() {}, WebSocketImpl: FakeWS });
  assert.equal((await signal.publish({ type: 'offer', sdp: 'x' })).relays, 1);
  const tag = signal.tag; const ws = FakeWS.instances[0]; const emit = (p, id) => ws.emit(JSON.stringify(['EVENT', { id, kind: 20000, tags: [['d', tag]], content: encryptNostrSignal(p, key) }]));
  const now = Date.now(); const base = { session: tag, role: 'host', seq: 1, nonce: 'n'.repeat(20), expiresAt: now + 10000, signal: { type: 'answer' } };
  emit(base, '1'); emit({ ...base, seq: 2 }, '2'); emit({ ...base, nonce: 'm'.repeat(20), expiresAt: now - 1 }, '3'); emit({ ...base, role: 'client', nonce: 'x'.repeat(20) }, '4');
  signal.close(); await assert.rejects(() => signal.publish({ type: 'x' }), /NOSTR_SIGNAL_CLOSED/);
});

test('session lifetime outlives relay operation timeout for delayed Grant', async () => {
  FakeWS.instances = [];
  let received;
  const signal = await startNostrSignal({ inviteId: 'b'.repeat(16), sessionKey: key, relays: ['wss://one'], role: 'client', signEvent: signer, timeoutMs: 5, sessionTtlMs: 100, onSignal(value) { received = value; }, WebSocketImpl: FakeWS });
  await new Promise((resolve) => setTimeout(resolve, 15));
  // The 5ms relay operation timeout must not end the approval session.
  assert.equal((await signal.publish({ kind: 'join-grant', approved: true })).relays, 1);
  signal.close();
});

test('session TTL closes resources independently', async () => {
  FakeWS.instances = [];
  const signal = await startNostrSignal({ inviteId: 'c'.repeat(16), sessionKey: key, relays: ['wss://one'], role: 'client', signEvent: signer, timeoutMs: 5, sessionTtlMs: 15, onSignal() {}, WebSocketImpl: FakeWS });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(() => signal.publish({ type: 'late' }), /NOSTR_SIGNAL_CLOSED/);
});

test('NIP-11 probe reports relay capabilities', async () => {
  const result = await probeNostrRelay('wss://relay.example', { fetchImpl: async (_url, options) => { assert.equal(options.headers.Accept, 'application/nostr+json'); return { ok: true, json: async () => ({ name: 'test' }) }; } }); assert.equal(result.name, 'test');
});

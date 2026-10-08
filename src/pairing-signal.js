import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { startNostrSignal, DEFAULT_NOSTR_RELAYS } from './nostr-signal.js';

const MAX_SIGNAL_BYTES = 16 * 1024;

export function pairingRoom(inviteId) {
  if (typeof inviteId !== 'string' || !/^[0-9a-f-]{16,}$/i.test(inviteId)) throw new Error('PAIRING_INVITE_ID_INVALID');
  return `pair:${inviteId}`;
}
function encode(roomId, kind, body) {
  const value = { roomId, kind, body }; const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) throw new Error('PAIRING_SIGNAL_TOO_LARGE'); return raw;
}
function parse(data, roomId) {
  try { const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data); if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) return null; const value = JSON.parse(raw); return value && value.roomId === roomId && typeof value.kind === 'string' && value.body && typeof value.body === 'object' ? value : null; } catch { return null; }
}
function openSocket(endpoint, WebSocketImpl) { return new Promise((resolve, reject) => { const socket = new WebSocketImpl(endpoint); const fail = (error) => reject(error instanceof Error ? error : new Error('PAIRING_SIGNAL_CONNECT_FAILED')); socket.once('open', () => resolve(socket)); socket.once('error', fail); }); }

/** Nostr control-plane pairing. The pairing code derives an ephemeral mailbox key. */
export async function startNostrPairingSignal({ endpoint, inviteId, code, role, request, onRequest, onGrant, signEvent, relays, sessionTtlMs, WebSocketImpl = WebSocket } = {}) {
  if (typeof code !== 'string' || !code) throw new Error('PAIRING_SIGNAL_CODE_REQUIRED');
  if (typeof signEvent !== 'function') throw new Error('NOSTR_SIGNAL_SIGNER_REQUIRED');
  const sessionKey = createHash('sha256').update(`dsh-pair-code:${inviteId}:${code}`).digest();
  const configuredRelays = relays?.length ? relays : (endpoint?.replace(/^nostr:\/\//, '').split(',').filter(Boolean));
  const signal = await startNostrSignal({ inviteId, sessionKey, role, signEvent, relays: configuredRelays?.length ? configuredRelays : DEFAULT_NOSTR_RELAYS, ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }), WebSocketImpl,
    onSignal: async (signalBody) => {
      if (role === 'host' && signalBody?.kind === 'join-request') await onRequest?.(signalBody.body);
      if (role === 'client' && signalBody?.kind === 'join-grant') await onGrant?.(signalBody.body);
    }});
  if (role === 'client') await signal.publish({ kind: 'join-request', body: request });
  return { roomId: pairingRoom(inviteId), sendGrant: async (grant) => signal.publish({ kind: 'join-grant', body: grant }), sendRequest: async (value) => signal.publish({ kind: 'join-request', body: value }), close: signal.close };
}

export async function startHostPairingSignal({ endpoint, inviteId, code, onRequest, signEvent, relays, WebSocketImpl = WebSocket }) {
  if (endpoint?.startsWith('nostr://')) return startNostrPairingSignal({ endpoint, inviteId, code, role: 'host', onRequest, signEvent, relays, WebSocketImpl });
  if (typeof onRequest !== 'function') throw new Error('PAIRING_SIGNAL_HANDLER_REQUIRED');
  const roomId = pairingRoom(inviteId); const socket = await openSocket(endpoint, WebSocketImpl); socket.send(encode(roomId, 'host-ready', { at: Date.now() }));
  socket.on('message', async (data) => { const message = parse(data, roomId); if (!message || message.kind !== 'join-request') return; try { await onRequest(message.body); } catch {} });
  return { roomId, async sendGrant(grant) { if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('PAIRING_SIGNAL_UNAVAILABLE'); socket.send(encode(roomId, 'join-grant', grant)); }, close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }) };
}

export async function startClientPairingSignal({ endpoint, inviteId, code, request, onGrant, signEvent, relays, WebSocketImpl = WebSocket }) {
  if (endpoint?.startsWith('nostr://')) return startNostrPairingSignal({ endpoint, inviteId, code, role: 'client', request, onGrant, signEvent, relays, WebSocketImpl });
  if (!request || typeof request !== 'object' || typeof onGrant !== 'function') throw new Error('PAIRING_SIGNAL_REQUEST_REQUIRED');
  const roomId = pairingRoom(inviteId); const socket = await openSocket(endpoint, WebSocketImpl);
  socket.on('message', async (data) => { const message = parse(data, roomId); if (!message || message.kind !== 'join-grant') return; try { await onGrant(message.body); } catch {} });
  socket.send(encode(roomId, 'join-request', request));
  return { roomId, close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }) };
}

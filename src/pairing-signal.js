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
function openSocket(endpoint, WebSocketImpl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const socket = new WebSocketImpl(endpoint);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { socket.close(); } catch {} reject(error instanceof Error ? error : new Error('PAIRING_SIGNAL_CONNECT_FAILED')); }
      else resolve(socket);
    };
    timer = setTimeout(() => finish(new Error('PAIRING_SIGNAL_CONNECT_TIMEOUT')), timeoutMs);
    socket.once('open', () => finish());
    socket.once('error', (error) => finish(error));
  });
}

/** Nostr control-plane pairing. The pairing code derives an ephemeral mailbox key. */
export async function startNostrPairingSignal({ endpoint, inviteId, code, role, request, onRequest, onGrant, onSignal, onError, signEvent, relays, timeoutMs = 8000, sessionTtlMs, WebSocketImpl = WebSocket } = {}) {
  if (typeof code !== 'string' || !code) throw new Error('PAIRING_SIGNAL_CODE_REQUIRED');
  if (typeof signEvent !== 'function') throw new Error('NOSTR_SIGNAL_SIGNER_REQUIRED');
  const sessionKey = createHash('sha256').update(`dsh-pair-code:${inviteId}:${code}`).digest();
  const configuredRelays = relays?.length ? relays : (endpoint?.replace(/^nostr:\/\//, '').split(',').filter(Boolean));
  const signal = await startNostrSignal({ inviteId, sessionKey, role, signEvent, relays: configuredRelays?.length ? configuredRelays : DEFAULT_NOSTR_RELAYS, timeoutMs, ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }), WebSocketImpl, onError,
    onSignal: async (signalBody) => {
      if (role === 'host' && signalBody?.kind === 'join-request') await onRequest?.(signalBody.body);
      if (role === 'client' && signalBody?.kind === 'join-grant') await onGrant?.(signalBody.body);
       if (signalBody?.kind === 'direct-answer') await onSignal?.(signalBody.kind, signalBody.body);
    }});
  if (role === 'client') await signal.publish({ kind: 'join-request', body: request });
  return { roomId: pairingRoom(inviteId), sendGrant: async (grant) => signal.publish({ kind: 'join-grant', body: grant }), sendRequest: async (value) => signal.publish({ kind: 'join-request', body: value }), sendSignal: async (kind, body) => signal.publish({ kind, body }), close: signal.close };
}

export async function startHostPairingSignal({ endpoint, inviteId, code, onRequest, onSignal, onError, signEvent, relays, timeoutMs = 8000, WebSocketImpl = WebSocket }) {
  if (endpoint?.startsWith('nostr://')) return startNostrPairingSignal({ endpoint, inviteId, code, role: 'host', onRequest, onSignal, onError, signEvent, relays, timeoutMs, WebSocketImpl });
  if (typeof onRequest !== 'function') throw new Error('PAIRING_SIGNAL_HANDLER_REQUIRED');
  const roomId = pairingRoom(inviteId); const socket = await openSocket(endpoint, WebSocketImpl, timeoutMs);
  // Install the handler before advertising readiness. A fast LAN client can send
  // its request immediately after receiving host-ready.
  socket.on('message', async (data) => { const message = parse(data, roomId); if (!message) return; try { if (message.kind === 'join-request') await onRequest(message.body); else if (message.kind === 'direct-answer') await onSignal?.(message.kind, message.body); } catch (error) { onError?.(error); } });
  socket.send(encode(roomId, 'host-ready', { at: Date.now() }));
  return { roomId, async sendGrant(grant) { if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('PAIRING_SIGNAL_UNAVAILABLE'); socket.send(encode(roomId, 'join-grant', grant)); }, async sendSignal(kind, body) { if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('PAIRING_SIGNAL_UNAVAILABLE'); socket.send(encode(roomId, kind, body)); }, close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }) };
}

export async function startClientPairingSignal({ endpoint, inviteId, code, request, onGrant, onSignal, onError, signEvent, relays, timeoutMs = 8000, WebSocketImpl = WebSocket }) {
  if (endpoint?.startsWith('nostr://')) return startNostrPairingSignal({ endpoint, inviteId, code, role: 'client', request, onGrant, onSignal, onError, signEvent, relays, timeoutMs, WebSocketImpl });
  if (!request || typeof request !== 'object' || typeof onGrant !== 'function') throw new Error('PAIRING_SIGNAL_REQUEST_REQUIRED');
  const roomId = pairingRoom(inviteId); const socket = await openSocket(endpoint, WebSocketImpl, timeoutMs);
  socket.on('message', async (data) => { const message = parse(data, roomId); if (!message) return; try { if (message.kind === 'join-grant') await onGrant(message.body); else await onSignal?.(message.kind, message.body); } catch (error) { onError?.(error); } });
  socket.send(encode(roomId, 'join-request', request));
  return { roomId, async sendSignal(kind, body) { if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('PAIRING_SIGNAL_UNAVAILABLE'); socket.send(encode(roomId, kind, body)); }, close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }) };
}

import WebSocket from 'ws';

const MAX_SIGNAL_BYTES = 16 * 1024;

export function pairingRoom(inviteId) {
  if (typeof inviteId !== 'string' || !/^[0-9a-f-]{16,}$/i.test(inviteId)) throw new Error('PAIRING_INVITE_ID_INVALID');
  return `pair:${inviteId}`;
}

function encode(roomId, kind, body) {
  const value = { roomId, kind, body };
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) throw new Error('PAIRING_SIGNAL_TOO_LARGE');
  return raw;
}

function parse(data, roomId) {
  try {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (Buffer.byteLength(raw) > MAX_SIGNAL_BYTES) return null;
    const value = JSON.parse(raw);
    if (!value || value.roomId !== roomId || typeof value.kind !== 'string' || !value.body || typeof value.body !== 'object') return null;
    return value;
  } catch { return null; }
}

function openSocket(endpoint, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint);
    const fail = (error) => reject(error instanceof Error ? error : new Error('PAIRING_SIGNAL_CONNECT_FAILED'));
    socket.once('open', () => resolve(socket));
    socket.once('error', fail);
  });
}

/**
 * Host-side pre-pairing mailbox. It carries only join metadata until a human
 * approves the request; grants are sent solely by sendGrant().
 */
export async function startHostPairingSignal({ endpoint, inviteId, onRequest, WebSocketImpl = WebSocket }) {
  if (typeof onRequest !== 'function') throw new Error('PAIRING_SIGNAL_HANDLER_REQUIRED');
  const roomId = pairingRoom(inviteId);
  const socket = await openSocket(endpoint, WebSocketImpl);
  socket.send(encode(roomId, 'host-ready', { at: Date.now() }));
  socket.on('message', async (data) => {
    const message = parse(data, roomId);
    if (!message || message.kind !== 'join-request') return;
    try { await onRequest(message.body); } catch { /* Host validation failure is intentionally not broadcast. */ }
  });
  return {
    roomId,
    async sendGrant(grant) {
      if (socket.readyState !== WebSocketImpl.OPEN) throw new Error('PAIRING_SIGNAL_UNAVAILABLE');
      socket.send(encode(roomId, 'join-grant', grant));
    },
    close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }),
  };
}

/** Client-side pre-pairing mailbox. A caller may persist the request locally
 * before connecting; it receives a secret-bearing grant only after Host approval. */
export async function startClientPairingSignal({ endpoint, inviteId, request, onGrant, WebSocketImpl = WebSocket }) {
  if (!request || typeof request !== 'object' || typeof onGrant !== 'function') throw new Error('PAIRING_SIGNAL_REQUEST_REQUIRED');
  const roomId = pairingRoom(inviteId);
  const socket = await openSocket(endpoint, WebSocketImpl);
  socket.on('message', async (data) => {
    const message = parse(data, roomId);
    if (!message || message.kind !== 'join-grant') return;
    try { await onGrant(message.body); } catch { /* Invalid/unexpected grants are dropped. */ }
  });
  socket.send(encode(roomId, 'join-request', request));
  return {
    roomId,
    close: () => new Promise((resolve) => { try { socket.once('close', resolve); socket.close(); } catch { resolve(); } }),
  };
}

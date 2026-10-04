#!/usr/bin/env node
/** Minimal untrusted WebSocket fan-out relay. Authentication happens in each DSH plugin. */
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

export async function createRelay({ host = '0.0.0.0', port = 0, maxBytes = 70 * 1024 } = {}) {
  const wss = new WebSocketServer({ host, port, maxPayload: maxBytes });
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.length > maxBytes) return socket.close(1009, 'message too large');
      let packet;
      try { packet = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!packet?.roomId || typeof packet.roomId !== 'string' || packet.roomId.length > 128) return;
      if (!socket.roomId) socket.roomId = packet.roomId;
      if (socket.roomId !== packet.roomId) return socket.close(1008, 'room cannot change');
      for (const peer of wss.clients) {
        if (peer !== socket && peer.roomId === socket.roomId && peer.readyState === peer.OPEN) peer.send(data, { binary: false });
      }
    });
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const address = wss.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const advertisedHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    url: `ws://${advertisedHost}:${boundPort}`,
    port: boundPort,
    close: () => new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8787);
  const maxBytes = Number(process.env.MAX_MESSAGE_BYTES || 70 * 1024);
  createRelay({ port, maxBytes }).then(({ url }) => {
    console.log(`DSH network-agent-collab relay listening on ${url}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

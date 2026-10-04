#!/usr/bin/env node
/** Minimal untrusted WebSocket fan-out relay. Authentication happens in each DSH plugin. */
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 8787);
const maxBytes = Number(process.env.MAX_MESSAGE_BYTES || 70 * 1024);
const wss = new WebSocketServer({ port, maxPayload: maxBytes });

wss.on('connection', (socket) => {
  socket.on('message', (data, isBinary) => {
    if (isBinary || data.length > maxBytes) return socket.close(1009, 'message too large');
    // Relay only minimally parses enough to isolate rooms. Signatures stay opaque here.
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
wss.on('listening', () => console.log(`DSH network-agent-collab relay listening on ws://0.0.0.0:${port}`));
wss.on('error', (error) => { console.error(error); process.exitCode = 1; });

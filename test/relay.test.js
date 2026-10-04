import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createRelay } from '../relay.js';

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
function nextMessage(socket, timeout = 500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeout);
    socket.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
  });
}

test('embedded relay binds an ephemeral port and isolates rooms', async (t) => {
  const relay = await createRelay({ host: '127.0.0.1', port: 0 });
  let sender; let sameRoom; let otherRoom;
  try {
    assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(relay.port > 0);
    sender = await connect(relay.url);
    sameRoom = await connect(relay.url);
    otherRoom = await connect(relay.url);
    // Establish each socket's room before publishing the payload under test.
    sender.send(JSON.stringify({ roomId: 'alpha', body: 'presence' }));
    sameRoom.send(JSON.stringify({ roomId: 'alpha', body: 'presence' }));
    otherRoom.send(JSON.stringify({ roomId: 'bravo', body: 'presence' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const received = nextMessage(sameRoom);
    let leaked = false;
    otherRoom.once('message', () => { leaked = true; });
    sender.send(JSON.stringify({ roomId: 'alpha', body: 'hello' }));
    const packet = await received;
    assert.equal(packet.body, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(leaked, false);
  } finally {
    for (const socket of [sender, sameRoom, otherRoom]) socket?.terminate();
    await relay.close();
  }
});

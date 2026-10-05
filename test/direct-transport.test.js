import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectPeer } from '../src/direct-peer.js';
import { FederationClient } from '../src/core.js';

class FakeChannel {
  constructor() { this.open = true; this.handler = null; this.closed = null; this.remote = null; }
  onMessage(handler) { this.handler = handler; }
  onClosed(handler) { this.closed = handler; }
  isOpen() { return this.open; }
  sendMessage(value) {
    if (!this.open) throw new Error('closed');
    queueMicrotask(() => this.remote?.handler?.(value));
  }
  close() { this.open = false; this.closed?.(); }
}

class FakePeerConnection {
  static instances = [];
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.remoteCandidates = [];
    this.descriptionHandler = null;
    this.dataChannelHandler = null;
    this.candidateHandler = null;
    this.stateHandler = null;
    this.channel = null;
    FakePeerConnection.instances.push(this);
  }
  onLocalDescription(handler) { this.descriptionHandler = handler; }
  onLocalCandidate(handler) { this.candidateHandler = handler; }
  onStateChange(handler) { this.stateHandler = handler; }
  onDataChannel(handler) { this.dataChannelHandler = handler; }
  createDataChannel() {
    this.channel = new FakeChannel();
    queueMicrotask(() => this.descriptionHandler?.('v=0\\r\\nfake', 'Offer'));
    return this.channel;
  }
  setRemoteDescription(sdp, type) {
    this.remoteDescription = { sdp, type };
    if (type === 'Offer') queueMicrotask(() => this.descriptionHandler?.('v=0\\r\\nfake-answer', 'Answer'));
  }
  addRemoteCandidate(candidate, mid) { this.remoteCandidates.push({ candidate, mid }); }
  destroy() { this.channel?.close(); }
}

function connectPeers(host, client) {
  const hostChannel = host.channel;
  const clientChannel = new FakeChannel();
  hostChannel.remote = clientChannel;
  clientChannel.remote = hostChannel;
  client.pc.dataChannelHandler(clientChannel);
}

function memoryStore() {
  return { async load(value) { return structuredClone(value); }, async save() {} };
}

const identities = {
  host: { id: 'host', name: 'Host', capabilities: [] },
  client: { id: 'client', name: 'Client', capabilities: [] },
};

test('DirectPeer validates signal direction and rejects malformed offers/answers', async () => {
  const client = new DirectPeer({ role: 'client', PeerConnectionImpl: FakePeerConnection });
  assert.throws(() => client.acceptOffer({ type: 'answer', sdp: 'answer' }), /DIRECT_SIGNAL_INVALID/);
  assert.throws(() => client.acceptOffer({ type: 'offer', sdp: '' }), /DIRECT_SIGNAL_INVALID/);
  assert.throws(() => client.acceptOffer({ type: 'offer', sdp: 'offer', candidates: [{ candidate: 7 }] }), /DIRECT_SIGNAL_INVALID/);
  for (const candidate of ['', '   ', 'not-an-ice-candidate']) {
    assert.throws(() => client.acceptOffer({ type: 'offer', sdp: 'offer', candidates: [{ candidate }] }), /DIRECT_SIGNAL_INVALID/);
  }
  assert.throws(() => client.acceptOffer({ type: 'offer', sdp: 'offer', candidates: [{ candidate: 'candidate:1 1 UDP 1 192.0.2.1 3478 typ host', mid: '   ' }] }), /DIRECT_SIGNAL_INVALID/);

  const host = new DirectPeer({ role: 'host', PeerConnectionImpl: FakePeerConnection });
  const offer = await host.createOffer();
  assert.equal(offer.type, 'offer');
  const answer = await client.acceptOffer(offer);
  assert.equal(answer.type, 'answer');
  assert.throws(() => host.acceptAnswer({ type: 'offer', sdp: 'offer' }), /DIRECT_SIGNAL_INVALID/);
  host.acceptAnswer(answer);
});

test('FederationClient sends and receives authenticated messages over DirectPeer transport', async () => {
  const received = [];
  const host = new DirectPeer({ role: 'host', PeerConnectionImpl: FakePeerConnection });
  const client = new DirectPeer({ role: 'client', PeerConnectionImpl: FakePeerConnection, onMessage: (message) => received.push(message) });
  const offer = await host.createOffer();
  const answer = await client.acceptOffer(offer);
  host.acceptAnswer(answer);
  connectPeers(host, client);

  const hostClient = new FederationClient({ relayUrl: 'direct://fake', roomId: 'room', secret: 'secret', identity: identities.host, store: memoryStore(), transport: host });
  const clientClient = new FederationClient({ relayUrl: 'direct://fake', roomId: 'room', secret: 'secret', identity: identities.client, store: memoryStore(), transport: client });
  await hostClient.start();
  await clientClient.start();
  await hostClient.message({ to: 'client', text: 'hello', topic: 'test' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clientClient.snapshot().messages[0].text, 'hello');
  assert.equal(received.length, 0);
});

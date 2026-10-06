import { randomUUID } from 'node:crypto';
import { PeerConnection } from 'node-datachannel';

const OFFER = 'Offer';
const ANSWER = 'Answer';

export const DEFAULT_STUN_SERVERS = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]);

const MAX_SIGNAL_BYTES = 64 * 1024;
const DESCRIPTION_TIMEOUT_MS = 15_000;
const GATHERING_TIMEOUT_MS = 12_000;

function validIceCandidate(candidate) {
  return typeof candidate === 'string' && /^candidate:\S+/.test(candidate.trim());
}

// Manual exchange is intended for public peers: host candidates (including
// browser mDNS hostnames) are not usable across the Internet and may disclose
// local network details. Keep only STUN-derived server-reflexive candidates.
function usableIceCandidate(candidate) {
  return validIceCandidate(candidate) && /\btyp\s+(?:srflx|relay)\b/i.test(candidate) && !/\.local(?:\s|$)/i.test(candidate);
}

function completeSignalDescription(pc, transform) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingDescription = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(descriptionTimer);
      clearTimeout(gatheringTimer);
      error ? reject(error) : resolve(value);
    };
    const build = (sdp, type) => {
      if (settled || typeof sdp !== 'string' || !sdp.trim()) return;
      try { finish(null, transform(sdp, type)); } catch (error) { finish(error); }
    };
    const onComplete = () => {
      // At completion node-datachannel exposes the final SDP (with gathered
      // candidates); the early onLocalDescription payload may still be empty.
      const description = pc.localDescription?.() || pendingDescription;
      if (!description) return finish(new Error('DIRECT_LOCAL_DESCRIPTION_MISSING'));
      build(typeof description === 'string' ? description : description.sdp,
        typeof description === 'string' ? undefined : description.type);
    };
    const descriptionTimer = setTimeout(() => finish(new Error('DIRECT_DESCRIPTION_TIMEOUT')), DESCRIPTION_TIMEOUT_MS);
    const gatheringTimer = setTimeout(() => finish(new Error('DIRECT_ICE_GATHERING_TIMEOUT')), GATHERING_TIMEOUT_MS);
    // node-datachannel emits localDescription before ICE gathering finishes.
    pc.onLocalDescription((sdp, type) => {
      pendingDescription = { sdp, type };
      if (typeof pc.gatheringState !== 'function') build(sdp, type);
      else if (String(pc.gatheringState()).toLowerCase() === 'complete') onComplete();
    });
    if (typeof pc.onGatheringStateChange === 'function') {
      pc.onGatheringStateChange((state) => {
        if (String(state).toLowerCase() === 'complete') onComplete();
      });
    }
  });
}

function validateSignal(signal, expectedType) {
  if (!signal || typeof signal !== 'object' || signal.type !== expectedType || typeof signal.sdp !== 'string' || !signal.sdp.trim() || signal.sdp.length > MAX_SIGNAL_BYTES) {
    throw new Error('DIRECT_SIGNAL_INVALID');
  }
  if (signal.candidates !== undefined && (!Array.isArray(signal.candidates) || signal.candidates.some((item) => !item || typeof item !== 'object' || !validIceCandidate(item.candidate) || (item.mid !== undefined && (typeof item.mid !== 'string' || !item.mid.trim()))))) {
    throw new Error('DIRECT_SIGNAL_INVALID');
  }
  return signal;
}

function safeSignal({ type, sdp, candidates = [] }) {
  const signal = { version: 1, type, sdp, candidates: Array.isArray(candidates) ? candidates.slice(0, 256) : [] };
  if (Buffer.byteLength(JSON.stringify(signal)) > MAX_SIGNAL_BYTES) throw new Error('DIRECT_SIGNAL_TOO_LARGE');
  return signal;
}

/**
 * Manual-signaling IPv4 WebRTC data channel. STUN discovers candidates; no
 * TURN/Relay is configured. The caller copies the returned offer/answer.
 */
export class DirectPeer {
  constructor({ role, name = `peer-${randomUUID()}`, iceServers = DEFAULT_STUN_SERVERS, PeerConnectionImpl = PeerConnection, onMessage, onState } = {}) {
    if (!['host', 'client'].includes(role)) throw new Error('DIRECT_ROLE_INVALID');
    this.role = role;
    this.onMessage = onMessage;
    this.onState = onState;
    this.pc = new PeerConnectionImpl(name, { iceServers, iceTransportPolicy: 'all' });
    this.channel = null;
    this.localCandidates = [];
    this.pc.onLocalCandidate((candidate, mid) => {
      if (usableIceCandidate(candidate) && !this.localCandidates.some((item) => item.candidate === candidate && item.mid === mid)) {
        this.localCandidates.push({ candidate, mid });
      }
    });
    this.pc.onStateChange((state) => this.onState?.(state));
    this.pc.onDataChannel((channel) => this.bindChannel(channel));
  }

  bindChannel(channel) {
    this.channel = channel;
    channel.onMessage((message) => this.onMessage?.(Buffer.isBuffer(message) ? message.toString('utf8') : message));
    channel.onClosed(() => { if (this.channel === channel) this.channel = null; });
  }

  setMessageHandler(handler) { this.onMessage = handler; }
  isOpen() { return Boolean(this.channel?.isOpen()); }

  async createOffer() {
    if (this.role !== 'host') throw new Error('DIRECT_HOST_REQUIRED');
    const offer = completeSignalDescription(this.pc, (sdp, type) => safeSignal({ type: type === ANSWER ? 'answer' : 'offer', sdp, candidates: this.localCandidates }));
    this.channel = this.pc.createDataChannel('dsh-collaboration');
    this.bindChannel(this.channel);
    return offer;
  }

  acceptOffer(signal) {
    if (this.role !== 'client') throw new Error('DIRECT_CLIENT_REQUIRED');
    const offer = validateSignal(signal, 'offer');
    const answer = completeSignalDescription(this.pc, (sdp, type) => safeSignal({ type: type === OFFER ? 'offer' : 'answer', sdp, candidates: this.localCandidates }));
    this.pc.setRemoteDescription(offer.sdp, OFFER);
    for (const item of offer.candidates || []) this.pc.addRemoteCandidate(item.candidate, item.mid || '0');
    return answer;
  }

  acceptAnswer(signal) {
    if (this.role !== 'host') throw new Error('DIRECT_HOST_REQUIRED');
    const answer = validateSignal(signal, 'answer');
    this.pc.setRemoteDescription(answer.sdp, ANSWER);
    for (const item of answer.candidates || []) this.pc.addRemoteCandidate(item.candidate, item.mid || '0');
  }

  send(value) {
    if (!this.channel?.isOpen()) throw new Error('DIRECT_CHANNEL_NOT_OPEN');
    return this.channel.sendMessage(typeof value === 'string' ? value : JSON.stringify(value));
  }

  close() { (this.pc.destroy || this.pc.close).call(this.pc); this.channel = null; }
}

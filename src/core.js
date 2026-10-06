import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PROTOCOL = 'dsh-agent-collab/1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signEnvelope(unsigned, secret) {
  return createHmac('sha256', secret).update(canonical(unsigned)).digest('base64url');
}

export function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createEnvelope({ roomId, sender, kind, body, secret, id = randomUUID(), timestamp = Date.now() }) {
  const unsigned = { protocol: PROTOCOL, id, roomId, sender, kind, body, timestamp };
  return { ...unsigned, signature: signEnvelope(unsigned, secret) };
}

export function validateEnvelope(envelope, secret, now = Date.now()) {
  if (!envelope || typeof envelope !== 'object') return 'envelope must be an object';
  const required = ['protocol', 'id', 'roomId', 'sender', 'kind', 'body', 'timestamp', 'signature'];
  if (required.some((key) => !(key in envelope))) return 'missing required envelope field';
  if (envelope.protocol !== PROTOCOL) return 'unsupported protocol';
  if (!Number.isSafeInteger(envelope.timestamp) || Math.abs(now - envelope.timestamp) > MAX_CLOCK_SKEW_MS) return 'timestamp outside permitted clock skew';
  if (typeof envelope.roomId !== 'string' || !envelope.roomId || envelope.roomId.length > 128) return 'invalid roomId';
  if (typeof envelope.sender !== 'string' || !envelope.sender || envelope.sender.length > 128) return 'invalid sender';
  if (Buffer.byteLength(JSON.stringify(envelope.body)) > MAX_BODY_BYTES) return 'body exceeds 64 KiB';
  const { signature, ...unsigned } = envelope;
  return safeEqual(signEnvelope(unsigned, secret), signature) ? null : 'invalid signature';
}

export class JsonStore {
  constructor(path) { this.path = path; }
  async load(fallback) {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      // Migrate older state files without dropping persisted peers/messages/tasks.
      const merged = { ...fallback, ...saved, peers: { ...fallback.peers, ...(saved.peers || {}) } };
      for (const key of ['tasks', 'activations', 'approvals']) {
        if (fallback[key] !== undefined || saved[key] !== undefined) merged[key] = { ...(fallback[key] || {}), ...(saved[key] || {}) };
      }
      for (const key of ['messages', 'seenIds']) {
        if (fallback[key] !== undefined || saved[key] !== undefined) merged[key] = saved[key] || fallback[key];
      }
      return merged;
    } catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
  }
  async save(value) {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, this.path);
  }
}

export function defaultState(identity) {
  return {
    version: 2, identity, peers: {}, messages: [], tasks: {},
    activations: {}, approvals: {}, seenIds: [],
  };
}

export function applyEnvelope(state, envelope) {
  if (state.seenIds.includes(envelope.id)) return false;
  state.seenIds = [...state.seenIds, envelope.id].slice(-1000);
  if (envelope.kind === 'presence') {
    state.peers[envelope.sender] = { ...envelope.body, id: envelope.sender, lastSeen: envelope.timestamp };
  } else if (envelope.kind === 'message') {
    state.messages = [...state.messages, { ...envelope.body, id: envelope.id, sender: envelope.sender, timestamp: envelope.timestamp }].slice(-500);
  } else if (envelope.kind === 'task') {
    const task = envelope.body;
    if (task?.id && task.action) {
      const previous = state.tasks[task.id] || { id: task.id, createdAt: envelope.timestamp };
      state.tasks[task.id] = { ...previous, ...task, updatedAt: envelope.timestamp, updatedBy: envelope.sender };
    }
  } else if (envelope.kind === 'activation') {
    const request = envelope.body;
    if (request?.id && request.target) {
      const previous = state.activations[request.id] || { id: request.id, requestedAt: envelope.timestamp };
      state.activations[request.id] = {
        ...previous, ...request, requester: envelope.sender,
        status: request.status || (request.approvalLevel === 'none' ? 'activated' : 'pending'), updatedAt: envelope.timestamp,
      };
    }
  } else if (envelope.kind === 'approval') {
    const approval = envelope.body;
    const activation = approval?.activationId && state.activations[approval.activationId];
    // Only the receiving agent may decide its own pending request. This prevents
    // another room member from approving an unrelated activation.
    if (activation && activation.target === envelope.sender && approval?.target === envelope.sender
      && approval?.approvalLevel === activation.approvalLevel
      && activation.status === 'pending' && ['approved', 'rejected'].includes(approval.decision)) {
      state.approvals[approval.activationId] = { ...approval, approver: envelope.sender, updatedAt: envelope.timestamp };
      state.activations[approval.activationId] = {
        ...activation, status: approval.decision === 'approved' ? 'approved' : 'rejected', approval: approval.decision, updatedAt: envelope.timestamp,
      };
    }
  }
  return true;
}

export class FederationClient {
  constructor({ relayUrl, roomId, secret, identity, store, transport = null, accessPermissionLevel = 'trusted', accessExpiresAt = null, privilegedApproverIds = [], WebSocketImpl = globalThis.WebSocket, onChange = () => {}, onActivation = async () => {} }) {
    if (!transport && !WebSocketImpl) throw new Error('WebSocket is unavailable in this Node runtime');
    this.relayUrl = relayUrl; this.roomId = roomId; this.secret = secret; this.identity = identity; this.transport = transport;
    this.accessPermissionLevel = accessPermissionLevel;
    this.accessExpiresAt = accessExpiresAt;
    this.privilegedApproverIds = new Set(privilegedApproverIds);
    this.store = store; this.WebSocketImpl = WebSocketImpl; this.onChange = onChange; this.onActivation = onActivation;
    this.state = null; this.socket = null; this.reconnectTimer = null; this.closed = false;
  }
  async start() { this.state = await this.store.load(defaultState(this.identity)); if (this.transport) this.attachTransport(); else this.connect(); return this; }
  snapshot() { return structuredClone(this.state); }
  isConnected() { return this.transport ? this.transport.isOpen() : this.socket?.readyState === this.WebSocketImpl.OPEN; }
  attachTransport() {
    this.transport.setMessageHandler((raw) => this.handleIncoming(raw));
  }
  async handleIncoming(raw) {
    try {
      const envelope = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
      if (envelope.roomId !== this.roomId || envelope.sender === this.identity.id) return;
      if ((envelope.kind === 'activation' || envelope.kind === 'message') && envelope.body?.to && envelope.body.to !== 'all' && envelope.body.to !== this.identity.id) return;
      if (envelope.kind === 'activation' && envelope.body?.target && envelope.body.target !== 'all' && envelope.body.target !== this.identity.id) return;
      if (!validateEnvelope(envelope, this.secret) && applyEnvelope(this.state, envelope)) {
        await this.persist();
        if (envelope.kind === 'activation') await this.deliverActivation(envelope.body.id);
      }
    } catch { /* Ignore malformed direct traffic. */ }
  }
  async persist() { await this.store.save(this.state); this.onChange(this.snapshot()); }
  async deliverActivation(activationId) {
    const activation = this.state.activations[activationId];
    if (!activation || activation.target !== this.identity.id || !['activated', 'approved'].includes(activation.status)) return false;
    if (this.accessExpiresAt !== null && Date.now() >= this.accessExpiresAt) return false;
    if (activation.deliveryStatus === 'starting' || activation.deliveryStatus === 'started') return false;
    activation.deliveryStatus = 'starting'; activation.deliveryStartedAt = Date.now();
    await this.persist();
    try {
      const delivery = await this.onActivation(structuredClone(activation));
      activation.deliveryStatus = 'started'; activation.delivery = delivery || { started: true }; activation.deliveryCompletedAt = Date.now();
    } catch (error) {
      activation.deliveryStatus = 'failed'; activation.deliveryError = error instanceof Error ? error.message : String(error); activation.deliveryCompletedAt = Date.now();
    }
    await this.persist();
    return activation.deliveryStatus === 'started';
  }
  connect() {
    if (this.closed) return;
    const socket = this.socket = new this.WebSocketImpl(this.relayUrl);
    socket.addEventListener('open', () => { this.publish('presence', { name: this.identity.name, capabilities: this.identity.capabilities, status: 'online' }); });
    socket.addEventListener('message', (event) => this.handleIncoming(event.data));
    socket.addEventListener('close', () => this.scheduleReconnect());
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
  }
  scheduleReconnect() { if (!this.closed && !this.reconnectTimer) this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, 2000); }
  ensureAccess(kind) {
    if (this.accessExpiresAt !== null && Date.now() >= this.accessExpiresAt) throw new Error('COLLABORATION_ACCESS_EXPIRED');
    if (kind === 'task' && this.accessPermissionLevel === 'communication') throw new Error('COLLABORATION_PERMISSION_DENIED');
    if (kind === 'activation' && !['wake-approval', 'trusted'].includes(this.accessPermissionLevel)) throw new Error('COLLABORATION_PERMISSION_DENIED');
  }
  publish(kind, body) {
    this.ensureAccess(kind);
    if (this.transport) {
      if (!this.transport.isOpen()) { const error = new Error('DIRECT_CHANNEL_NOT_OPEN'); error.code = 'DIRECT_CHANNEL_NOT_OPEN'; throw error; }
    } else if (this.socket?.readyState !== this.WebSocketImpl.OPEN) {
      const error = new Error('RELAY_UNAVAILABLE: collaboration relay is not connected');
      error.code = 'RELAY_UNAVAILABLE';
      throw error;
    }
    const envelope = createEnvelope({ roomId: this.roomId, sender: this.identity.id, kind, body, secret: this.secret });
    if (this.transport) this.transport.send(JSON.stringify(envelope)); else this.socket.send(JSON.stringify(envelope));
    return envelope;
  }
  async message({ to = 'all', text, topic = 'general' }) {
    const envelope = this.publish('message', { to, text, topic });
    applyEnvelope(this.state, envelope); await this.persist(); return envelope.id;
  }
  async task(task) {
    const envelope = this.publish('task', task);
    applyEnvelope(this.state, envelope); await this.persist(); return envelope.id;
  }
  async activate({ target, title, detail = '', approvalLevel = 'peer' }) {
    const request = { id: randomUUID(), target, title, detail, approvalLevel, status: approvalLevel === 'none' ? 'activated' : 'pending' };
    const envelope = this.publish('activation', request);
    applyEnvelope(this.state, envelope); await this.persist(); return request.id;
  }
  async approve({ activationId, decision, note = '' }) {
    const activation = this.state.activations[activationId];
    if (!activation) throw new Error('UNKNOWN_ACTIVATION');
    if (activation.target !== this.identity.id || activation.status !== 'pending') throw new Error('ACTIVATION_NOT_APPROVABLE');
    if (activation.approvalLevel === 'privileged' && !this.privilegedApproverIds.has(this.identity.id)) throw new Error('PRIVILEGED_APPROVER_NOT_CONFIGURED');
    if (!['approved', 'rejected'].includes(decision)) throw new Error('INVALID_APPROVAL_DECISION');
    const envelope = this.publish('approval', {
      activationId, decision, note, target: this.identity.id,
      requester: activation.requester, approvalLevel: activation.approvalLevel,
    });
    applyEnvelope(this.state, envelope); await this.persist();
    if (decision === 'approved') await this.deliverActivation(activationId);
    return envelope.id;
  }
  close() { this.closed = true; clearTimeout(this.reconnectTimer); try { this.socket?.close(); } catch {} try { this.transport?.close(); } catch {} }
}

export function dataPath(baseDir, roomId) { return join(baseDir, `network-agent-collab-${roomId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`); }

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPairingInvite, decodePairingInvite, encodePairingInvite, loadOrCreateLocalIdentity, verifyPairingCode, signPairingGrant, verifyPairingGrant } from './onboarding.js';

const VERSION = 1;
const NETWORKS = new Set(['lan', 'public']);
const LAN_TRANSPORTS = new Set(['local', 'tailscale']);
const ROLES = new Set(['host', 'client']);
const ACCESS_DURATIONS = new Set(['once', '24h', 'permanent']);
const ACCESS_LEVELS = new Set(['communication', 'wake-approval', 'trusted']);

function grantExpiry(duration, now) {
  return duration === '24h' ? now + 24 * 60 * 60 * 1000 : duration === 'permanent' ? null : now;
}

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

function defaultState() {
  return { version: VERSION, setup: null, group: null, pendingRequests: {}, pendingJoin: null, usedInviteIds: [], members: {} };
}

function redactGroup(group) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    transport: group.transport,
    endpoint: group.endpoint,
    createdAt: group.createdAt,
    expiresAt: group.expiresAt,
  };
}

/** Pre-pairing local state. Secrets and invitations are never exposed by status(). */
export class SetupState {
  constructor({ path, identityPath, displayName = 'dsh-agent' }) {
    this.path = path;
    this.identityPath = identityPath || join(dirname(path), 'identity.json');
    this.displayName = displayName;
    this.identity = null;
    this.state = null;
  }

  async load() {
    this.identity = await loadOrCreateLocalIdentity(this.identityPath, { name: this.displayName });
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      this.state = saved?.version === VERSION ? { ...defaultState(), ...saved } : defaultState();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = defaultState();
    }
    await this.persist();
    return this;
  }

  async persist() { await saveJson(this.path, this.state); }

  status() {
    if (!this.identity || !this.state) throw new Error('SETUP_STATE_NOT_LOADED');
    const isHost = this.state.setup?.role === 'host';
    const activeInvite = isHost && this.state.group?.invites
      ? Object.values(this.state.group.invites).find((inv) => !this.state.usedInviteIds?.includes(inv.id) && inv.expiresAt > Date.now())
      : null;
    return Object.freeze({
      configured: Boolean(this.state.setup),
      identity: { id: this.identity.id, name: this.identity.name, createdAt: this.identity.createdAt },
      setup: this.state.setup ? { ...this.state.setup } : null,
      group: redactGroup(this.state.group),
      activeInvite: activeInvite ? {
        id: activeInvite.id,
        pairingCode: activeInvite.code,
        invitation: encodePairingInvite(activeInvite),
        expiresAt: activeInvite.expiresAt,
      } : null,
      pendingRequests: Object.values(this.state.pendingRequests || {}).map(({ id, clientId, clientName, inviteId, createdAt }) => ({ id, clientId, clientName, inviteId, createdAt })),
      pendingJoin: this.state.pendingJoin ? { id: this.state.pendingJoin.id, hostId: this.state.pendingJoin.invite.hostId, hostName: this.state.pendingJoin.invite.hostName, endpoint: this.state.pendingJoin.invite.endpoint, expiresAt: this.state.pendingJoin.invite.expiresAt } : null,
      members: Object.values(this.state.members || {}).map(({ id, name, approvedAt, duration, permissionLevel, expiresAt }) => ({ id, name, approvedAt, duration, permissionLevel, expiresAt })), 
    });
  }

  async configure({ network, lanTransport, role, groupName } = {}) {
    if (!NETWORKS.has(network)) throw new Error('SETUP_NETWORK_INVALID');
    if (!ROLES.has(role)) throw new Error('SETUP_ROLE_INVALID');
    if (network === 'lan' && !LAN_TRANSPORTS.has(lanTransport || 'local')) throw new Error('SETUP_LAN_TRANSPORT_INVALID');
    if (network === 'public' && lanTransport !== undefined) throw new Error('SETUP_PUBLIC_LAN_TRANSPORT_FORBIDDEN');
    if (groupName !== undefined && (typeof groupName !== 'string' || !groupName.trim() || groupName.length > 80)) throw new Error('SETUP_GROUP_NAME_INVALID');
    this.state.setup = Object.freeze({ network, role, ...(network === 'lan' ? { lanTransport: lanTransport || 'local' } : {}), ...(groupName ? { groupName: groupName.trim() } : {}) });
    this.state.group = null; this.state.pendingRequests = {}; this.state.pendingJoin = null; this.state.usedInviteIds = []; this.state.members = {};
    await this.persist();
    return this.status();
  }

  async createHost({ transport, endpoint, now = Date.now(), ttlMs = 5 * 60_000 } = {}) {
    if (!this.state?.setup || this.state.setup.role !== 'host') throw new Error('SETUP_HOST_ROLE_REQUIRED');
    const expectedTransport = this.state.setup.network === 'lan' ? this.state.setup.lanTransport : 'public';
    if (transport !== expectedTransport) throw new Error('SETUP_TRANSPORT_MISMATCH');
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('SETUP_ENDPOINT_REQUIRED');
    const secret = randomBytes(32).toString('base64url');
    const roomId = randomUUID();
    const invite = createPairingInvite({ identity: this.identity, endpoint, now, ttlMs });
    const group = { id: roomId, name: this.state.setup.groupName || this.identity.name, transport, endpoint, secret, createdAt: now, expiresAt: now + ttlMs, invites: { [invite.id]: invite } };
    this.state.group = group;
    this.state.pendingRequests = {}; this.state.usedInviteIds = []; this.state.members = {};
    await this.persist();
    return Object.freeze({ status: this.status(), invite, pairingCode: invite.code, roomId });
  }

  /** Client prepares a request without receiving any room material. */
  async requestJoin({ invitation, code, now = Date.now() } = {}) {
    if (this.state?.setup?.role !== 'client') throw new Error('SETUP_CLIENT_ROLE_REQUIRED');
    const invite = decodePairingInvite(invitation, now);
    const mismatch = verifyPairingCode(invite, code, now);
    if (mismatch) throw new Error(`PAIRING_CODE_INVALID: ${mismatch}`);
    if (this.state.pendingJoin?.invite?.id === invite.id) throw new Error('PAIRING_REQUEST_ALREADY_PENDING');
    const request = { id: randomUUID(), invite, code, clientId: this.identity.id, clientName: this.identity.name, createdAt: now };
    this.state.pendingJoin = request;
    await this.persist();
    return { request: { id: request.id, inviteId: invite.id, clientId: request.clientId, clientName: request.clientName, createdAt: request.createdAt, invitation, code } };
  }

  /** Host validates a copied request, but deliberately does not disclose a secret. */
  async receiveJoinRequest({ request, now = Date.now() } = {}) {
    if (this.state?.setup?.role !== 'host' || !this.state.group) throw new Error('SETUP_HOST_GROUP_REQUIRED');
    if (!request || typeof request !== 'object' || typeof request.inviteId !== 'string' || typeof request.code !== 'string' || typeof request.clientId !== 'string' || !request.clientId) throw new Error('PAIRING_REQUEST_INVALID');
    const invite = this.state.group.invites?.[request.inviteId];
    const mismatch = verifyPairingCode(invite, request.code, now);
    if (mismatch) throw new Error(`PAIRING_REQUEST_REJECTED: ${mismatch}`);
    if (this.state.usedInviteIds.includes(invite.id)) throw new Error('PAIRING_INVITE_ALREADY_USED');
    if (Object.values(this.state.members || {}).some((member) => member.id === request.clientId)) throw new Error('PAIRING_AGENT_ALREADY_MATCHED');
    if (Object.values(this.state.pendingRequests || {}).some((pending) => pending.clientId === request.clientId)) throw new Error('PAIRING_REQUEST_ALREADY_PENDING');
    const pending = { id: request.id || randomUUID(), inviteId: invite.id, clientId: request.clientId, clientName: typeof request.clientName === 'string' ? request.clientName.slice(0, 80) : request.clientId, createdAt: now };
    this.state.pendingRequests[pending.id] = pending;
    await this.persist();
    return { acceptedForReview: true, request: { ...pending } };
  }

  /** Host decision is the only point at which encrypted-room material is released. */
  async decideJoin({ requestId, decision, duration = 'once', permissionLevel = 'communication', now = Date.now() } = {}) {
    if (this.state?.setup?.role !== 'host' || !this.state.group) throw new Error('SETUP_HOST_GROUP_REQUIRED');
    if (!['approved', 'rejected'].includes(decision)) throw new Error('PAIRING_DECISION_INVALID');
    if (!ACCESS_DURATIONS.has(duration)) throw new Error('PAIRING_DURATION_INVALID');
    if (!ACCESS_LEVELS.has(permissionLevel)) throw new Error('PAIRING_PERMISSION_INVALID');
    const request = this.state.pendingRequests?.[requestId];
    if (!request) throw new Error('PAIRING_REQUEST_NOT_FOUND');
    delete this.state.pendingRequests[requestId];
    if (decision === 'rejected') { await this.persist(); return { decision, requestId }; }
    const invite = this.state.group.invites?.[request.inviteId];
    if (!invite || this.state.usedInviteIds.includes(invite.id) || invite.expiresAt <= now) throw new Error('PAIRING_INVITE_UNAVAILABLE');
    if (Object.keys(this.state.members || {}).length > 0) throw new Error('PAIRING_AGENT_ALREADY_MATCHED');
    this.state.usedInviteIds.push(invite.id);
    const expiresAt = grantExpiry(duration, now);
    this.state.members[request.clientId] = { id: request.clientId, name: request.clientName, approvedAt: now, duration, permissionLevel, expiresAt };
    const grant = { requestId, hostId: this.identity.id, hostName: this.identity.name, endpoint: this.state.group.endpoint, roomId: this.state.group.id, secret: this.state.group.secret, approvedAt: now, duration, permissionLevel, expiresAt };
    grant.signature = signPairingGrant(grant, this.identity);
    await this.persist();
    return { decision, requestId, grant };
  }

  /** Client explicitly confirms and stores a Host-issued approved grant. */
  async acceptJoinGrant({ grant } = {}) {
    const pending = this.state?.pendingJoin;
    if (this.state?.setup?.role !== 'client' || !pending) throw new Error('PAIRING_CLIENT_CONFIRMATION_REQUIRED');
    if (!grant || grant.requestId !== pending.id || grant.hostId !== pending.invite.hostId || grant.endpoint !== pending.invite.endpoint || typeof grant.roomId !== 'string' || typeof grant.secret !== 'string' || Buffer.from(grant.secret, 'base64url').length < 32 || typeof grant.endpoint !== 'string' || !verifyPairingGrant(grant, pending.invite)) throw new Error('PAIRING_GRANT_INVALID');
    this.state.group = { id: grant.roomId, name: grant.hostName || grant.hostId, transport: this.state.setup.network === 'lan' ? this.state.setup.lanTransport : 'public', endpoint: grant.endpoint, secret: grant.secret, createdAt: grant.approvedAt || Date.now(), joinedAt: Date.now(), hostId: grant.hostId };
    this.state.pendingJoin = null;
    await this.persist();
    return this.status();
  }

  async removeMember({ memberId } = {}) {
    if (this.state?.setup?.role !== 'host' || typeof memberId !== 'string') throw new Error('PAIRING_MEMBER_INVALID');
    if (!this.state.members?.[memberId]) throw new Error('PAIRING_MEMBER_NOT_FOUND');
    delete this.state.members[memberId]; await this.persist(); return this.status();
  }

  pairing() {
    if (!this.state?.group) return null;
    return { roomId: this.state.group.id, secret: this.state.group.secret, endpoint: this.state.group.endpoint };
  }

  pendingJoinRequest() {
    if (!this.state?.pendingJoin) return null;
    const request = this.state.pendingJoin;
    return { request: { id: request.id, inviteId: request.invite.id, clientId: request.clientId, clientName: request.clientName, createdAt: request.createdAt, invitation: encodePairingInvite(request.invite), code: request.code }, invite: request.invite };
  }

  async leave() {
    this.state.setup = null;
    this.state.group = null;
    await this.persist();
    return this.status();
  }
}

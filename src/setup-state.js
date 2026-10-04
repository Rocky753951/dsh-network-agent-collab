import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPairingInvite, loadOrCreateLocalIdentity } from './onboarding.js';

const VERSION = 1;
const NETWORKS = new Set(['lan', 'public']);
const LAN_TRANSPORTS = new Set(['local', 'tailscale']);
const ROLES = new Set(['host', 'client']);

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

function defaultState() {
  return { version: VERSION, setup: null, group: null };
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
    return Object.freeze({
      configured: Boolean(this.state.setup),
      identity: { id: this.identity.id, name: this.identity.name, createdAt: this.identity.createdAt },
      setup: this.state.setup ? { ...this.state.setup } : null,
      group: redactGroup(this.state.group),
    });
  }

  async configure({ network, lanTransport, role, groupName } = {}) {
    if (!NETWORKS.has(network)) throw new Error('SETUP_NETWORK_INVALID');
    if (!ROLES.has(role)) throw new Error('SETUP_ROLE_INVALID');
    if (network === 'lan' && !LAN_TRANSPORTS.has(lanTransport || 'local')) throw new Error('SETUP_LAN_TRANSPORT_INVALID');
    if (network === 'public' && lanTransport !== undefined) throw new Error('SETUP_PUBLIC_LAN_TRANSPORT_FORBIDDEN');
    if (groupName !== undefined && (typeof groupName !== 'string' || !groupName.trim() || groupName.length > 80)) throw new Error('SETUP_GROUP_NAME_INVALID');
    this.state.setup = Object.freeze({ network, role, ...(network === 'lan' ? { lanTransport: lanTransport || 'local' } : {}), ...(groupName ? { groupName: groupName.trim() } : {}) });
    this.state.group = null;
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
    const group = { id: roomId, name: this.state.setup.groupName || this.identity.name, transport, endpoint, secret, createdAt: now, expiresAt: now + ttlMs };
    const invite = createPairingInvite({ identity: this.identity, endpoint, now, ttlMs });
    this.state.group = group;
    await this.persist();
    return Object.freeze({ status: this.status(), invite, pairingCode: invite.code, roomId });
  }

  pairing() {
    if (!this.state?.group) return null;
    return { roomId: this.state.group.id, secret: this.state.group.secret, endpoint: this.state.group.endpoint };
  }

  async leave() {
    this.state.setup = null;
    this.state.group = null;
    await this.persist();
    return this.status();
  }
}

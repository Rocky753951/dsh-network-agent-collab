import { generateKeyPairSync, randomBytes, randomInt, randomUUID, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const IDENTITY_VERSION = 1;
const PAIRING_VERSION = 1;
const PAIRING_CODE_RE = /^\d{6}$/;

function equal(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

/** Load a local identity, creating a durable id and 256-bit pairing secret once. */
function createSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

export async function loadOrCreateLocalIdentity(path, { name = 'dsh-agent' } = {}) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.version === IDENTITY_VERSION && typeof value.id === 'string' && value.id && typeof value.secret === 'string' && Buffer.from(value.secret, 'base64url').length >= 32) {
      if (typeof value.privateKey === 'string' && typeof value.publicKey === 'string') return value;
      const upgraded = Object.freeze({ ...value, ...createSigningKeys() });
      await atomicJson(path, upgraded);
      return upgraded;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const identity = Object.freeze({ version: IDENTITY_VERSION, id: `agent-${randomUUID()}`, name, secret: randomBytes(32).toString('base64url'), ...createSigningKeys(), createdAt: Date.now() });
  await atomicJson(path, identity);
  return identity;
}

export function createPairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function unsignedInvite(invite) {
  return { version: invite.version, id: invite.id, hostId: invite.hostId, hostName: invite.hostName, hostPublicKey: invite.hostPublicKey, endpoint: invite.endpoint, expiresAt: invite.expiresAt, code: invite.code };
}

function unsignedGrant(grant) {
  return {
    requestId: grant.requestId,
    hostId: grant.hostId,
    hostName: grant.hostName,
    endpoint: grant.endpoint,
    roomId: grant.roomId,
    secret: grant.secret,
    approvedAt: grant.approvedAt,
    duration: grant.duration,
    permissionLevel: grant.permissionLevel,
    expiresAt: grant.expiresAt,
    ...(grant.directOffer ? { directOffer: grant.directOffer } : {}),
  };
}

/** Host-authenticate an approved grant with the Host's Ed25519 private key. */
export function signPairingGrant(grant, identity) {
  if (!identity?.privateKey) throw new Error('PAIRING_IDENTITY_KEY_REQUIRED');
  return cryptoSign(null, Buffer.from(JSON.stringify(unsignedGrant(grant))), identity.privateKey).toString('base64url');
}

export function verifyPairingGrant(grant, invite) {
  if (!grant || typeof grant.signature !== 'string' || !invite?.hostPublicKey) return false;
  try { return cryptoVerify(null, Buffer.from(JSON.stringify(unsignedGrant(grant))), invite.hostPublicKey, Buffer.from(grant.signature, 'base64url')); } catch { return false; }
}

/** Create a short-lived Host pairing offer. The secret remains Host-local. */
export function createPairingInvite({ identity, endpoint, now = Date.now(), ttlMs = 10 * 60_000, code = createPairingCode() }) {
  if (!identity?.id || !identity?.secret) throw new Error('PAIRING_IDENTITY_REQUIRED');
  if (typeof endpoint !== 'string' || !endpoint) throw new Error('PAIRING_ENDPOINT_REQUIRED');
  const signingKeys = identity.privateKey && identity.publicKey ? identity : { ...identity, ...createSigningKeys() };
  if (!PAIRING_CODE_RE.test(code)) throw new Error('PAIRING_CODE_INVALID');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 24 * 60 * 60_000) throw new Error('PAIRING_TTL_INVALID');
  const invite = { version: PAIRING_VERSION, id: randomUUID(), hostId: identity.id, hostName: identity.name || identity.id, hostPublicKey: signingKeys.publicKey, endpoint, expiresAt: now + ttlMs, code };
  const signature = cryptoSign(null, Buffer.from(JSON.stringify(unsignedInvite(invite))), signingKeys.privateKey).toString('base64url');
  return Object.freeze({ ...invite, signature });
}

export function validatePairingInvite(invite, now = Date.now()) {
  if (!invite || typeof invite !== 'object') return 'invite must be an object';
  if (invite.version !== PAIRING_VERSION || typeof invite.id !== 'string' || typeof invite.hostId !== 'string' || typeof invite.hostPublicKey !== 'string' || typeof invite.endpoint !== 'string') return 'invalid invite fields';
  if (!PAIRING_CODE_RE.test(invite.code || '')) return 'invalid pairing code';
  if (!Number.isSafeInteger(invite.expiresAt) || invite.expiresAt <= now) return 'pairing invite expired';
  if (typeof invite.signature !== 'string' || !invite.signature) return 'missing invite signature';
  try {
    if (!cryptoVerify(null, Buffer.from(JSON.stringify(unsignedInvite(invite))), invite.hostPublicKey, Buffer.from(invite.signature, 'base64url'))) return 'invalid invite signature';
  } catch { return 'invalid invite signature'; }
  return null;
}

/** Verify a Client-entered code against a Host-held invite without exposing the code in comparisons. */
export function verifyPairingCode(invite, code, now = Date.now()) {
  const invalid = validatePairingInvite(invite, now);
  if (invalid) return invalid;
  return equal(invite.code, code) ? null : 'pairing code mismatch';
}

export function encodePairingInvite(invite) {
  // Encoding is allowed for a just-created invite with a caller-supplied clock; expiry is enforced at decode/use time.
  const invalid = validatePairingInvite(invite, 0);
  if (invalid) throw new Error(invalid);
  return Buffer.from(JSON.stringify(invite)).toString('base64url');
}

export function decodePairingInvite(value, now = Date.now()) {
  try {
    const invite = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const invalid = validatePairingInvite(invite, now);
    if (invalid) throw new Error(invalid);
    return invite;
  } catch (error) {
    throw new Error(`PAIRING_INVITE_INVALID: ${error.message}`);
  }
}

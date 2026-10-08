import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

function hex(value) {
  return Buffer.from(value).toString('hex');
}

function eventId(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return createHash('sha256').update(serialized).digest('hex');
}

function secretKey() {
  // schnorr.sign rejects zero/out-of-range scalars; retrying is negligible for 32 random bytes.
  for (;;) {
    const candidate = randomBytes(32);
    try {
      schnorr.getPublicKey(candidate);
      return candidate;
    } catch {
      // Generate another scalar if the random value is outside secp256k1's range.
    }
  }
}

/**
 * Create a short-lived, memory-only Nostr signer for public pairing control traffic.
 * The private key is deliberately kept in the closure and is never returned.
 */
export function createEphemeralNostrSigner() {
  const secret = secretKey();
  const pubkey = hex(schnorr.getPublicKey(secret));
  let closed = false;
  return {
    async signEvent(input) {
      if (closed) throw new Error('NOSTR_SIGNER_CLOSED');
      const event = {
        ...input,
        pubkey,
        created_at: Number.isSafeInteger(input?.created_at) ? input.created_at : Math.floor(Date.now() / 1000),
      };
      const id = eventId(event);
      const sig = hex(await schnorr.sign(id, secret));
      return { ...event, id, sig };
    },
    close() {
      closed = true;
      secret.fill(0);
    },
    pubkey,
  };
}

/** Return a callback compatible with config.nostrSignEvent. */
export function createEphemeralNostrSignEvent() {
  const signer = createEphemeralNostrSigner();
  const signEvent = signer.signEvent.bind(signer);
  signEvent.close = signer.close;
  signEvent.pubkey = signer.pubkey;
  return signEvent;
}

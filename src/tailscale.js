import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read-only Tailscale integration. Internet transport is intentionally not activated yet. */
export async function tailscaleStatus() {
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 8_000, maxBuffer: 512 * 1024 });
    const status = JSON.parse(stdout);
    return {
      configured: true,
      backendState: status.BackendState || 'unknown',
      self: status.Self ? { id: status.Self.ID, dnsName: status.Self.DNSName, addresses: status.Self.TailscaleIPs || [], online: status.Self.Online } : null,
      peers: Object.values(status.Peer || {}).map((peer) => ({ id: peer.ID, dnsName: peer.DNSName, addresses: peer.TailscaleIPs || [], online: peer.Online })),
      transportReady: false,
      note: 'Tailscale discovery is available; Internet collaboration transport is intentionally not implemented in this version.',
    };
  } catch (error) {
    return { configured: false, transportReady: false, error: String(error.message || error), note: 'Install and log in to Tailscale, then configure mode: internet.' };
  }
}

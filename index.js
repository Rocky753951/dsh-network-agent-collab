import { homedir, hostname, networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FederationClient, JsonStore, dataPath } from './src/core.js';
import { SetupState } from './src/setup-state.js';
import { decodePairingInvite, encodePairingInvite } from './src/onboarding.js';
import { startClientPairingSignal, startHostPairingSignal } from './src/pairing-signal.js';
import { DirectPeer } from './src/direct-peer.js';
import { createRelay } from './relay.js';
import { tailscaleStatus } from './src/tailscale.js';
import { createUiHandler } from './src/ui-server.js';

const asText = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
const jsonOutput = { schema: {}, render: asText };

// Local implementation keeps linked workspace bundles independent of profile node_modules.
function defineTool({ parameters, output, execute, ...definition }) {
  const required = Object.entries(parameters).filter(([, spec]) => spec.required).map(([name]) => name);
  const properties = Object.fromEntries(Object.entries(parameters).map(([name, spec]) => {
    const { required: _required, ...schema } = spec;
    return [name, schema.type === 'json' ? {} : schema];
  }));
  return {
    ...definition,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    output: { schema: output.schema.type === 'json' ? {} : output.schema, render: output.render }, execute,
  };
}

export const inject = ['tools', 'agentLoop', 'webServer'];

/**
 * Dual-mode DSH collaboration host plugin.
 * lan: functioning signed WebSocket relay transport.
 * internet: Tailscale health/discovery scaffold only; it intentionally sends no collaboration traffic.
 */
export function apply(ctx, config = {}) {
  if (!ctx?.agentLoop || typeof ctx.agentLoop.create !== 'function') throw new Error('NETWORK_AGENT_COLLAB_REQUIRES_AGENT');
  const mode = config.mode || 'lan';
  if (!['lan', 'internet'].includes(mode)) throw new Error('network-agent-collab mode must be lan or internet');
  const networkScope = config.networkScope || 'lan';
  const lanTransport = config.lanTransport || 'local';
  const publicRole = config.publicRole || 'client';
  if (!['lan', 'public'].includes(networkScope)) throw new Error('network-agent-collab networkScope must be lan or public');
  if (networkScope === 'lan' && !['local', 'tailscale'].includes(lanTransport)) throw new Error('network-agent-collab lanTransport must be local or tailscale');
  if (networkScope === 'public' && !['host', 'client'].includes(publicRole)) throw new Error('network-agent-collab publicRole must be host or client');
  const secretValid = typeof config.sharedSecret === 'string' && config.sharedSecret !== 'CHANGE_ME' && Buffer.byteLength(config.sharedSecret) >= 32;
  if (mode === 'lan' && !secretValid) throw new Error('network-agent-collab LAN mode requires sharedSecret of at least 32 bytes');
  const roomId = config.roomId || 'default';
  const stateDir = config.dataDir || join(homedir(), '.dsh', 'network-agent-collab');
  const setupState = new SetupState({
    path: join(stateDir, 'setup.json'), identityPath: join(stateDir, 'identity.json'),
    displayName: config.agentName || `dsh-${hostname().toLowerCase()}`,
  });
  const setupReady = setupState.load();
  let embeddedRelay = null;
  let hostSignal = null;
  let clientSignal = null;
  let pendingGrant = null;
  let directPeer = null;
  let directOffer = null;
  // Stable by default on one machine; users may override when several DSH instances share a hostname.
  const configuredAgentId = config.agentId;
  const agentId = configuredAgentId && !configuredAgentId.startsWith('CHANGE_ME')
    ? configuredAgentId
    : `dsh-${hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'node'}`;
  const identity = { id: agentId, name: config.agentName || `dsh-${agentId.slice(0, 8)}`, capabilities: config.capabilities || ['chat', 'tasks', 'activation'], networkScope, lanTransport, publicRole };
  let client = null;
  let ready = Promise.resolve(null);
  const activationRuntime = config.activationRuntime || {};
  const deliverActivation = async (activation) => {
    if (activationRuntime.enabled === false) throw new Error('ACTIVATION_RUNTIME_DISABLED');
    const sessionId = `network-collab-${activation.id || randomUUID()}`;
    const agent = await ctx.agentLoop.create(sessionId, activationRuntime.agentOptions || {}, {
      ...(activationRuntime.cwd ? { cwd: activationRuntime.cwd } : {}),
    });
    if (typeof agent.followup !== 'function') throw new Error('AGENT_LOOP_FOLLOWUP_UNAVAILABLE');
    const text = [
      'A signed remote collaboration activation was approved for this DSH host.',
      `Activation ID: ${activation.id}`,
      `Requester: ${activation.requester}`,
      `Title: ${activation.title}`,
      activation.detail ? `Details: ${activation.detail}` : '',
      'Work on the request and communicate results through network_agent_message or network_agent_task.',
    ].filter(Boolean).join('\n');
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
    return { started: true, sessionId, agentId: agent.id };
  };
  if (mode === 'lan' && secretValid) {
    client = new FederationClient({
      relayUrl: config.relayUrl || 'ws://127.0.0.1:8787', roomId,
      secret: config.sharedSecret || 'CHANGE_ME', identity,
      store: new JsonStore(dataPath(stateDir, roomId)),
      privilegedApproverIds: config.privilegedApproverIds || [],
      onActivation: deliverActivation,
    });
    ready = client.start();
  }
  const requireLan = async () => {
    await ready;
    if (!client) throw new Error('Internet mode is Tailscale scaffold only; collaboration messaging is available in lan mode.');
    return client;
  };
  const localAddress = () => {
    for (const addresses of Object.values(networkInterfaces())) {
      const match = addresses?.find((item) => item.family === 'IPv4' && !item.internal);
      if (match) return match.address;
    }
    return '127.0.0.1';
  };
  const startPairedClient = async () => {
    await setupReady;
    const pairing = setupState.pairing();
    if (!pairing) throw new Error('PAIRING_NOT_CREATED');
    client?.close();
    const configured = setupState.status();
    const dynamicIdentity = { id: configured.identity.id, name: configured.identity.name, capabilities: config.capabilities || ['chat', 'tasks', 'activation'], networkScope: configured.setup.network, lanTransport: configured.setup.lanTransport || 'local', publicRole: configured.setup.role };
    client = new FederationClient({ relayUrl: pairing.endpoint, transport: pairing.endpoint.startsWith('direct://') ? directPeer : null, roomId: pairing.roomId, secret: pairing.secret, identity: dynamicIdentity, store: new JsonStore(dataPath(stateDir, pairing.roomId)), privilegedApproverIds: config.privilegedApproverIds || [], onActivation: deliverActivation });
    ready = client.start();
    await ready;
    return client;
  };
  const startHostSignal = async (invite) => {
    await hostSignal?.close?.();
    hostSignal = await startHostPairingSignal({ endpoint: invite.endpoint, inviteId: invite.id, onRequest: async (request) => {
      await setupState.receiveJoinRequest({ request });
    }});
  };
  const startClientSignal = async (request, invite) => {
    await clientSignal?.close?.();
    clientSignal = await startClientPairingSignal({ endpoint: invite.endpoint, inviteId: invite.id, request, onGrant: async (grant) => {
      pendingGrant = grant;
      await setupState.acceptJoinGrant({ grant });
      await startPairedClient();
    }});
  };
  // A pairing is local, durable state. Reconnect it on every plugin startup instead
  // of requiring the user to create a new Host/group after a DSH restart.
  const initialReady = ready;
  const restoreReady = setupReady.then(async () => {
    const pairing = setupState.pairing();
    const configured = setupState.status();
    if (!client && pairing) {
      // A persisted Host owns its embedded ws:// relay too. Rebind its original
      // port when possible so previously issued LAN invitations remain usable.
      if (configured.setup?.role === 'host') {
        try {
          const endpoint = new URL(pairing.endpoint);
          const port = Number(endpoint.port);
          if (endpoint.protocol === 'ws:' && Number.isSafeInteger(port) && port > 0) {
            embeddedRelay = await createRelay({ port });
          }
        } catch {
          // The relay may already be served externally or its old port is busy;
          // still restore the FederationClient and report the real connection state.
        }
      }
      await startPairedClient();
      if (configured.setup?.role === 'host') {
        const invite = setupState.status().activeInvite;
        if (invite) await startHostSignal(decodePairingInvite(invite.invitation));
      } else {
        const pending = setupState.pendingJoinRequest();
        if (pending) await startClientSignal(pending.request, pending.invite);
      }
    } else await initialReady;
    return client;
  });
  ready = restoreReady;
  const persistedNetwork = (status) => status.setup?.network || networkScope;
  const persistedLanTransport = (status) => status.setup?.lanTransport || lanTransport;
  const persistedPublicRole = (status) => status.setup?.role || publicRole;
  const register = (definition) => ctx.tools.register(defineTool(definition));
  const uiConfig = config.ui || {};

  ctx.effect(() => {
    const api = {
      async setupStatus() { await setupReady; return setupState.status(); },
      async setup(args) { await setupReady; return setupState.configure(args); },
      async hostCreate(args = {}) {
        await setupReady;
        const status = setupState.status();
        if (!status.setup || status.setup.role !== 'host') throw new Error('SETUP_HOST_ROLE_REQUIRED');
        const transport = status.setup.network === 'lan' ? status.setup.lanTransport : 'public';
        if (transport === 'public') {
          directPeer?.close();
          directPeer = new DirectPeer({ role: 'host' });
          directOffer = await directPeer.createOffer();
          const created = await setupState.createHost({ transport, endpoint: 'direct://manual' });
          await startPairedClient();
          return { ...created.status, invitation: encodePairingInvite(created.invite), pairingCode: created.pairingCode, expiresAt: created.invite.expiresAt, endpoint: 'direct://manual', directOffer, relay: { running: false } };
        }
        if (!embeddedRelay) embeddedRelay = await createRelay({ port: Number.isSafeInteger(args.port) ? args.port : 0 });
        const tailscale = transport === 'tailscale' ? await tailscaleStatus() : null;
        const advertisedHost = transport === 'tailscale'
          ? String(tailscale?.self?.dnsName || tailscale?.self?.addresses?.[0] || '').replace(/\.+$/, '')
          : localAddress();
        if (transport === 'tailscale' && !advertisedHost) throw new Error('TAILSCALE_NOT_READY');
        const endpoint = typeof args.endpoint === 'string' && args.endpoint ? args.endpoint : `ws://${advertisedHost}:${embeddedRelay.port}`;
        const created = await setupState.createHost({ transport, endpoint });
        await startPairedClient();
        await startHostSignal(created.invite);
        return { ...created.status, invitation: encodePairingInvite(created.invite), pairingCode: created.pairingCode, expiresAt: created.invite.expiresAt, endpoint, relay: { running: true, port: embeddedRelay.port } };
      },
      async pairLeave() {
        client?.close(); client = null; directPeer?.close(); directPeer = null; directOffer = null; await hostSignal?.close?.(); await clientSignal?.close?.(); hostSignal = null; clientSignal = null; pendingGrant = null; ready = Promise.resolve(null);
        if (embeddedRelay) { await embeddedRelay.close(); embeddedRelay = null; }
        await setupReady; return setupState.leave();
      },
      async relayRetry(args = {}) { return this.hostCreate(args); },
      async directOffer(args = {}) {
        await setupReady;
        if (setupState.status().setup?.role !== 'client') throw new Error('SETUP_CLIENT_ROLE_REQUIRED');
        if (!args.offer || !args.invitation) throw new Error('DIRECT_OFFER_AND_INVITATION_REQUIRED');
        const invite = decodePairingInvite(args.invitation);
        if (invite.endpoint !== 'direct://manual') throw new Error('DIRECT_INVITATION_REQUIRED');
        directPeer?.close();
        directPeer = new DirectPeer({ role: 'client' });
        const answer = await directPeer.acceptOffer(args.offer);
        const result = await setupState.requestJoin({ invitation: args.invitation, code: args.code || args.pairCode, clientName: args.clientName });
        return { ...result, answer };
      },
      async directAnswer(args = {}) {
        await setupReady;
        if (setupState.status().setup?.role !== 'host' || !directPeer) throw new Error('DIRECT_HOST_NOT_READY');
        if (!args.answer || typeof args.clientId !== 'string') throw new Error('DIRECT_ANSWER_INVALID');
        directPeer.acceptAnswer(args.answer);
        const request = await setupState.receiveJoinRequest({ request: { id: args.requestId || randomUUID(), inviteId: args.inviteId, clientId: args.clientId, clientName: args.clientName || args.clientId, createdAt: Date.now(), invitation: args.invitation, code: args.code } });
        return { ...request, connected: true };
      },
      async directGrant(args = {}) {
        await setupReady;
        if (setupState.status().setup?.role !== 'client' || !directPeer) throw new Error('DIRECT_CLIENT_NOT_READY');
        const result = await setupState.acceptJoinGrant({ grant: args.grant });
        await startPairedClient();
        return result;
      },
      async joinRequest(args = {}) {
        await setupReady;
        const role = setupState.status().setup?.role;
        if (role === 'client') {
          const invitation = args.invitation || args.invite;
          const result = await setupState.requestJoin({ ...args, invitation, code: args.code || args.pairCode });
          const invite = decodePairingInvite(invitation);
          await startClientSignal(result.request, invite);
          return result;
        }
        if (role === 'host') return setupState.receiveJoinRequest(args);
        throw new Error('SETUP_ROLE_REQUIRED');
      },
      async joinDecide(args = {}) {
        await setupReady;
        const role = setupState.status().setup?.role;
        if (role === 'host') {
          const result = await setupState.decideJoin(args);
          if (result.grant && hostSignal) await hostSignal.sendGrant(result.grant);
          if (result.grant && directPeer) return { ...result, grant: undefined, directGrant: result.grant };
          return { ...result, grant: result.grant ? { requestId: result.grant.requestId, approved: true } : undefined };
        }
        if (role === 'client') { const result = await setupState.acceptJoinGrant(args); await startPairedClient(); return result; }
        throw new Error('SETUP_ROLE_REQUIRED');
      },
      async membersRemove(args = {}) { await setupReady; return setupState.removeMember(args); },
      async snapshot() {
        await restoreReady;
        const localSetup = setupState.status();
        const currentNetworkScope = persistedNetwork(localSetup);
        const currentLanTransport = persistedLanTransport(localSetup);
        const currentPublicRole = persistedPublicRole(localSetup);
        const currentIdentity = localSetup.configured ? { ...identity, id: localSetup.identity.id, name: localSetup.identity.name, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole } : identity;
        const tailscale = await tailscaleStatus();
        if (mode === 'internet') return { mode, identity: currentIdentity, setup: localSetup, tailscale, transportReady: false, onboarding: { stage: 'tailscale-only', ready: false }, message: 'Tailscale discovery only.' };
        if (!client) {
          const stage = !localSetup.configured
            ? 'setup-required'
            : currentPublicRole === 'host' ? 'host-not-created' : 'awaiting-invitation';
          const message = !localSetup.configured
            ? '请选择网络与 Host/Client 身份。'
            : currentPublicRole === 'host' ? '已选择 Host；请创建协作组并生成配对码。' : '已选择 Client；请粘贴 Host 邀请并完成配对。';
          return { mode, identity: currentIdentity, setup: localSetup, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole, tailscale, transportReady: false, peers: {}, messages: [], tasks: {}, activations: {}, approvals: {}, onboarding: { stage, ready: false, matchedPeers: 0 }, message };
        }
        const federationClient = await requireLan();
        const connected = federationClient.isConnected();
        const federation = { mode, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole, transportReady: connected, ...(federationClient.snapshot()) };
        const matchedPeers = Object.values(federation.peers || {}).filter((peer) => peer.online !== false);
        const needsTailscale = currentNetworkScope === 'lan' && currentLanTransport === 'tailscale';
        const networkReady = !needsTailscale || Boolean(tailscale.configured && tailscale.self?.online);
        return { ...federation, identity: currentIdentity, setup: localSetup, tailscale, onboarding: {
          stage: !networkReady ? (!tailscale.configured ? 'tailscale-unavailable' : 'tailscale-offline') : !federation.transportReady ? 'relay-connecting' : matchedPeers.length ? 'matched' : 'waiting-for-peer',
          ready: Boolean(networkReady && federation.transportReady && matchedPeers.length),
          matchedPeers: matchedPeers.length,
        } };
      },
      async approve(args) { return { published: true, id: await (await requireLan()).approve(args) }; },
      async message(args) { return { sent: true, id: await (await requireLan()).message(args) }; },
      async activate(args) { return { requested: true, activationId: await (await requireLan()).activate(args) }; },
      async task(args) { return { published: true, id: await (await requireLan()).task(args) }; },
    };
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    const fallbackUi = null;
    const unregisterUi = uiConfig.enabled === false ? () => {} : webServer
      ? webServer.register({ kind: 'prefix', path: '/network-agent-collab', handler: createUiHandler(api, '/network-agent-collab') })
      : () => {};
    const unregister = [
      register({
        name: 'network_agent_status', description: 'Read this collaboration plugin mode and LAN federation state.', parameters: {}, output: jsonOutput,
        async execute() {
          await restoreReady;
          const localSetup = setupState.status();
          const currentNetworkScope = persistedNetwork(localSetup);
          const currentLanTransport = persistedLanTransport(localSetup);
          const currentPublicRole = persistedPublicRole(localSetup);
          const currentIdentity = localSetup.configured ? { ...identity, id: localSetup.identity.id, name: localSetup.identity.name, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole } : identity;
          if (mode === 'internet') return { mode, identity: currentIdentity, transportReady: false, message: 'Tailscale scaffold only; no Internet collaboration transport.' };
          if (!client) {
            const stage = !localSetup.configured ? 'setup-required' : currentPublicRole === 'host' ? 'host-not-created' : 'awaiting-invitation';
            return { mode, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole, identity: currentIdentity, transportReady: false, configured: localSetup.configured, missing: localSetup.configured ? ['pairing'] : ['setup'], onboarding: { stage, ready: false }, message: !localSetup.configured ? 'Select network and Host/Client identity.' : currentPublicRole === 'host' ? 'Create a host group to start collaboration.' : 'Join a Host invitation to start collaboration.' };
          }
          const federation = await requireLan();
          return { mode, networkScope: currentNetworkScope, lanTransport: currentLanTransport, publicRole: currentPublicRole, identity: currentIdentity, transportReady: federation.isConnected(), ...(federation.snapshot()) };
        },
      }),
      register({
        name: 'network_agent_tailscale_status', description: 'Read-only Tailscale status for the Internet-mode scaffold; does not send collaboration traffic.', parameters: {}, output: jsonOutput,
        async execute() { return { mode, ...(await tailscaleStatus()) }; },
      }),
      register({
        name: 'network_agent_peers', description: 'List recently announced LAN collaboration agents in the current room.', parameters: {}, output: jsonOutput,
        async execute() { const state = (await requireLan()).snapshot(); return Object.values(state.peers); },
      }),
      register({
        name: 'network_agent_message', description: 'Send a signed LAN collaboration message to all peers or one peer id.', parameters: {
          text: { type: 'string', required: true, description: 'Concise message for peer agents.' },
          to: { type: 'string', description: 'Peer id, or all when omitted.' },
          topic: { type: 'string', description: 'Message topic.' },
        }, output: jsonOutput,
        async execute(args) { return { sent: true, id: await (await requireLan()).message(args) }; },
      }),
      register({
        name: 'network_agent_activate', description: 'Deliver a signed collaboration activation request. The receiving DSH starts a local agent only after its configured approval policy is satisfied. Approval levels: none, peer, privileged.', parameters: {
          target: { type: 'string', required: true, description: 'Receiving peer id or all.' },
          title: { type: 'string', required: true, description: 'Requested collaboration activity.' },
          detail: { type: 'string', description: 'Context and acceptance criteria.' },
          approvalLevel: { type: 'string', enum: ['none', 'peer', 'privileged'], description: 'none activates immediately; peer needs recipient approval; privileged needs recipient high-level approval.' },
        }, output: jsonOutput,
        async execute(args) { return { requested: true, activationId: await (await requireLan()).activate(args) }; },
      }),
      register({
        name: 'network_agent_approve', description: 'Approve or reject a pending activation addressed to this local agent only. An approved request starts a local DSH agent; privileged approvals require this agent id in privilegedApproverIds.', parameters: {
          activationId: { type: 'string', required: true, description: 'Activation request id.' },
          decision: { type: 'string', required: true, enum: ['approved', 'rejected'] },
          note: { type: 'string', description: 'Reason or coordination note.' },
        }, output: jsonOutput,
        async execute(args) { return { published: true, id: await (await requireLan()).approve(args) }; },
      }),
      register({
        name: 'network_agent_task', description: 'Create or update a shared LAN task. Actions are create, claim, update, complete, or cancel.', parameters: {
          id: { type: 'string', required: true, description: 'Stable task id.' },
          action: { type: 'string', required: true, enum: ['create', 'claim', 'update', 'complete', 'cancel'] },
          title: { type: 'string', description: 'Task title; required for create.' },
          detail: { type: 'string', description: 'Task detail or update.' },
          assignee: { type: 'string', description: 'Peer id assigned to the task.' },
          status: { type: 'string', enum: ['open', 'claimed', 'in_progress', 'done', 'cancelled'] },
        }, output: jsonOutput,
        async execute(args) { return { published: true, id: await (await requireLan()).task(args) }; },
      }),
    ];
    return () => { client?.close(); hostSignal?.close?.(); clientSignal?.close?.(); embeddedRelay?.close(); fallbackUi?.close(); unregisterUi(); unregister.forEach((dispose) => dispose()); };
  });
}
apply.inject = inject;

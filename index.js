import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FederationClient, JsonStore, dataPath } from './src/core.js';
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
  const mode = config.mode || 'lan';
  if (!['lan', 'internet'].includes(mode)) throw new Error('network-agent-collab mode must be lan or internet');
  const roomId = config.roomId || 'default';
  // Stable by default on one machine; users may override when several DSH instances share a hostname.
  const configuredAgentId = config.agentId;
  const agentId = configuredAgentId && !configuredAgentId.startsWith('CHANGE_ME')
    ? configuredAgentId
    : `dsh-${hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'node'}`;
  const secretValid = typeof config.sharedSecret === 'string' && config.sharedSecret !== 'CHANGE_ME' && Buffer.byteLength(config.sharedSecret) >= 32;
  const identity = { id: agentId, name: config.agentName || `dsh-${agentId.slice(0, 8)}`, capabilities: config.capabilities || ['chat', 'tasks', 'activation'] };
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
    const stateDir = config.dataDir || join(homedir(), '.dsh', 'network-agent-collab');
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
  const register = (definition) => ctx.tools.register(defineTool(definition));
  const uiConfig = config.ui || {};

  ctx.effect(() => {
    const api = {
      async snapshot() {
        const tailscale = await tailscaleStatus();
        if (mode === 'internet') return { mode, identity, tailscale, transportReady: false, onboarding: { stage: 'tailscale-only', ready: false }, message: 'Tailscale discovery only.' };
        if (!client) return { mode, identity, tailscale, transportReady: false, peers: {}, messages: [], tasks: {}, activations: {}, approvals: {}, onboarding: { stage: 'configuration-required', ready: false, missing: ['sharedSecret'], matchedPeers: 0 }, message: '请在 profile config 中设置至少 32 字节的 sharedSecret。' };
        const federation = { mode, transportReady: true, ...(await requireLan()).snapshot() };
        const matchedPeers = Object.values(federation.peers || {}).filter((peer) => peer.online !== false);
        return { ...federation, tailscale, onboarding: {
          stage: !tailscale.configured ? 'tailscale-unavailable' : !tailscale.self?.online ? 'tailscale-offline' : matchedPeers.length ? 'matched' : 'waiting-for-peer',
          ready: Boolean(tailscale.configured && tailscale.self?.online && federation.transportReady && matchedPeers.length),
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
          if (mode === 'internet') return { mode, identity, transportReady: false, message: 'Tailscale scaffold only; no Internet collaboration transport.' };
          if (!client) return { mode, identity, transportReady: false, configured: false, missing: ['sharedSecret'], message: 'Configure a sharedSecret of at least 32 bytes.' };
          return { mode, transportReady: true, ...(await requireLan()).snapshot() };
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
    return () => { client?.close(); fallbackUi?.close(); unregisterUi(); unregister.forEach((dispose) => dispose()); };
  });
}
apply.inject = inject;

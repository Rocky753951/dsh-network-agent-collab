window.__ModuleLoader__.load({
  id: 'dsh-network-agent-collab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const e = (type, props, ...children) => h(type, props, ...children);
    const styles = { insert(css) {
      const node = document.createElement('style');
      node.dataset.dshNetworkAgentCollab = 'true';
      node.textContent = css;
      document.head.appendChild(node);
      return () => node.remove();
    } };
    // Use the DSH Web origin so local and remote/HTTPS pages share the same API.
    const API = `${window.location.origin}/network-agent-collab`;

    async function call(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error || 'REQUEST_FAILED');
      return value;
    }
    const time = (value) => value ? new Date(value).toLocaleString() : '—';
    const tone = (value) => value === 'approved' || value === 'done' || value === 'activated' ? 'success'
      : value === 'rejected' || value === 'cancelled' ? 'error' : 'warn';

    function Stat({ label, value, tone: kind }) {
      return e('div', { className: 'nac-stat' }, e('span', null, label), e('strong', { className: kind ? `nac-${kind}` : '' }, value));
    }
    function Badge({ value }) { return e('span', { className: `nac-badge nac-${tone(value)}` }, value || 'unknown'); }
    function Empty({ children }) { return e('div', { className: 'nac-empty' }, children); }

    function Dashboard() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState({ to: '', text: '', topic: '' });
      const [task, setTask] = React.useState({ id: '', title: '', detail: '', assignee: '' });
      const [pairInfo, setPairInfo] = React.useState(null);
      const refresh = React.useCallback(async () => {
        setBusy(true); setError('');
        try { setState(await call('/snapshot')); } catch (err) { setError(`无法连接本机协作桥接：${err.message}`); }
        finally { setBusy(false); }
      }, []);
      React.useEffect(() => { refresh(); }, [refresh]);
      const act = async (path, payload) => { setBusy(true); setError(''); try { await call(path, payload); await refresh(); } catch (err) { setError(err.message); setBusy(false); } };
      const peers = Object.values(state?.peers || {});
      const tasks = Object.values(state?.tasks || {});
      const activations = Object.values(state?.activations || {}).filter((x) => x.target === state?.identity?.id);
      const pending = activations.filter((x) => x.status === 'pending');
      const ready = Boolean(state?.onboarding?.ready);
      const [setup, setSetup] = React.useState(() => {
        try { return JSON.parse(window.localStorage.getItem('dsh-network-agent-collab.setup') || 'null') || {}; } catch { return {}; }
      });
      const chooseSetup = (patch) => {
        const next = { ...setup, ...patch };
        setSetup(next);
        try { window.localStorage.setItem('dsh-network-agent-collab.setup', JSON.stringify(next)); } catch {}
      };
      const saveSetup = async (role) => {
        const payload = { network: setup.scope, role, ...(setup.scope === 'lan' ? { lanTransport: setup.transport || 'local' } : {}) };
        setBusy(true); setError('');
        try { await call('/setup', payload); chooseSetup({ role }); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(false); }
      };
      const createHost = async () => {
        setBusy(true); setError('');
        try { const result = await call('/host/create', {}); setPairInfo(result); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(false); }
      };
      const stageText = { 'configuration-required': '需要配置 sharedSecret', 'tailscale-only': 'Tailscale 已检测（当前仅状态模式）', 'tailscale-unavailable': '正在等待 Tailscale 登录', 'tailscale-offline': 'Tailscale 未在线', 'relay-connecting': '正在连接 Relay', 'waiting-for-peer': '正在等待并匹配其他 DSH 节点', matched: '节点已匹配，可选择协作方式' };
      return e('main', { className: 'nac-page' },
        e('header', { className: 'nac-header' },
          e('div', null, e('h1', null, 'Agent 协作中心'), e('p', null, '多端 DSH 节点、任务与激活审批管理')),
          e('button', { className: 'nac-button', onClick: refresh, disabled: busy }, busy ? '同步中…' : '刷新')),
        error && e('div', { className: 'nac-alert', role: 'alert' }, error),
        !setup.scope && e('section', { className: 'nac-card nac-setup' }, e('h2', null, '首次设置协作方式'), e('p', null, '先选择网络范围，再选择本机身份。之后插件会自动检测可用设备。'), e('div', { className: 'nac-choice-row' }, e('button', { className: 'nac-button', onClick: () => chooseSetup({ scope: 'lan' }) }, '局域网（物理网络 / Tailscale）'), e('button', { className: 'nac-button', onClick: () => chooseSetup({ scope: 'public' }) }, '公网 P2P'))),
        setup.scope && !setup.role && e('section', { className: 'nac-card nac-setup' }, e('h2', null, setup.scope === 'public' ? '公网 P2P 身份' : '局域网身份'), e('p', null, setup.scope === 'public' ? '公网模式使用 Host + Client；Host 生成邀请信息，Client 粘贴加入。' : '局域网由一台电脑创建协作组，其他电脑发现后申请加入。'), setup.scope === 'lan' && e('div', { className: 'nac-choice-row' }, e('button', { className: `nac-button ${setup.transport === 'tailscale' ? 'nac-selected' : ''}`, onClick: () => chooseSetup({ transport: 'tailscale' }) }, 'Tailscale 虚拟局域网'), e('button', { className: `nac-button ${!setup.transport || setup.transport === 'local' ? 'nac-selected' : ''}`, onClick: () => chooseSetup({ transport: 'local' }) }, '物理局域网')), e('div', { className: 'nac-choice-row' }, e('button', { className: 'nac-button', disabled: busy, onClick: () => saveSetup('host') }, '创建协作组（Host）'), e('button', { className: 'nac-button', disabled: busy, onClick: () => saveSetup('client') }, '加入协作组（Client）')), e('button', { className: 'nac-link', onClick: () => { setSetup({}); try { window.localStorage.removeItem('dsh-network-agent-collab.setup'); } catch {} } }, '返回选择网络方式')), 
        setup.role === 'host' && !state?.setup?.group && e('section', { className: 'nac-card nac-setup' }, e('h2', null, '启动本机协作组'), e('p', null, '将自动启动本机 Relay，并生成 5 分钟有效的一次性配对码。'), e('button', { className: 'nac-button', disabled: busy, onClick: createHost }, '启动 Host 并生成配对码')),
        pairInfo && e('section', { className: 'nac-card nac-setup' }, e('h2', null, '邀请 Client 加入'), e('p', null, `六位配对码：${pairInfo.pairingCode}`), e('textarea', { readOnly: true, value: pairInfo.invitation || '', 'aria-label': '邀请信息' }), e('small', null, `有效至：${time(pairInfo.expiresAt)}`)), 
        state && e('div', { className: ready ? 'nac-onboard nac-onboard-ready' : 'nac-onboard' }, e('strong', null, ready ? '✓ 节点已匹配' : state.onboarding?.stage === 'configuration-required' ? '配置未完成' : '自动检测中'), e('span', null, stageText[state.onboarding?.stage] || '正在检测 Tailscale 与 Relay'), e('small', null, state.networkScope === 'public' ? '公网 P2P · Host/Client' : state.lanTransport === 'tailscale' ? `Tailscale · ${state.tailscale?.self?.dnsName || '未检测到'}` : '物理局域网')),
        !state ? e(Empty, null, '正在读取协作状态…') : e(React.Fragment, null,
          e('section', { className: 'nac-stats' },
            e(Stat, { label: '本机节点', value: state.identity?.name || state.identity?.id || '—' }),
            e(Stat, { label: '传输状态', value: state.transportReady ? '已连接' : '未就绪', tone: state.transportReady ? 'success' : 'warn' }),
            e(Stat, { label: '在线节点', value: peers.length }),
            e(Stat, { label: '待确认激活', value: pending.length, tone: pending.length ? 'warn' : 'success' })),
          e('section', { className: 'nac-grid' },
            e('div', { className: 'nac-card' }, e('h2', null, '节点'), peers.length ? e('ul', { className: 'nac-list' }, peers.map((peer) => e('li', { key: peer.id }, e('div', null, e('strong', null, peer.name || peer.id), e('small', null, peer.id)), e('span', null, time(peer.lastSeen))))) : e(Empty, null, '尚未发现其他节点')),
            e('div', { className: 'nac-card' }, e('h2', null, '待确认激活'), pending.length ? e('div', { className: 'nac-stack' }, pending.map((item) => e('article', { className: 'nac-request', key: item.id }, e('div', null, e('strong', null, item.title), e('p', null, item.detail || '无附加说明'), e('small', null, `请求方：${item.requester} · ${item.approvalLevel || 'peer'}`)), e('div', { className: 'nac-actions' }, e('button', { className: 'nac-button nac-approve', disabled: busy, onClick: () => act('/approve', { activationId: item.id, decision: 'approved' }) }, '批准并启动'), e('button', { className: 'nac-button nac-reject', disabled: busy, onClick: () => act('/approve', { activationId: item.id, decision: 'rejected' }) }, '拒绝'))))) : e(Empty, null, '没有需要确认的激活请求')),
            e('div', { className: 'nac-card' }, e('h2', null, '共享任务'), tasks.length ? e('div', { className: 'nac-stack' }, tasks.map((item) => e('article', { className: 'nac-task', key: item.id }, e('div', null, e('strong', null, item.title || item.id), e('p', null, item.detail || '—'), e('small', null, item.assignee ? `负责人：${item.assignee}` : '未分配')), e(Badge, { value: item.status || 'open' })))) : e(Empty, null, '当前没有共享任务'))),
          e('section', { className: 'nac-grid' },
            e('form', { className: 'nac-card', onSubmit: (event) => { event.preventDefault(); if (message.text.trim()) act('/message', message).then(() => setMessage({ to: '', text: '', topic: '' })); } }, e('h2', null, '发送协作消息'), e('input', { placeholder: '目标节点 ID（留空为广播）', value: message.to, onChange: (x) => setMessage({ ...message, to: x.target.value }) }), e('input', { placeholder: '主题（可选）', value: message.topic, onChange: (x) => setMessage({ ...message, topic: x.target.value }) }), e('textarea', { required: true, placeholder: '消息内容', value: message.text, onChange: (x) => setMessage({ ...message, text: x.target.value }) }), e('button', { className: 'nac-button', disabled: busy || !ready, type: 'submit' }, ready ? '发送消息' : '匹配后可发送')),
            e('form', { className: 'nac-card', onSubmit: (event) => { event.preventDefault(); if (task.id.trim() && task.title.trim()) act('/task', { ...task, action: 'create', status: 'open' }).then(() => setTask({ id: '', title: '', detail: '', assignee: '' })); } }, e('h2', null, '创建共享任务'), e('input', { required: true, placeholder: '任务 ID', value: task.id, onChange: (x) => setTask({ ...task, id: x.target.value }) }), e('input', { required: true, placeholder: '任务标题', value: task.title, onChange: (x) => setTask({ ...task, title: x.target.value }) }), e('input', { placeholder: '负责人节点 ID（可选）', value: task.assignee, onChange: (x) => setTask({ ...task, assignee: x.target.value }) }), e('textarea', { placeholder: '任务说明', value: task.detail, onChange: (x) => setTask({ ...task, detail: x.target.value }) }), e('button', { className: 'nac-button', disabled: busy || !ready, type: 'submit' }, ready ? '创建任务' : '匹配后可创建')))));
    }
    function PanelIcon({ size }) { return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, e('circle', { cx: 6, cy: 6, r: 2.4 }), e('circle', { cx: 18, cy: 7, r: 2.4 }), e('circle', { cx: 12, cy: 18, r: 2.4 }), e('path', { d: 'M8 7.2l7.7-.5M7.2 8l3.6 7.7m6-6.5l-3.5 6.4' })); }
    return { inject: ['slots'], apply(ctx) {
      const disposeStyle = styles.insert(`
        .nac-page{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);height:100%;overflow:auto;padding:28px 32px;box-sizing:border-box;font:14px/1.45 system-ui,sans-serif}.nac-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:24px}.nac-header h1{font-size:22px;margin:0 0 4px}.nac-header p,.nac-card p,.nac-card small{color:var(--dsw-alias-label-secondary);margin:0}.nac-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.nac-stat,.nac-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}.nac-stat{padding:14px}.nac-stat span{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}.nac-stat strong{display:block;margin-top:4px;font-size:17px}.nac-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}.nac-card{padding:16px}.nac-card h2{font-size:15px;margin:0 0 12px}.nac-list,.nac-stack{padding:0;margin:0;list-style:none}.nac-list li,.nac-request,.nac-task{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.nac-list li:first-child,.nac-request:first-child,.nac-task:first-child{border-top:0}.nac-card input,.nac-card textarea{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:9px;margin:0 0 9px;font:inherit}.nac-card textarea{min-height:72px;resize:vertical}.nac-button{background:var(--dsw-alias-brand-primary);color:#fff;border:0;border-radius:7px;padding:8px 12px;font:inherit;cursor:pointer}.nac-button:disabled{opacity:.55;cursor:wait}.nac-selected{outline:2px solid var(--dsw-alias-state-success-primary)}.nac-setup{margin:16px 0}.nac-choice-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.nac-link{background:none;border:0;color:var(--dsw-alias-brand-primary);padding:8px 0;cursor:pointer;font:inherit}.nac-actions{display:flex;gap:8px;align-items:flex-start}.nac-reject{background:var(--dsw-alias-state-error-primary)}.nac-approve{background:var(--dsw-alias-state-success-primary)}.nac-badge{font-size:12px;padding:3px 7px;border-radius:999px}.nac-success{color:var(--dsw-alias-state-success-primary)}.nac-warn{color:var(--dsw-alias-state-warn-primary)}.nac-error{color:var(--dsw-alias-state-error-primary)}.nac-alert,.nac-empty{padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}.nac-onboard{display:flex;gap:12px;align-items:center;padding:12px 14px;margin-bottom:16px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-warn-primary)}.nac-onboard span,.nac-onboard small{color:var(--dsw-alias-label-secondary)}.nac-onboard-ready{border-color:var(--dsw-alias-state-success-primary)}.nac-alert{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}@media(max-width:780px){.nac-page{padding:20px}.nac-stats,.nac-grid{grid-template-columns:1fr 1fr}.nac-grid{grid-template-columns:1fr}}`);
      const offA = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'network-agent-collab', order: 24, label: () => '协作中心' }, PanelIcon));
      const offB = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'network-agent-collab' }, Dashboard));
      return () => { disposeStyle(); offA(); offB(); };
    }};
  },
});

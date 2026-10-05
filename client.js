window.__ModuleLoader__.load({
  id: 'dsh-network-agent-collab',
  factory(require) {
    const React = require('react');
    const e = React.createElement;
    const API = `${window.location.origin}/network-agent-collab`;
    const time = (value) => value ? new Date(value).toLocaleString() : '—';

    async function call(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok || value.error) throw new Error(value.error || 'REQUEST_FAILED');
      return value;
    }
    function Button({ children, variant = 'primary', className = '', ...props }) { return e('button', { className: `nac-button nac-button-${variant} ${className}`.trim(), ...props }, children); }
    function BackButton({ children, onClick, danger = false }) { return e('button', { className: danger ? 'nac-button nac-button-danger' : 'nac-button nac-button-ghost', onClick }, `← ${children}`); }
    function Card({ title, children, className = '' }) { return e('section', { className: `nac-card ${className}`.trim() }, title && e('h2', null, title), children); }
    function Empty({ children }) { return e('div', { className: 'nac-empty' }, children); }
    function CopyButton({ value }) { const [copied, setCopied] = React.useState(false); const copy = async () => { try { await navigator.clipboard.writeText(value || ''); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {} }; return e(Button, { variant: 'secondary', className: 'nac-copy', onClick: copy, disabled: !value }, copied ? '已复制' : '复制'); }
    function CodeBlock({ title, value, children }) { const long = (value || '').length > 900; return e('div', { className: 'nac-code-block' }, e('div', { className: 'nac-code-head' }, e('strong', null, title), e(CopyButton, { value })), children || (long ? e('details', null, e('summary', null, '展开完整信令'), e('pre', null, value || '—')) : e('pre', null, value || '—'))); }
    function ConnectionStatus({ connected, message }) { return e('div', { className: connected ? 'nac-status nac-status-ok' : 'nac-status nac-status-wait' }, e('strong', null, connected ? '● 已连接' : '◌ 等待配对'), e('span', null, message || (connected ? '协作通道已建立' : '请完成配对或交换公网信令'))); }

    function Dashboard() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [network, setNetwork] = React.useState(null);
      const [transport, setTransport] = React.useState('local');
      const [role, setRole] = React.useState(null);
      const [invite, setInvite] = React.useState('');
      const [pairCode, setPairCode] = React.useState('');
      const [publicEndpoint, setPublicEndpoint] = React.useState('');
      const [directPackage, setDirectPackage] = React.useState('');
      const [hostDirectOffer, setHostDirectOffer] = React.useState('');
      const [hostDirectAnswer, setHostDirectAnswer] = React.useState('');
      const [directGrant, setDirectGrant] = React.useState('');
      const [clientGrant, setClientGrant] = React.useState('');
      const [hostInfo, setHostInfo] = React.useState(null);
      const [joinStatus, setJoinStatus] = React.useState(null);
      const [duration, setDuration] = React.useState('once');
      const [permissionLevel, setPermissionLevel] = React.useState('communication');
      const [message, setMessage] = React.useState({ to: '', text: '', topic: '' });
      const [task, setTask] = React.useState({ id: '', title: '', detail: '', assignee: '' });
      const refresh = React.useCallback(async () => {
        try { setState(await call('/snapshot')); } catch (err) { setError(`无法读取协作状态：${err.message}`); }
      }, []);
      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 2000);
        return () => clearInterval(timer);
      }, [refresh]);
      const run = async (fn) => { setBusy(true); setError(''); try { return await fn(); } catch (err) { setError(err.message); return null; } finally { setBusy(false); } };
      const configured = state?.setup?.configured;
      const savedSetup = state?.setup?.setup;
      const paired = Boolean(state?.setup?.group || state?.onboarding?.ready);
      const stageText = {
        'setup-required': '请选择网络与本机身份。',
        'waiting-for-host': '尚未创建或加入协作组。',
        'relay-connecting': '正在连接本机 Relay。',
        'public-waiting-for-signal': '等待手工交换 Offer、Answer 和 Grant；公网模式不使用 Relay。',
        'public-waiting-for-peer': '直连信令已交换，正在等待对方建立 DataChannel。',
        'waiting-for-peer': '协作组已启动，正在等待其他设备加入。',
        matched: '节点已匹配，可以开始协作。',
        'tailscale-unavailable': '未检测到可用的 Tailscale 登录。',
        'tailscale-offline': 'Tailscale 当前离线。',
      };
      const saveSetup = () => run(async () => {
        const result = await call('/setup', { network, role, ...(network === 'lan' ? { lanTransport: transport } : {}) });
        await refresh(); return result;
      });
      const createHost = () => run(async () => {
        const result = await call('/host/create', publicEndpoint.trim() ? { endpoint: publicEndpoint.trim() } : {}); setHostInfo(result); if (result.directOffer) setHostDirectOffer(JSON.stringify(result.directOffer, null, 2)); await refresh(); return result;
      });
      const requestJoin = () => run(async () => {
        const result = network === 'public'
          ? await call('/direct/offer', { offer: JSON.parse(hostDirectOffer || '{}'), invitation: invite.trim(), code: pairCode.trim() })
          : await call('/join/request', { invite: invite.trim(), pairCode: pairCode.trim() });
        if (network === 'public') setDirectPackage(JSON.stringify({ answer: result.answer, request: result.request }, null, 2));
        setJoinStatus(result); await refresh(); return result;
      });
      const submitDirectAnswer = () => run(async () => {
        const packet = JSON.parse(directPackage);
        const result = await call('/direct/answer', { answer: packet.answer, ...packet.request });
        await refresh(); return result;
      });
      const acceptDirectGrant = () => run(async () => { const result = await call('/direct/grant', { grant: JSON.parse(clientGrant) }); await refresh(); return result; });
      const leave = () => { if (window.confirm('确定退出协作并清除当前配对吗？')) return run(async () => { await call('/pair/leave', {}); setNetwork(null); setRole(null); setHostInfo(null); setJoinStatus(null); await refresh(); }); };
      const peers = Object.values(state?.peers || {});
      const tasks = Object.values(state?.tasks || {});
      const activations = Object.values(state?.activations || {}).filter((item) => item.target === state?.identity?.id && item.status === 'pending');

      const activeInvite = hostInfo || state?.setup?.activeInvite;
      const pendingJoinRequests = state?.setup?.pendingRequests || [];
      const decideJoin = (requestId, decision) => run(async () => {
        const result = await call('/join/decide', { requestId, decision, duration, permissionLevel });
        if (result.directGrant) setDirectGrant(JSON.stringify(result.directGrant, null, 2));
        await refresh(); return result;
      });
      const approvalFields = e('div', { className: 'nac-approval-fields' },
        e('label', null, '权限时间', e('select', { value: duration, onChange: (event) => setDuration(event.target.value) },
          e('option', { value: 'once' }, '单次'), e('option', { value: '24h' }, '24 小时'), e('option', { value: 'permanent' }, '永久'))),
        e('label', null, '权限等级', e('select', { value: permissionLevel, onChange: (event) => setPermissionLevel(event.target.value) },
          e('option', { value: 'communication' }, '仅通信'), e('option', { value: 'wake-approval' }, '可唤醒 Agent（需审批）'), e('option', { value: 'trusted' }, '无条件信任')))
      );

      if (!configured) {
        if (!network) return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('div', null, e('h1', null, 'Agent 协作中心'), e('p', null, '选择本次协作使用的网络。'))), e(Card, { title: '选择网络' }, e('p', null, '此选择独立于后续协作页面。'), e('div', { className: 'nac-choice-row' }, e(Button, { onClick: () => setNetwork('lan') }, '局域网'), e(Button, { onClick: () => setNetwork('public') }, '公网 P2P'))));
        if (!role) return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('h1', null, network === 'lan' ? '局域网设置' : '公网 P2P 设置')), network === 'lan' && e(Card, { title: '局域网类型' }, e('div', { className: 'nac-choice-row' }, e(Button, { className: transport === 'local' ? 'nac-button nac-selected' : 'nac-button', onClick: () => setTransport('local') }, '物理局域网'), e(Button, { className: transport === 'tailscale' ? 'nac-button nac-selected' : 'nac-button', onClick: () => setTransport('tailscale') }, 'Tailscale 虚拟局域网'))), e(Card, { title: '选择身份' }, e('p', null, 'Host 创建协作组并管理成员；Client 申请加入。'), e('div', { className: 'nac-choice-row' }, e(Button, { onClick: () => setRole('host') }, '创建协作组（Host）'), e(Button, { onClick: () => setRole('client') }, '加入协作组（Client）')), e(BackButton, { onClick: () => setNetwork(null) }, '返回网络选择')));
        return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('h1', null, '确认设置')), e(Card, { title: role === 'host' ? '创建 Host' : '加入 Client' }, e('p', null, `${network === 'lan' ? (transport === 'tailscale' ? 'Tailscale 局域网' : '物理局域网') : '公网 P2P'} · ${role === 'host' ? 'Host' : 'Client'}`), e(Button, { disabled: busy, onClick: saveSetup }, '继续'), e(BackButton, { onClick: () => setRole(null) }, '返回身份选择')));
      }

      if (savedSetup?.role === 'host' && !state?.setup?.group) return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('h1', null, '创建协作组')), e(Card, { title: '启动本机 Host' }, e('p', null, network === 'public' ? 'Host 将生成 WebRTC Offer；请与 Client 手动交换信令。' : '插件会启动内置 Relay 并生成一次性邀请。'), network === 'public' && e(CodeBlock, { title: 'Host Offer（复制给 Client）', value: hostDirectOffer }), network === 'public' && e('label', { className: 'nac-field' }, e('span', null, '对方返回的连接信息'), e('textarea', { 'aria-label': '对方返回的连接信息', placeholder: '请把 Client 发回的连接信息粘贴到这里', value: hostDirectAnswer, onChange: (event) => setHostDirectAnswer(event.target.value) })), network === 'public' && hostDirectAnswer && e(Button, { disabled: busy, onClick: () => run(async () => { const packet = JSON.parse(hostDirectAnswer); await call('/direct/answer', { answer: packet.answer, ...packet.request }); await refresh(); }) }, '确认对方连接'), network === 'public' && e('label', { className: 'nac-field' }, e('span', null, '公网地址（可选）'), e('input', { 'aria-label': '公网地址（可选）', placeholder: '无需填写；手动 WebRTC 信令', value: publicEndpoint, onChange: (event) => setPublicEndpoint(event.target.value) })), e(Button, { disabled: busy, onClick: createHost }, '发布 Host 并生成配对码')), e(BackButton, { onClick: leave, danger: true }, '退出协作'));
      if (savedSetup?.role === 'host' && activeInvite && (!paired || peers.length === 0)) return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('h1', null, '邀请 Client 加入')), e(Card, { title: '一次性配对信息' }, e('div', { className: 'nac-pair-code' }, e('span', null, '六位配对码'), e('strong', null, activeInvite.pairingCode || '—'), e('small', null, `有效至：${time(activeInvite.expiresAt)}`)), e(CodeBlock, { title: '邀请信息（发送给 Client）', value: activeInvite.invitation }), e('p', null, '请把邀请信息和配对码发送给 Client。Client 申请后将在此审批。'), e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: createHost }, '重新生成配对码'), e(Button, { disabled: busy, onClick: refresh }, '刷新状态'))), directGrant && e(Card, { title: '发送审批 Grant' }, e(CodeBlock, { title: 'Grant JSON（复制给 Client）', value: directGrant })), pendingJoinRequests.length > 0 && e(Card, { title: '待审批加入申请' }, pendingJoinRequests.map((req) => e('div', { key: req.id, className: 'nac-request' }, e('div', null, e('strong', null, req.clientName || req.clientId), e('small', null, req.clientId)), approvalFields, e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'approved') }, '同意加入'), e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'rejected') }, '拒绝'))))), e(BackButton, { onClick: leave, danger: true }, '退出协作'));
      if (savedSetup?.role === 'client' && !paired) return e('main', { className: 'nac-page nac-wizard' }, e('header', { className: 'nac-header' }, e('h1', null, '加入协作组')), e(Card, { title: '粘贴 Host 邀请信息' }, e('label', { className: 'nac-field' }, e('span', null, 'Host 邀请信息'), e('textarea', { 'aria-label': 'Host 邀请信息', placeholder: '粘贴 Host 提供的邀请信息', value: invite, onChange: (event) => setInvite(event.target.value) })), network === 'public' && e('label', { className: 'nac-field' }, e('span', null, 'Host Offer JSON'), e('textarea', { 'aria-label': 'Host Offer JSON', placeholder: '粘贴 Host Offer JSON', value: hostDirectOffer, onChange: (event) => setHostDirectOffer(event.target.value) })), e('label', { className: 'nac-field' }, e('span', null, '六位配对码'), e('input', { inputMode: 'numeric', maxLength: 6, 'aria-label': '六位配对码', placeholder: '输入六位配对码', value: pairCode, onChange: (event) => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)) })), e(Button, { disabled: busy || !invite.trim() || pairCode.length !== 6 || (network === 'public' && !hostDirectOffer.trim()), onClick: requestJoin }, network === 'public' ? '生成申请包' : '申请加入'), network === 'public' && directPackage && e(CodeBlock, { title: '申请包（复制给 Host）', value: directPackage }), network === 'public' && e('label', { className: 'nac-field' }, e('span', null, 'Host 审批后的 Grant JSON'), e('textarea', { 'aria-label': 'Host 审批后的 Grant JSON', placeholder: '粘贴 Host 审批后的 Grant JSON', value: clientGrant, onChange: (event) => setClientGrant(event.target.value) })), network === 'public' && clientGrant && e(Button, { disabled: busy, onClick: acceptDirectGrant }, '确认 Grant 并接入'), joinStatus && e('p', null, '申请包已生成；请发送给 Host，审批后粘贴 Grant。')), e(BackButton, { onClick: leave, danger: true }, '退出协作'));

      return e('main', { className: 'nac-page nac-dashboard' },
        e('header', { className: 'nac-header' },
          e('div', null,
            e('h1', null, 'Agent 协作中心'),
            e('p', null, savedSetup?.network === 'public' ? '公网 P2P 协作' : savedSetup?.lanTransport === 'tailscale' ? 'Tailscale 虚拟局域网协作' : '物理局域网协作')
          ),
          e('div', { className: 'nac-choice-row' },
            e(Button, { disabled: busy, onClick: refresh }, busy ? '同步中…' : '刷新'),
            e(BackButton, { onClick: leave, danger: true }, '退出协作')
          )
        ),
        error && e('div', { className: 'nac-alert', role: 'alert' }, error),
        e(ConnectionStatus, { connected: paired && state?.transportReady, message: stageText[state?.onboarding?.stage] || state?.message }),
        savedSetup?.role === 'host' && activeInvite && e(Card, { title: 'Host 邀请与待审批设备' },
          e('p', null, `当前配对码：${activeInvite.pairingCode}（有效至 ${time(activeInvite.expiresAt)}）`),
          pendingJoinRequests.length > 0 ? e('div', null,
            e('h3', null, '收到 Client 申请：'),
            pendingJoinRequests.map((req) => e('div', { key: req.id, className: 'nac-request' },
              e('div', null, e('strong', null, req.clientName || req.clientId), e('small', null, req.clientId)),
              e('div', { className: 'nac-choice-row' },
                e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'approved') }, '同意接入'),
                e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'rejected') }, '拒绝')
              )
            ))
          ) : e('p', null, '暂无新设备申请。若需添加新设备，请将上方配对码提供给对方。'),
          e('div', { className: 'nac-choice-row', style: { marginTop: '8px' } },
            e(Button, { disabled: busy, onClick: createHost }, '重新生成新邀请码')
          )
        ),
        e('section', { className: 'nac-stats' },
          e('div', { className: 'nac-stat' }, e('span', null, '传输状态'), e('strong', null, state?.transportReady ? '已连接' : '未连接')),
          e('div', { className: 'nac-stat' }, e('span', null, '在线节点'), e('strong', null, peers.length)),
          e('div', { className: 'nac-stat' }, e('span', null, '待确认激活'), e('strong', null, activations.length))
        ),
        e('section', { className: 'nac-grid nac-dashboard-primary' },
          e(Card, { title: '节点' }, peers.length ? e('ul', { className: 'nac-list' }, peers.map((peer) => e('li', { key: peer.id }, e('strong', null, peer.name || peer.id), e('small', null, peer.id)))) : e(Empty, null, '尚未发现其他节点')),
          e(Card, { title: '待确认激活', className: 'nac-priority' }, activations.length ? activations.map((item) => e('article', { className: 'nac-request', key: item.id }, e('strong', null, item.title), e('p', null, item.detail || '无附加说明'), e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: () => run(() => call('/approve', { activationId: item.id, decision: 'approved' }).then(refresh)) }, '批准并启动'), e(Button, { disabled: busy, onClick: () => run(() => call('/approve', { activationId: item.id, decision: 'rejected' }).then(refresh)) }, '拒绝')))) : e(Empty, null, '没有待确认激活'))
        ),
        e('section', { className: 'nac-grid nac-dashboard-secondary' },
          e('form', { className: 'nac-card', onSubmit: (event) => { event.preventDefault(); if (message.text.trim()) run(() => call('/message', message).then(() => { setMessage({ to: '', text: '', topic: '' }); refresh(); })); } }, e('h2', null, '发送协作消息'), e('input', { placeholder: '目标节点 ID（留空为广播）', value: message.to, onChange: (event) => setMessage({ ...message, to: event.target.value }) }), e('input', { placeholder: '主题（可选）', value: message.topic, onChange: (event) => setMessage({ ...message, topic: event.target.value }) }), e('textarea', { required: true, placeholder: '消息内容', value: message.text, onChange: (event) => setMessage({ ...message, text: event.target.value }) }), e(Button, { disabled: busy || !paired, type: 'submit' }, '发送消息')),
          e(Card, { title: '共享任务' }, tasks.length ? e('ul', { className: 'nac-list' }, tasks.map((item) => e('li', { key: item.id }, e('strong', null, item.title || item.id), e('small', null, item.status || 'open')))) : e(Empty, null, '当前没有共享任务'))
        )
      );
    }
    function PanelIcon({ size }) { return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, e('circle', { cx: 6, cy: 6, r: 2.4 }), e('circle', { cx: 18, cy: 7, r: 2.4 }), e('circle', { cx: 12, cy: 18, r: 2.4 }), e('path', { d: 'M8 7.2l7.7-.5M7.2 8l3.6 7.7m6-6.5l-3.5 6.4' })); }
    return { inject: ['slots'], apply(ctx) {
      const style = document.createElement('style');
      const extraStyle = '.nac-page{--nac-canvas:#fff;--nac-canvas-alt:#f5f5f7;--nac-ink:#1d1d1f;--nac-ink-muted:#6e6e73;--nac-hairline:#d2d2d7;--nac-accent:#0066cc;--nac-radius:12px;background:var(--nac-canvas);color:var(--nac-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nac-wizard{min-height:100%;display:flex;flex-direction:column;justify-content:center}.nac-wizard>.nac-card{box-shadow:0 4px 24px rgba(0,0,0,.08);border-radius:var(--nac-radius);border-color:var(--nac-hairline)}.nac-steps{display:flex;gap:8px;max-width:760px;margin:0 auto 18px;width:100%;color:var(--dsw-alias-label-secondary);font-size:12px}.nac-step{flex:1;padding:9px 10px;border-bottom:2px solid var(--dsw-alias-border-l1);text-align:center}.nac-step-current{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:700}.nac-step-done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.nac-pair-code{display:grid;gap:3px;padding:16px 18px;margin:12px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}.nac-pair-code strong{font:700 32px/1.1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.28em}.nac-code-block{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;margin:10px 0;background:var(--dsw-alias-bg-layer-2)}.nac-code-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.nac-code-block pre{white-space:pre-wrap;overflow:auto;max-height:180px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}.nac-status{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin:12px 0}.nac-status-ok{border-color:var(--dsw-alias-state-success-primary)}.nac-status-wait{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l1))}.nac-status span{color:var(--dsw-alias-label-secondary)}.nac-approval-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.nac-approval-fields label{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px}.nac-approval-fields select{width:100%;padding:9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}.nac-button-primary{background:var(--nac-ink);color:#fff;border:1px solid var(--nac-ink);border-radius:980px}.nac-button-secondary{background:var(--nac-canvas);color:var(--nac-ink);border:1px solid var(--nac-hairline);border-radius:980px}.nac-button-ghost{background:transparent;color:var(--dsw-alias-brand-primary);border:1px solid transparent}.nac-button-danger{background:var(--dsw-alias-state-error-primary);color:#fff}.nac-button:focus-visible,.nac-card input:focus-visible,.nac-card textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:2px}@media(max-width:640px){.nac-page{padding:18px}.nac-header,.nac-approval-fields{display:block}.nac-stats,.nac-grid{grid-template-columns:1fr}.nac-steps{font-size:11px;gap:2px}.nac-step{padding:8px 2px}}';
      const polish = document.createElement('style'); polish.textContent = extraStyle; document.head.appendChild(polish); style.textContent = `.nac-page{color:var(--nac-ink);background:var(--nac-canvas);height:100%;overflow:auto;padding:28px 32px;box-sizing:border-box;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nac-wizard{max-width:760px;margin:auto}.nac-header{display:flex;justify-content:space-between;gap:16px;margin-bottom:20px}.nac-header h1,.nac-card h2{margin:0 0 8px}.nac-header p,.nac-card p,.nac-card small{color:var(--nac-ink-muted)}.nac-card,.nac-stat{background:var(--nac-canvas);border:1px solid var(--nac-hairline);border-radius:var(--nac-radius);padding:16px;margin:16px 0}.nac-choice-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.nac-button{padding:9px 13px;cursor:pointer;font:inherit;border:1px solid transparent}.nac-button.nac-button-primary{background:var(--nac-ink);color:#fff;border-color:var(--nac-ink);border-radius:980px}.nac-button.nac-button-secondary{background:var(--nac-canvas);color:var(--nac-ink);border-color:var(--nac-hairline);border-radius:980px}.nac-button.nac-button-ghost{background:transparent;color:var(--nac-accent);border-color:transparent}.nac-button.nac-button-danger{background:#d70015;color:#fff;border-color:#d70015;border-radius:980px}.nac-button:disabled{opacity:.55;cursor:wait}.nac-selected{outline:2px solid var(--dsw-alias-state-success-primary)}.nac-link{display:block;background:none;border:0;color:var(--dsw-alias-brand-primary);padding:8px 0;cursor:pointer}.nac-field{display:grid;gap:6px;margin:0 0 12px}.nac-field>span{font-size:12px;color:var(--nac-ink-muted)}.nac-card input,.nac-card textarea{box-sizing:border-box;width:100%;background:var(--nac-canvas-alt);color:var(--nac-ink);border:1px solid var(--nac-hairline);border-radius:7px;padding:9px;margin:0;font:inherit}.nac-card input:focus-visible,.nac-card textarea:focus-visible{outline:3px solid rgba(0,102,204,.25);border-color:var(--nac-accent)}.nac-card textarea{min-height:90px;resize:vertical}.nac-alert{padding:10px;border-radius:8px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}.nac-onboard{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:grid;gap:4px}.nac-onboard-ready{border-color:var(--dsw-alias-state-success-primary)}.nac-stats,.nac-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.nac-stat{margin:0}.nac-stat span,.nac-list small{display:block;color:var(--dsw-alias-label-secondary)}.nac-list{list-style:none;padding:0;margin:0}.nac-list li,.nac-request{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.nac-list li:first-child,.nac-request:first-child{border-top:0}.nac-empty{color:var(--nac-ink-muted);padding:10px 0}.nac-dashboard-primary,.nac-dashboard-secondary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.nac-dashboard-primary .nac-card,.nac-dashboard-secondary .nac-card{margin:0}.nac-priority{border-color:#d70015;box-shadow:0 4px 24px rgba(215,0,21,.12)}.nac-code-block details summary{cursor:pointer;color:var(--nac-accent);padding:6px 0}.nac-steps{color:var(--nac-ink-muted)}.nac-step{border-color:var(--nac-hairline)}.nac-step-current{color:var(--nac-accent);border-color:var(--nac-accent);font-weight:600}.nac-step-done{color:#248a3d;border-color:#248a3d}@media (max-width:720px){.nac-dashboard-primary,.nac-dashboard-secondary{grid-template-columns:1fr}}`; document.head.appendChild(style);
      const offA = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'network-agent-collab', order: 24, label: () => '协作中心' }, PanelIcon));
      const offB = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'network-agent-collab' }, Dashboard));
      return () => { style.remove(); polish.remove(); offA(); offB(); };
    }};
  },
});

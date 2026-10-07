window.__ModuleLoader__.load({
  id: 'dsh-network-agent-collab',
  factory(require) {
    const React = require('react');
    const e = React.createElement;
    const API = `${window.location.origin}/network-agent-collab`;
    const LINK_PREFIX = `${window.location.origin}/#pair`;
    const LINK_AAD = new TextEncoder().encode('dsh-network-agent-collab/join/v1');
    const time = (value) => value ? new Date(value).toLocaleString() : '—';
    const toBase64Url = (bytes) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); };
    const fromBase64Url = (value) => { const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); };
    async function deriveLinkKey(code, salt) {
      const material = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
      return window.crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function createJoinLink({ invitation, offer, code, expiresAt }) {
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveLinkKey(code, salt);
      const payload = JSON.stringify({ v: 1, invitation, ...(offer ? { offer } : {}), expiresAt });
      const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: LINK_AAD }, key, new TextEncoder().encode(payload));
      return `${LINK_PREFIX}=${toBase64Url(salt)}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
    }
    async function openJoinLink(value, code) {
      const url = new URL(value.trim());
      const marker = '#pair=';
      const token = url.hash.startsWith(marker) ? url.hash.slice(marker.length).split('.') : [];
      if (token.length !== 3) throw new Error('连接链接格式无效');
      const salt = fromBase64Url(token[0]);
      const iv = fromBase64Url(token[1]);
      const data = fromBase64Url(token[2]);
      if (salt.length !== 16 || iv.length !== 12 || data.length < 17) throw new Error('连接链接数据不完整');
      const key = await deriveLinkKey(code, salt);
      try {
        const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: LINK_AAD }, key, data);
        const payload = JSON.parse(new TextDecoder().decode(plain));
        if (payload.v !== 1 || typeof payload.invitation !== 'string' || (payload.expiresAt && payload.expiresAt <= Date.now())) throw new Error('连接链接已过期或无效');
        return payload;
      } catch { throw new Error('匹配码错误或连接链接无效'); }
    }

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
    function CopyButton({ value }) { const [copied, setCopied] = React.useState(false); const [failed, setFailed] = React.useState(false); const copy = async () => { setFailed(false); try { await navigator.clipboard.writeText(value || ''); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { setFailed(true); } }; return e('span', { className: 'nac-copy-wrap' }, e(Button, { variant: 'secondary', className: 'nac-copy', onClick: copy, disabled: !value }, copied ? '已复制' : '复制'), failed && e('small', { role: 'alert' }, '复制失败，请手动选择并复制内容。')); }
    function CodeBlock({ title, value, children }) { const long = (value || '').length > 900; return e('div', { className: 'nac-code-block' }, e('div', { className: 'nac-code-head' }, e('strong', null, title), e(CopyButton, { value })), children || (long ? e('details', null, e('summary', null, '展开完整信令'), e('pre', null, value || '—')) : e('pre', null, value || '—'))); }
    function Progress({ current = 1 }) { const items = ['网络', '身份', '确认']; return e('nav', { className: 'nac-progress', 'aria-label': '初始化进度' }, e('span', { className: 'nac-progress-label' }, `当前步骤 ${current} / ${items.length}`), items.map((item, index) => e('span', { key: item, className: index + 1 === current ? 'nac-progress-current' : index + 1 < current ? 'nac-progress-done' : '', 'aria-current': index + 1 === current ? 'step' : undefined }, `${index + 1}. ${item}`))); }
     function ConnectionStatus({ connected, message }) { return e('div', { className: connected ? 'nac-status nac-status-ok' : 'nac-status nac-status-wait', role: 'status', 'aria-live': 'polite' }, e('strong', null, connected ? '● 已连接' : '◌ 等待配对'), e('span', null, message || (connected ? '协作通道已建立' : '请完成配对或交换公网信令'))); }

    function Dashboard() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [network, setNetwork] = React.useState(null);
      const [transport, setTransport] = React.useState('local');
      const [role, setRole] = React.useState(null);
      const [invite, setInvite] = React.useState('');
      const [joinLink, setJoinLink] = React.useState('');
       const [pairCode, setPairCode] = React.useState('');
       const [hostJoinLink, setHostJoinLink] = React.useState('');

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
      React.useEffect(() => { const pair = new URLSearchParams(window.location.hash.slice(1)).get('pair'); if (pair) setJoinLink(`${window.location.origin}/#pair=${pair}`); }, []);
       const run = async (fn) => { setBusy(true); setError(''); try { return await fn(); } catch (err) { const message = err?.message === 'PUBLIC_HOST_RECREATE_REQUIRED' ? 'DSH 已重启，原公网 WebRTC 会话无法恢复；已有协作状态未被修改。请确认后点击“重新生成 Host”。' : err.message; setError(message); return null; } finally { setBusy(false); } };
      const errorNotice = error && e('div', { className: 'nac-alert', role: 'alert' }, error);
      const configured = state?.setup?.configured;
      const savedSetup = state?.setup?.setup;
      // React state is ephemeral; keep the persisted setup as the source of truth after refresh.
      const selectedNetwork = network || savedSetup?.network;
      const reconnectRequired = state?.onboarding?.stage === 'public-reconnect-required';
       const paired = !reconnectRequired && Boolean(state?.setup?.group || state?.onboarding?.ready);
      const stageText = {
        'setup-required': '请选择网络与本机身份。',
        'waiting-for-host': '尚未创建或加入协作组。',
        'relay-connecting': '正在连接本机 Relay。',
        'public-waiting-for-signal': '等待手工交换 Offer、Answer 和 Grant；公网模式不使用 Relay。',
         'public-reconnect-required': 'DSH 已重启；请粘贴新的 Host 邀请和匹配码，重新申请加入。',
        'public-waiting-for-peer': '直连信令已交换，正在等待对方建立 DataChannel。',
        'waiting-for-peer': '协作组已启动，正在等待其他设备加入。',
        matched: '节点已匹配，可以开始协作。',
        'tailscale-unavailable': '未检测到可用的 Tailscale 登录。',
        'tailscale-offline': 'Tailscale 当前离线。',
      };
      const saveSetup = () => run(async () => {
        const result = await call('/setup', { network: selectedNetwork, role, ...(selectedNetwork === 'lan' ? { lanTransport: transport } : {}) });
        await refresh(); return result;
      });
      const createHost = () => run(async () => {
        const result = await call('/host/create', {});
         setHostInfo(result);
         if (result.directOffer) setHostDirectOffer(JSON.stringify(result.directOffer, null, 2));
         if (result.invitation && result.pairingCode) setHostJoinLink(await createJoinLink({ invitation: result.invitation, offer: result.directOffer, code: result.pairingCode, expiresAt: result.expiresAt }));
         await refresh(); return result;
      });
      const recreatePublicHost = () => { if (window.confirm('重新生成 Host 会使旧公网邀请与未完成连接失效。确认继续吗？')) return createHost(); };
       const recreateLanHost = () => { if (window.confirm('重新创建协作组将清空成员、待审批请求、旧邀请并轮换协作密钥；现有成员需重新配对。确认继续吗？')) return createHost(); };
       const requestJoin = () => run(async () => {
        const payload = await openJoinLink(joinLink, pairCode.trim());
         setInvite(payload.invitation);
         if (payload.offer) setHostDirectOffer(JSON.stringify(payload.offer, null, 2));
         const result = selectedNetwork === 'public'
          ? await call('/direct/offer', { offer: payload.offer, invitation: payload.invitation, code: pairCode.trim() })
          : await call('/join/request', { invite: payload.invitation, pairCode: pairCode.trim() });
        if (selectedNetwork === 'public') setDirectPackage(JSON.stringify({ answer: result.answer, request: result.request }, null, 2));
        setJoinStatus(result); await refresh(); return result;
      });
      const submitDirectAnswer = () => run(async () => {
        const packet = JSON.parse(directPackage);
        const result = await call('/direct/answer', { answer: packet.answer, ...packet.request });
        await refresh(); return result;
      });
      const acceptDirectGrant = () => run(async () => { const result = await call('/direct/grant', { grant: JSON.parse(clientGrant) }); await refresh(); return result; });
      const leave = () => { if (window.confirm('确定退出协作并清除当前配对吗？')) return run(async () => { await call('/pair/leave', {}); setNetwork(null); setRole(null); setHostInfo(null); setJoinStatus(null); setJoinLink(''); setHostJoinLink(''); await refresh(); }); };
      const peers = Object.values(state?.peers || {});
      const tasks = Object.values(state?.tasks || {});
      const activations = Object.values(state?.activations || {}).filter((item) => item.target === state?.identity?.id && item.status === 'pending');

      const activeInvite = hostInfo || state?.setup?.activeInvite;
      const pendingJoinRequests = state?.setup?.pendingRequests || [];
       React.useEffect(() => {
         if (!savedSetup || savedSetup.role !== 'host' || !activeInvite || hostJoinLink) return;
         run(async () => {
           const connection = await call('/host/connection', {});
           const offer = connection.directOffer;
           if (offer) setHostDirectOffer(JSON.stringify(offer, null, 2));
           setHostJoinLink(await createJoinLink({ invitation: connection.invitation, offer, code: connection.pairingCode, expiresAt: connection.expiresAt }));
           await refresh();
         });
       }, [savedSetup?.role, savedSetup?.network, activeInvite?.id, hostJoinLink]);
      const decideJoin = (requestId, decision) => run(async () => {
        const result = await call('/join/decide', { requestId, decision, duration, permissionLevel });
        if (result.directGrant) setDirectGrant(JSON.stringify(result.directGrant, null, 2));
        await refresh(); return result;
      });
      const removeMember = (memberId) => {
         if (!window.confirm('移除此成员将轮换协作密钥，并使现有成员需要重新配对。确定继续吗？')) return;
         return run(async () => { await call('/members/remove', { memberId }); await refresh(); });
       };
       const approvalFields = e('div', { className: 'nac-approval-fields' },
        e('label', null, '权限时间', e('select', { value: duration, onChange: (event) => setDuration(event.target.value) },
          e('option', { value: 'once' }, '单次'), e('option', { value: '24h' }, '24 小时'), e('option', { value: 'permanent' }, '永久'))),
        e('label', null, '权限等级', e('select', { value: permissionLevel, onChange: (event) => setPermissionLevel(event.target.value) },
          e('option', { value: 'communication' }, '仅通信'), e('option', { value: 'wake-approval' }, '可唤醒 Agent（需审批）'), e('option', { value: 'trusted' }, '无条件信任')))
      );

      if (!configured) {
        if (!network) return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e(Progress, { current: 1 }), e('header', { className: 'nac-header' }, e('div', null, e('h1', null, 'Agent 协作中心'), e('p', null, '选择本次协作使用的网络。'))), e(Card, { title: '选择网络' }, e('p', null, '此选择独立于后续协作页面。'), e('div', { className: 'nac-choice-row' }, e(Button, { onClick: () => setNetwork('lan') }, '局域网'), e(Button, { onClick: () => setNetwork('public') }, '公网 P2P'))));
        if (!role) return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e(Progress, { current: 2 }), e('header', { className: 'nac-header' }, e('h1', null, selectedNetwork === 'lan' ? '局域网设置' : '公网 P2P 设置')), selectedNetwork === 'lan' && e(Card, { title: '局域网类型' }, e('div', { className: 'nac-choice-row' }, e(Button, { className: transport === 'local' ? 'nac-button nac-selected' : 'nac-button', onClick: () => setTransport('local') }, '物理局域网'), e(Button, { className: transport === 'tailscale' ? 'nac-button nac-selected' : 'nac-button', onClick: () => setTransport('tailscale') }, 'Tailscale 虚拟局域网'))), e(Card, { title: '选择身份' }, e('p', null, 'Host 创建协作组并管理成员；Client 申请加入。'), e('div', { className: 'nac-choice-row' }, e(Button, { onClick: () => setRole('host') }, '创建协作组（Host）'), e(Button, { onClick: () => setRole('client') }, '加入协作组（Client）')), e(BackButton, { onClick: () => setNetwork(null) }, '返回网络选择')));
        return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e(Progress, { current: 3 }), e('header', { className: 'nac-header' }, e('h1', null, '确认设置')), e(Card, { title: role === 'host' ? '创建 Host' : '加入 Client' }, e('p', null, `${selectedNetwork === 'lan' ? (transport === 'tailscale' ? 'Tailscale 局域网' : '物理局域网') : '公网 P2P'} · ${role === 'host' ? 'Host' : 'Client'}`), e(Button, { disabled: busy, onClick: saveSetup }, '继续'), e(BackButton, { onClick: () => setRole(null) }, '返回身份选择')));
      }

      if (savedSetup?.role === 'host' && !state?.setup?.group) return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e('header', { className: 'nac-header' }, e('h1', null, '创建协作组')), e(Card, { title: '启动本机 Host' }, e('p', null, selectedNetwork === 'public' ? 'Host 将生成加密连接链接；请与 Client 分享链接和六位匹配码。' : '插件会启动内置 Relay 并生成一次性邀请。'), e(Button, { disabled: busy, onClick: createHost }, '发布 Host 并生成配对码')), e(BackButton, { onClick: leave, danger: true }, '退出协作'));
      if (savedSetup?.role === 'host' && activeInvite && (!paired || peers.length === 0)) return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e('header', { className: 'nac-header' }, e('h1', null, '邀请 Client 加入')), e(Card, { title: '一次性配对信息' }, e('div', { className: 'nac-pair-code' }, e('span', null, '六位配对码'), e('strong', null, activeInvite.pairingCode || '—'), e('small', null, `有效至：${time(activeInvite.expiresAt)}`)), e(CodeBlock, { title: '连接链接（发送给 Client）', value: hostJoinLink }), e('p', null, '请把连接链接和六位匹配码发送给 Client。Client 申请后将在此审批。'), selectedNetwork === 'public' && e('label', { className: 'nac-field' }, e('span', null, 'Client 返回的连接信息'), e('textarea', { 'aria-label': 'Client 返回的连接信息', placeholder: '粘贴 Client 生成的申请包', value: hostDirectAnswer, onChange: (event) => setHostDirectAnswer(event.target.value) })), selectedNetwork === 'public' && hostDirectAnswer && e(Button, { disabled: busy, onClick: () => run(async () => { const packet = JSON.parse(hostDirectAnswer); await call('/direct/answer', { answer: packet.answer, ...packet.request }); await refresh(); }) }, '确认对方连接'), e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: selectedNetwork === 'public' ? recreatePublicHost : recreateLanHost }, selectedNetwork === 'public' ? '重新生成 Host（旧公网会话失效）' : '重新生成配对码'), e(Button, { disabled: busy, onClick: refresh }, '刷新状态'))), directGrant && e(Card, { title: '发送审批 Grant' }, e(CodeBlock, { title: 'Grant JSON（复制给 Client）', value: directGrant })), pendingJoinRequests.length > 0 && e(Card, { title: '待审批加入申请' }, pendingJoinRequests.map((req) => e('div', { key: req.id, className: 'nac-request' }, e('div', null, e('strong', null, req.clientName || req.clientId), e('small', null, req.clientId)), approvalFields, e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'approved') }, '同意加入'), e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'rejected') }, '拒绝'))))), e(BackButton, { onClick: leave, danger: true }, '退出协作'));
      if (savedSetup?.role === 'client' && !paired) return e('main', { className: 'nac-page nac-wizard' }, errorNotice, e('header', { className: 'nac-header' }, e('h1', null, '加入协作组')), e(Card, { title: '粘贴 Host 连接链接' }, e('label', { className: 'nac-field' }, e('span', null, 'Host 连接链接'), e('textarea', { 'aria-label': 'Host 连接链接', placeholder: '粘贴 Host 提供的连接链接', value: joinLink, onChange: (event) => setJoinLink(event.target.value) })),  e('label', { className: 'nac-field' }, e('span', null, '六位配对码'), e('input', { inputMode: 'numeric', maxLength: 6, 'aria-label': '六位配对码', placeholder: '输入六位配对码', value: pairCode, onChange: (event) => setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)) })), e(Button, { disabled: busy || !joinLink.trim() || pairCode.length !== 6, onClick: requestJoin }, selectedNetwork === 'public' ? '生成申请包' : '申请加入'), selectedNetwork === 'public' && directPackage && e(CodeBlock, { title: '申请包（复制给 Host）', value: directPackage }), selectedNetwork === 'public' && e('label', { className: 'nac-field' }, e('span', null, 'Host 审批后的 Grant JSON'), e('textarea', { 'aria-label': 'Host 审批后的 Grant JSON', placeholder: '粘贴 Host 审批后的 Grant JSON', value: clientGrant, onChange: (event) => setClientGrant(event.target.value) })), selectedNetwork === 'public' && clientGrant && e(Button, { disabled: busy, onClick: acceptDirectGrant }, '确认 Grant 并接入'), joinStatus && e('p', null, '申请包已生成；请发送给 Host，审批后粘贴 Grant。')), e(BackButton, { onClick: leave, danger: true }, '退出协作'));

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
        savedSetup?.role === 'host' && savedSetup?.network === 'public' && (!activeInvite || error.includes('原公网 WebRTC 会话无法恢复') || state?.onboarding?.stage === 'public-reconnect-required') && e(Card, { title: '需要重新建立公网 Host' }, e('p', null, activeInvite ? '已有协作状态仍保留，但旧 WebRTC 会话已失效。' : '当前邀请已过期或不可用；请生成新的 Host 连接信息。'), e(Button, { disabled: busy, onClick: recreatePublicHost }, '重新生成 Host（旧公网会话失效）')),
        e(ConnectionStatus, { connected: paired && state?.transportReady, message: stageText[state?.onboarding?.stage] || state?.message }),
        savedSetup?.role === 'host' && activeInvite && e(Card, { title: 'Host 邀请与待审批设备' },
          e('p', null, `当前配对码：${activeInvite.pairingCode}（有效至 ${time(activeInvite.expiresAt)}）`),
          pendingJoinRequests.length > 0 ? e('div', null,
            e('h3', null, '收到 Client 申请：'),
            pendingJoinRequests.map((req) => e('div', { key: req.id, className: 'nac-request' },
              e('div', null, e('strong', null, req.clientName || req.clientId), e('small', null, req.clientId)), approvalFields,
              e('div', { className: 'nac-choice-row' },
                e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'approved') }, '同意接入'),
                e(Button, { disabled: busy, onClick: () => decideJoin(req.id, 'rejected') }, '拒绝')
              )
            ))
          ) : e('p', null, '暂无新设备申请。若需添加新设备，请将上方配对码提供给对方。'),
          e('div', { className: 'nac-choice-row', style: { marginTop: '8px' } },
            e(Button, { disabled: busy, onClick: savedSetup?.network === 'public' ? recreatePublicHost : recreateLanHost }, savedSetup?.network === 'public' ? '重新生成公网 Host' : '重新生成新邀请码')
          )
        ),
        e('section', { className: 'nac-stats' },
          e('div', { className: 'nac-stat' }, e('span', null, '传输状态'), e('strong', null, state?.transportReady ? '已连接' : '未连接')),
          e('div', { className: 'nac-stat' }, e('span', null, '在线节点'), e('strong', null, peers.length)),
          e('div', { className: 'nac-stat' }, e('span', null, '待确认激活'), e('strong', null, activations.length))
        ),
        e('section', { className: 'nac-grid nac-dashboard-primary' },
          e(Card, { title: '节点' }, savedSetup?.role === 'host' && state?.setup?.members?.length > 0 ? e('ul', { className: 'nac-list' }, state.setup.members.map((member) => e('li', { key: member.id }, e('strong', null, member.name || member.id), e('small', null, member.id), e(Button, { variant: 'secondary', disabled: busy, onClick: () => removeMember(member.id) }, '移除成员')))) : peers.length ? e('ul', { className: 'nac-list' }, peers.map((peer) => e('li', { key: peer.id }, e('strong', null, peer.name || peer.id), e('small', null, peer.id)))) : e(Empty, null, '尚未发现其他节点')),
          e(Card, { title: '待确认激活', className: 'nac-priority' }, activations.length ? activations.map((item) => e('article', { className: 'nac-request', key: item.id }, e('strong', null, item.title), e('p', null, item.detail || '无附加说明'), e('div', { className: 'nac-choice-row' }, e(Button, { disabled: busy, onClick: () => run(() => call('/approve', { activationId: item.id, decision: 'approved' }).then(refresh)) }, '批准并启动'), e(Button, { disabled: busy, onClick: () => run(() => call('/approve', { activationId: item.id, decision: 'rejected' }).then(refresh)) }, '拒绝')))) : e(Empty, null, '没有待确认激活'))
        ),
        e('section', { className: 'nac-grid nac-dashboard-secondary' },
          e('form', { className: 'nac-card', onSubmit: (event) => { event.preventDefault(); if (message.text.trim()) run(() => call('/message', message).then(() => { setMessage({ to: '', text: '', topic: '' }); refresh(); })); } }, e('h2', null, '发送协作消息'), e('label', { className: 'nac-field', htmlFor: 'nac-message-to' }, e('span', null, '目标节点'), e('input', { id: 'nac-message-to', 'aria-describedby': 'nac-message-to-help', placeholder: '留空表示广播', value: message.to, onChange: (event) => setMessage({ ...message, to: event.target.value }) })), e('small', { id: 'nac-message-to-help' }, '可填写节点 ID；留空发送给所有节点。'), e('label', { className: 'nac-field', htmlFor: 'nac-message-topic' }, e('span', null, '主题（可选）'), e('input', { id: 'nac-message-topic', placeholder: '输入消息主题', value: message.topic, onChange: (event) => setMessage({ ...message, topic: event.target.value }) })), e('label', { className: 'nac-field', htmlFor: 'nac-message-text' }, e('span', null, '消息内容'), e('textarea', { id: 'nac-message-text', required: true, 'aria-describedby': 'nac-message-text-help', placeholder: '输入要发送的内容', value: message.text, onChange: (event) => setMessage({ ...message, text: event.target.value }) })), e('small', { id: 'nac-message-text-help' }, '消息将在配对完成后发送。'), e(Button, { disabled: busy || !paired, type: 'submit' }, '发送消息')),
          e(Card, { title: '共享任务' }, tasks.length ? e('ul', { className: 'nac-list' }, tasks.map((item) => e('li', { key: item.id }, e('strong', null, item.title || item.id), e('small', null, item.status || 'open')))) : e(Empty, null, '当前没有共享任务'))
        )
      );
    }
    function PanelIcon({ size }) { return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, e('circle', { cx: 6, cy: 6, r: 2.4 }), e('circle', { cx: 18, cy: 7, r: 2.4 }), e('circle', { cx: 12, cy: 18, r: 2.4 }), e('path', { d: 'M8 7.2l7.7-.5M7.2 8l3.6 7.7m6-6.5l-3.5 6.4' })); }
    return { inject: ['slots'], apply(ctx) {
      const style = document.createElement('style');
      const extraStyle = '.nac-page{--nac-canvas:var(--dsw-alias-bg-base);--nac-canvas-alt:var(--dsw-alias-bg-layer-1);--nac-ink:var(--dsw-alias-label-primary);--nac-ink-muted:var(--dsw-alias-label-secondary);--nac-hairline:var(--dsw-alias-border-l1);--nac-accent:var(--dsw-alias-link);--nac-radius:10px;background:var(--nac-canvas);color:var(--nac-ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nac-wizard{min-height:100%;display:flex;flex-direction:column;justify-content:center}.nac-wizard>.nac-card{border-radius:var(--nac-radius);border-color:var(--nac-hairline)}.nac-pair-code{display:grid;gap:3px;padding:16px 18px;margin:12px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--nac-radius);background:var(--dsw-alias-bg-layer-2)}.nac-pair-code strong{font:600 32px/1.1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.28em}.nac-code-block{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;margin:10px 0;background:var(--dsw-alias-bg-layer-2)}.nac-code-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.nac-code-block pre{white-space:pre-wrap;overflow:auto;max-height:180px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}.nac-status{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin:12px 0}.nac-status-ok{border-color:var(--dsw-alias-state-success-primary)}.nac-status-ok strong{color:var(--dsw-alias-state-success-primary)}.nac-status-wait{border-color:var(--dsw-alias-state-warn-primary)}.nac-status-wait strong{color:var(--dsw-alias-state-warn-primary)}.nac-status span{color:var(--dsw-alias-label-secondary)}.nac-approval-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.nac-approval-fields label{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px}.nac-approval-fields select{width:100%;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}.nac-button-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:1px solid var(--dsw-alias-button-primary-fill);border-radius:8px}.nac-button-secondary{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.nac-button-ghost{background:transparent;color:var(--dsw-alias-brand-primary);border:1px solid transparent}.nac-button-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}.nac-button:focus-visible,.nac-card input:focus-visible,.nac-card textarea:focus-visible{outline:3px solid var(--dsw-alias-link);outline-offset:2px}@media(max-width:640px){.nac-page{padding:18px}.nac-header,.nac-approval-fields{display:block}.nac-stats,.nac-grid{grid-template-columns:1fr}}';
      const polish = document.createElement('style'); polish.textContent = extraStyle; document.head.appendChild(polish); style.textContent = `.nac-page{color:var(--nac-ink);background:var(--nac-canvas);height:100%;overflow:auto;padding:28px 32px;box-sizing:border-box;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nac-wizard{max-width:760px;margin:auto}.nac-progress{display:flex;align-items:center;gap:12px;margin:0 0 24px;color:var(--nac-ink-muted);font-size:13px}.nac-progress-label{font-weight:500;color:var(--nac-ink)}.nac-progress span:not(.nac-progress-label){padding-bottom:4px;border-bottom:2px solid transparent}.nac-progress-current{color:var(--nac-accent);border-color:var(--nac-accent)!important;font-weight:600}.nac-progress-done{color:var(--nac-ink)}.nac-header{display:flex;justify-content:space-between;gap:16px;margin-bottom:24px}.nac-header h1{margin:0 0 8px;font-size:30px;line-height:1.2;font-weight:400;letter-spacing:-.02em}.nac-card h2{margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:500}.nac-header p,.nac-card p,.nac-card small{color:var(--nac-ink-muted)}.nac-card,.nac-stat{background:var(--nac-canvas);border:1px solid var(--nac-hairline);border-radius:var(--nac-radius);padding:18px;margin:16px 0}.nac-choice-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.nac-button{min-height:38px;padding:9px 12px;cursor:pointer;font:inherit;border:1px solid transparent}.nac-button.nac-button-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-button-primary-fill);border-radius:8px}.nac-button.nac-button-secondary{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);border-radius:8px}.nac-button.nac-button-ghost{background:transparent;color:var(--dsw-alias-link);border-color:transparent}.nac-button.nac-button-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-error-primary);border-radius:8px}.nac-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.nac-button-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.nac-button-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.nac-button-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.nac-button:disabled{opacity:.55;cursor:wait}.nac-selected{outline:2px solid var(--dsw-alias-state-success-primary)}.nac-link{display:block;background:none;border:0;color:var(--dsw-alias-brand-primary);padding:8px 0;cursor:pointer}.nac-field{display:grid;gap:6px;margin:0 0 12px}.nac-field>span{font-size:12px;color:var(--nac-ink-muted)}.nac-card input,.nac-card textarea{box-sizing:border-box;width:100%;background:var(--nac-canvas-alt);color:var(--nac-ink);border:1px solid var(--nac-hairline);border-radius:8px;padding:10px;margin:0;font:inherit}.nac-card input:focus-visible,.nac-card textarea:focus-visible{outline:3px solid var(--dsw-alias-link);border-color:var(--dsw-alias-link)}.nac-card textarea{min-height:90px;resize:vertical}.nac-alert{padding:10px 12px;border-inline-start:3px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}.nac-onboard{padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:grid;gap:4px}.nac-onboard-ready{border-color:var(--dsw-alias-state-success-primary)}.nac-stats,.nac-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.nac-stat{margin:0}.nac-stat span,.nac-list small{display:block;color:var(--dsw-alias-label-secondary)}.nac-list{list-style:none;padding:0;margin:0}.nac-list li,.nac-request{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.nac-list li:first-child,.nac-request:first-child{border-top:0}.nac-empty{color:var(--nac-ink-muted);padding:10px 0}.nac-dashboard-primary,.nac-dashboard-secondary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.nac-dashboard-primary .nac-card,.nac-dashboard-secondary .nac-card{margin:0}.nac-priority{border-color:var(--dsw-alias-state-error-primary)}.nac-code-block details summary{cursor:pointer;color:var(--dsw-alias-link);padding:6px 0}.nac-dashboard-primary,.nac-dashboard-secondary{grid-template-columns:repeat(2,minmax(0,1fr))}`; document.head.appendChild(style);
      const responsive = document.createElement('style'); responsive.textContent = '@media (max-width: 768px){.nac-page{padding:18px 14px}.nac-header{display:block}.nac-header h1{font-size:26px}.nac-progress{gap:7px;flex-wrap:wrap}.nac-progress-label{width:100%}.nac-grid{grid-template-columns:minmax(0,1fr)!important}.nac-button{width:100%}.nac-choice-row .nac-button{flex:1 1 160px}.nac-code-block pre{max-height:220px;overflow-wrap:anywhere}}@media (max-width: 480px){.nac-approval-fields{grid-template-columns:1fr}}@media (max-width: 360px){.nac-card{padding:16px}.nac-pair-code strong{font-size:26px;letter-spacing:.18em}}'; document.head.appendChild(responsive);
       const offA = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'network-agent-collab', order: 24, label: () => '协作中心' }, PanelIcon));
      const offB = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'network-agent-collab' }, Dashboard));
      return () => { style.remove(); polish.remove(); responsive.remove(); offA(); offB(); };
    }};
  },
});

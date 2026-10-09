# 协作中心 0.4.12：协作操作说明

> 适用范围：仓库 `package.json` 标记的 **0.4.12**，按当前 `client.js`、`index.js` 和 `src/` 源码核对。以下是**操作说明，不代表已在两台真实设备上验证连接**，也不代表当前运行的 DSH 已启用本插件。安装、启用、配置变更属于另一步骤；不要因看到此文档就再次安装。每台设备均须运行加载本插件、具备 Agent Loop 的 DSH，并在**本机** DSH 页面打开左栏「协作中心」。

## 默认局域网流程（推荐普通用户）

1. 两端打开「协作中心」，点击「开始协作（局域网）」；创建者选择「创建协作组」，另一端选择「加入协作组」，然后点「继续」。
2. 创建者点击「生成邀请和配对码」，把邀请链接与六位配对码通过可信渠道发给对方；加入者粘贴邀请链接并输入配对码，点击「申请加入」。
3. 创建者核对申请者名称，点击「允许加入」或「拒绝」。成功后双方检查「传输状态」和「在线节点」即可开始协作。

默认流程不需要理解网络协议或复制 JSON。Tailscale、公网连接、权限时长及诊断信息位于「更多连接方式/高级设置」。若局域网失败，再打开高级连接方式。

## 高级连接方式

高级方式包括 Tailscale、公网直连和手工连接信息；只有主动打开「更多连接方式」时才显示。技术排障与公网手工步骤见下文。

## 公网 P2P：默认自动配对

在协作中心选择公网 P2P 后，插件会自动创建临时 Nostr signer 并连接内置免费 Relay 列表；无需用户预先配置 `networkScope`、Nostr 账号或 Relay。UI 不提供手工 Grant JSON 流程。只有自动信令初始化确实失败时，才会提示使用显式高级 `direct://manual` Offer/Answer fallback；该 fallback 不提供 TURN，严格 NAT 下仍可能无法直连。

### 自动交换配对信令（公网）

1. Host 点「发布 Host 并生成配对码」，将连接链接及单独六位配对码给 Client。公网 Nostr 仅作为端到端加密控制信令。
2. Client 粘贴链接及配对码，点「申请加入」；申请通过 Nostr 自动发送，页面显示 request-sent/awaiting-approval 状态。
3. Host 在待审批列表核对 Client ID，选择权限和时长并点「允许加入」。Grant、签名绑定的 WebRTC Offer/SDP/ICE 以及 Answer 通过加密信令自动交换，双方随后显示已连接。
4. 默认流程不复制 Grant JSON，也不提供 `/direct/grant`。每次重新生成 Host 都使旧邀请失效；DSH 重启后 WebRTC 会话不能恢复，若页面提示 `PUBLIC_HOST_RECREATE_REQUIRED`，需重新生成 Host 并从头申请。

## 权限、Agent 唤醒和撤销

- 加入审批时的「权限时间」为**单次 / 24 小时 / 永久**。「单次」表示 Host 审批后邀请码只允许一次获准加入；Grant 可由对应 Client 确认，**不是自动在发一条消息或一分钟后退出**；24 小时授权过期后发送被拒绝。建议从「仅通信」及较短时长开始。
- 「仅通信」允许协作消息；「可唤醒 Agent（需审批）」开放任务和激活请求，但目标端仍须按授权策略审批；「无条件信任」开放上述能力。**加入权限与每次激活审批是不同层次**：Agent 工具 `network_agent_activate` 的 `approvalLevel` 可以是 `none`（目标端直接创建本地 Agent）、`peer`（目标端审批）或 `privileged`（目标端 ID 还须列在 `privilegedApproverIds`）。当前接收端会拒绝伪造/过期成员，并禁止把需审批的唤醒权限降级为立即执行；不信任节点仍不要授予可唤醒权限。
- 本机「待确认激活」显示需要人工确认的请求；核对标题和详情后点「批准并启动」或「拒绝」。批准后会在**本机**创建 Agent 会话，不跨机传 DSH 凭据或现有会话。页面可发消息、查看任务；创建或更新共享任务以及发起激活目前使用 Agent 工具 `network_agent_task`、`network_agent_activate`，不要寻找不存在的 UI 按钮。
- Host 在「节点」卡点「移除成员」时会再弹确认，并轮换组密钥；**其他已连接成员也需要重新配对**。任一端可点「退出协作」，确认后停止本机连接并清除当前本机配对；另一端的持久状态未必自动同步清理。若 Grant、连接链接或配对码泄露，不要只等过期：由 Host 移除成员并重新建组/配对，并通知对端。不要手动传播本机 `setup.json`、`identity.json` 或 `shared-secret`。
- **破坏性操作警告：** LAN 页面「重新生成新邀请码」不是无损刷新；当前实现会重建 Host 协作组、轮换密钥并清空成员与待审批请求，而且页面未必先弹确认。执行前先通知所有成员并确认确实要从头配对。

## 观察及故障排查

| 现象 | 先检查 |
|---|---|
| 没看到左栏「协作中心」或页面报「无法读取协作状态」 | 核实实际运行的 DSH 已加载兼容的 Host/Client 插件且 Agent Loop 可用；确认现有 DSH Web 服务在本机工作。页面请求的是**现有 Web Server** 的 `/network-agent-collab` 前缀，而不是独立监听的 8788 服务。源码目前只使用 `ui.enabled` 开关，**`ui.port` 不决定页面路由**；旧 README 中关于修改 8788 的说法不适用于当前源码。 |
| 链接/匹配码不正确、过期、邀请已被使用 | 从 Host 复制完整链接及单独的六位码；检查两端时钟及有效期，必要时 Host 重新生成邀请并让 Client 从头操作，不能复用旧的申请或 Grant。 |
| LAN 显示 `relay-connecting`、`RELAY_UNAVAILABLE` | 检查 Host DSH/内置 Relay 正在运行、邀请的主机地址可达、主机/本机防火墙及所示端口；Tailscale 还检查双方在线和 ACL。不要把“已点击发送”当成对端已收到。 |
| 公网显示 `public-waiting-for-signal`、`DIRECT_CHANNEL_NOT_OPEN` | 检查 Nostr Relay 可达、STUN、IPv4/UDP、Host 入站映射与 NAT 类型。两端都在 CGNAT 或对称 NAT 下时**无 TURN 兜底**，改用 Tailscale/可互访局域网。 |
| 传输显示已连接但找不到节点 | 等待双方上线宣布 presence，点「刷新」核对「在线节点」；连接与真正匹配是两项不同状态。 |
| `COLLABORATION_PERMISSION_DENIED` / `COLLABORATION_ACCESS_EXPIRED` / `PRIVILEGED_APPROVER_NOT_CONFIGURED` | 分别检查加入时权限等级、24 小时授权时间、目标机本地 `privilegedApproverIds` 配置；不要用多点几次审批代替修正配置。 |
| 公网 Host 重启后原邀请打不开 | WebRTC 内存会话无法重建；按页面确认「重新生成 Host」，让 Client 重新申请。 |

### 已知验证边界与源码差异

- 仓库 `HANDOFF.md` 将**真实浏览器视觉交互和跨设备公网直连**列为现场待验证；本说明只给出基于 0.4.12 源码的操作路径，不声称任何特定网络已打洞成功。自检可在仓库执行 `node --check index.js && node --check client.js && npm test`，但单元测试不能替代跨设备现场试验。
- `README.md` 的旧 `PORT=8787 node relay.js` 是**手动外部 Relay 示例**，不是协作中心 Host 引导的必需动作；其 `ui.port: 8788` 说明也与当前集成 Web Server 的实现不一致。UI 显示「重新生成新邀请码」时底层 `hostCreate` 实际会重新建组并清理成员，不应当作无损刷新按钮。
- 技术边界：LAN Relay 仅转发，协作帧用 HMAC 校验完整性、**不加密消息内容**；若跨不可信网络必须另用安全隧道或 TLS/WSS。公网采用 WebRTC DataChannel，STUN 仅发现可用候选，未配置 TURN/付费 Relay；不能承诺所有 NAT 环境均可达。当前 UI/Host/Client 的授权与恢复路径应在目标 DSH 部署现场核验。

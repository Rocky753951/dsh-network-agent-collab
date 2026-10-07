# 协作中心 0.4.11：Host / Client 操作说明

> 适用范围：仓库 `package.json` 标记的 **0.4.11**，按当前 `client.js`、`index.js` 和 `src/` 源码核对。以下是**操作说明，不代表已在两台真实设备上验证连接**，也不代表当前运行的 DSH 已启用本插件。安装、启用、配置变更属于另一步骤；不要因看到此文档就再次安装。每台设备均须运行加载本插件、具备 Agent Loop 的 DSH，并在**本机** DSH 页面打开左栏「协作中心」。

## 先选网络与角色

1. 两端打开「协作中心」，依次选「局域网」或「公网 P2P」→（局域网再选「物理局域网」或「Tailscale 虚拟局域网」）→ 一端选「创建协作组（Host）」、另一端选「加入协作组（Client）」→ 确认后点「继续」。Tailscale 在这里是**局域网的一个选项**，不是公网 P2P 模式。
2. 物理局域网：确保 Client 能访问 Host 生成的 `ws://Host-IP:动态端口`；Host 页面操作会启动**内置 Relay**，无需另开 `relay.js`。Tailscale：两台设备先登录同一可互访的 tailnet，确认在线、MagicDNS 名称或 Tailscale IPv4 可互访及 ACL/防火墙允许该端口。页面若报 `TAILSCALE_NOT_READY`，先解决 Tailscale 可用性。**不要假设固定 8787 端口**：引导流程的内置 Relay 由系统分配端口，邀请里带实际地址。
3. 公网 P2P：不使用局域网 Relay，也没有自动信令服务器；确保可使用 STUN 的 UDP，Host 具有可用的公网 IPv4 入站路径（公网地址/端口映射/可用 UPnP）。**CGNAT、对称 NAT、严格防火墙或 UDP 封锁可使直连失败**；STUN 不是 TURN，不提供转发或绕过 NAT 的保证。困难网络建议改为 Tailscale 局域网流程。

## 局域网 / Tailscale：自动交换加入申请

1. Host 点「发布 Host 并生成配对码」。看到「一次性配对信息」后，将「连接链接」和六位配对码通过可信渠道交给 Client；邀请有效期显示在页面上，默认约五分钟。配对码不会在链接中明文出现，但会参与邀请加密派生，**不能把它当作完全独立的二次认证因素**；不要把链接和配对码公开发帖。复制按钮若失败，展开并手动选择文本复制。
2. Client 在本机页面粘贴「Host 连接链接」、输入六位配对码，点「申请加入」。请保持两端 DSH 在线，并在 Host 页面查看「待审批加入申请」；若界面未及时显示，点「刷新状态」。
3. Host 核对申请者名称和 ID，选择「权限时间」「权限等级」，点「同意加入」或「拒绝」。局域网批准信息通过配对信令自动返回，不需人工传 Grant。Client 收到后应进入协作页；双方检查「传输状态」「在线节点」，再试发一条不敏感消息。每个邀请只能用一次，当前实现 **一个 Host 协作组最多批准一个 Client**；要更换连接请先处理已有配对，而非反复点击审批。

## 公网 P2P：人工交换三份信令

1. Host 点「发布 Host 并生成配对码」，将「连接链接」及单独六位配对码给 Client。链接在加密邀请内包含完成 ICE 收集后的 **Offer**，页面还会显示有效期。切勿仅发送原始 Offer 而遗漏邀请或配对码。
2. Client 粘贴链接及配对码，点「生成申请包」；将页面的**完整「申请包」JSON**复制给 Host，包含 Answer 和加入申请。Host 把它粘贴到「Client 返回的连接信息」，点「确认对方连接」。该动作等待 DataChannel 打开，最多约 **15 秒**；成功后才出现待审批申请，失败时先诊断网络，不要直接把失败当作已获准。
3. Host 在「待审批加入申请」核对 Client ID，选择权限和时长，点「同意加入」。从「发送审批 Grant」区复制**完整 Grant JSON**交给 Client；拒绝则不会有 Grant。Client 将其贴入「Host 审批后的 Grant JSON」，点「确认 Grant 并接入」。最后双方核对「已连接」和在线节点。Grant 包含协作密钥，按机密数据传递，不在公开渠道转贴。
4. **顺序必须是：Host 链接/码 → Client 申请包 → Host 确认连接并审批 → Host Grant → Client 确认 Grant**。每次重新生成 Host 都使旧公网 Offer、未完成的连接与邀请失效；DSH 进程重启后 WebRTC 会话不能恢复，若页面提示 `PUBLIC_HOST_RECREATE_REQUIRED`，需确认后点「重新生成 Host」并从头交换。此操作可能清空原 Host 的成员和待审批状态，先与另一端协调。

## 权限、Agent 唤醒和撤销

> **高危已知问题：当前版本不能把“可唤醒 Agent（需审批）”视为强制逐次审批。** Client 请求可指定 `approvalLevel: "none"`，接收端现有逻辑可能直接创建本地 Agent；不要向不完全信任的节点授予任何可唤醒权限，直到接收端强制校验授权策略的修复版本发布。

- 加入审批时的「权限时间」为**单次 / 24 小时 / 永久**。「单次」表示 Host 审批后邀请码只允许一次获准加入；Grant 可由对应 Client 确认，**不是自动在发一条消息或一分钟后退出**；24 小时授权过期后发送被拒绝。建议从「仅通信」及较短时长开始。
- 「仅通信」允许协作消息，但客户端不能创建共享任务或发起 Agent 激活；「可唤醒 Agent（需审批）」开放任务和激活请求；「无条件信任」也开放上述能力。**加入权限与每次激活审批是不同层次**：Agent 工具 `network_agent_activate` 的 `approvalLevel` 可以是 `none`（目标端直接创建本地 Agent）、`peer`（目标端审批）或 `privileged`（目标端 ID 还须列在 `privilegedApproverIds`）。源码并未强制把「可唤醒 Agent（需审批）」限制为 `peer`，也未因选择「无条件信任」自动替请求设 `none`；因此不要把 UI 权限文字当成逐次唤醒的强制保证。不要向不信任节点授予可唤醒权限；需要人工审批时请明确指定 `peer` 或 `privileged`。
- 本机「待确认激活」显示需要人工确认的请求；核对标题和详情后点「批准并启动」或「拒绝」。批准后会在**本机**创建 Agent 会话，不跨机传 DSH 凭据或现有会话。页面可发消息、查看任务；创建或更新共享任务以及发起激活目前使用 Agent 工具 `network_agent_task`、`network_agent_activate`，不要寻找不存在的 UI 按钮。
- Host 在「节点」卡点「移除成员」时会再弹确认，并轮换组密钥；**其他已连接成员也需要重新配对**。任一端可点「退出协作」，确认后停止本机连接并清除当前本机配对；另一端的持久状态未必自动同步清理。若 Grant、连接链接或配对码泄露，不要只等过期：由 Host 移除成员并重新建组/配对，并通知对端。不要手动传播本机 `setup.json`、`identity.json` 或 `shared-secret`。
- **破坏性操作警告：** LAN 页面「重新生成新邀请码」不是无损刷新；当前实现会重建 Host 协作组、轮换密钥并清空成员与待审批请求，而且页面未必先弹确认。执行前先通知所有成员并确认确实要从头配对。

## 观察及故障排查

| 现象 | 先检查 |
|---|---|
| 没看到左栏「协作中心」或页面报「无法读取协作状态」 | 核实实际运行的 DSH 已加载兼容的 Host/Client 插件且 Agent Loop 可用；确认现有 DSH Web 服务在本机工作。页面请求的是**现有 Web Server** 的 `/network-agent-collab` 前缀，而不是独立监听的 8788 服务。源码目前只使用 `ui.enabled` 开关，**`ui.port` 不决定页面路由**；旧 README 中关于修改 8788 的说法不适用于当前源码。 |
| 链接/匹配码不正确、过期、邀请已被使用 | 从 Host 复制完整链接及单独的六位码；检查两端时钟及有效期，必要时 Host 重新生成邀请并让 Client 从头操作，不能复用旧的申请或 Grant。 |
| LAN 显示 `relay-connecting`、`RELAY_UNAVAILABLE` | 检查 Host DSH/内置 Relay 正在运行、邀请的主机地址可达、主机/本机防火墙及所示端口；Tailscale 还检查双方在线和 ACL。不要把“已点击发送”当成对端已收到。 |
| 公网显示 `public-waiting-for-signal`、`DIRECT_CHANNEL_NOT_OPEN` | 先按三份信令的顺序与完整 JSON 核对；再确认 STUN 可达、IPv4/UDP、Host 入站映射与 NAT 类型。两端都在 CGNAT 或对称 NAT 下时**无 TURN 兜底**，改用 Tailscale/可互访局域网。 |
| 传输显示已连接但找不到节点 | 等待双方上线宣布 presence，点「刷新」核对「在线节点」；连接与真正匹配是两项不同状态。 |
| `COLLABORATION_PERMISSION_DENIED` / `COLLABORATION_ACCESS_EXPIRED` / `PRIVILEGED_APPROVER_NOT_CONFIGURED` | 分别检查加入时权限等级、24 小时授权时间、目标机本地 `privilegedApproverIds` 配置；不要用多点几次审批代替修正配置。 |
| 公网 Host 重启后原邀请打不开 | WebRTC 内存会话无法重建；按页面确认「重新生成 Host」，与 Client 交换全新的链接/申请包/Grant。 |

### 已知验证边界与源码差异

- 仓库 `HANDOFF.md` 将**真实浏览器视觉交互和跨设备公网直连**列为现场待验证；本说明只给出基于 0.4.11 源码的操作路径，不声称任何特定网络已打洞成功。自检可在仓库执行 `node --check index.js && node --check client.js && npm test`，但单元测试不能替代跨设备现场试验。
- `README.md` 的旧 `PORT=8787 node relay.js` 是**手动外部 Relay 示例**，不是协作中心 Host 引导的必需动作；其 `ui.port: 8788` 说明也与当前集成 Web Server 的实现不一致。UI 显示「重新生成新邀请码」时底层 `hostCreate` 实际会重新建组并清理成员，不应当作无损刷新按钮。
- 技术边界：LAN Relay 仅转发，协作帧用 HMAC 校验完整性、**不加密消息内容**；若跨不可信网络必须另用安全隧道或 TLS/WSS。公网采用 WebRTC DataChannel，STUN 仅发现可用候选，未配置 TURN/付费 Relay；不能承诺所有 NAT 环境均可达。当前 UI/Host/Client 的授权与恢复路径应在目标 DSH 部署现场核验。

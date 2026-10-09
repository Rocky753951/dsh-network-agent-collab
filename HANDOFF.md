# dsh-network-agent-collab 交接文档

## 项目位置

服务器目录已统一为 `dsh-network-agent-collab`，Git 仓库：

https://github.com/Rocky753951/dsh-network-agent-collab

## 当前版本

- 版本：0.4.12
- 最新提交：见仓库 `git log -1`（本交接文档随版本提交同步）
- 包文件：`dsh-network-agent-collab-0.4.12.tgz`

## 已实现

- 局域网物理网络 / Tailscale 网络选择。
- Host/Client 分步初始化与持久化恢复。
- 邀请信息、六位配对码、Host 审批。
- 审批时长：单次、24 小时、永久。
- 权限等级：仅通信、唤醒 Agent 需审批、无条件信任。
- Client 与 Host 的 Agent 一对一匹配限制。
- 公网配对默认走端到端加密 Nostr 控制信令；签名 Grant 绑定最终 WebRTC Offer，获批后通过 DataChannel 建立数据面。无须预先设置 `networkScope` 或手工 Grant JSON。公共 Relay/STUN 无法解决所有 NAT 类型；未配置 TURN。
- LAN 未提供 `sharedSecret` 时自动生成并持久化受保护的本地 secret；无需手工配置即可启动。
- 自动配对使用内置免费公共 Nostr Relay；用户可选自定义 Relay。无 TURN 兜底，严格 NAT/CGNAT 网络可能无法直连。
- 协作中心的人类操作路径整改：初始化错误可见、复制失败手动恢复、Host 成员移除确认、审批权限双路径一致。
- 默认公网选择无需插件配置即可创建临时 Nostr signer；新增 LAN 静态配置下公网 Host 启动测试，真实浏览器视觉、公共 Relay 与跨设备/NAT 直连仍需现场验证。

## 验证

在项目目录运行：

```bash
node --check index.js
node --check client.js
npm test
```

当前测试为 55/55 通过（以 `npm test` 实际输出为准）。

## 公网直连使用边界

公网默认自动流程：Host 创建配对码，Client 自动申请，Host 审批后 Grant/Offer/Answer 通过加密信令交换。只有 Relay 信令启动失败时才提示安全手工 fallback；对称 NAT、CGNAT 或 UDP 被封锁时，WebRTC 仍可能无法直连。

## 发布包

```text
https://github.com/Rocky753951/dsh-network-agent-collab/raw/v0.4.12/dsh-network-agent-collab-0.4.12.tgz
```

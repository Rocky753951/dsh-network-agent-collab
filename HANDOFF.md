# dsh-network-agent-collab 交接文档

## 项目位置

服务器目录已统一为 `dsh-network-agent-collab`，Git 仓库：

https://github.com/Rocky753951/dsh-network-agent-collab

## 当前版本

- 版本：0.4.0
- 最新提交：687f579
- 包文件：`dsh-network-agent-collab-0.4.0.tgz`

## 已实现

- 局域网物理网络 / Tailscale 网络选择。
- Host/Client 分步初始化与持久化恢复。
- 邀请信息、六位配对码、Host 审批。
- 审批时长：单次、24 小时、永久。
- 权限等级：仅通信、唤醒 Agent 需审批、无条件信任。
- Client 与 Host 的 Agent 一对一匹配限制。
- 公网 IPv4 WebRTC DataChannel 直连基础：STUN、手动 Offer/Answer、Grant 确认。
- 不依赖 V2Ray、IPv6、付费 Relay 或 TURN。

## 验证

在项目目录运行：

```bash
node --check index.js
node --check client.js
npm test
```

当前测试为 24/24 通过。

## 公网直连使用边界

Host 生成 Offer；Client 粘贴 Offer 并生成申请包；Host 粘贴 Answer、审批后生成 Grant；Client 粘贴 Grant 完成接入。对称 NAT、CGNAT 或 UDP 被封锁时，WebRTC 直连可能失败，这是 IPv4 网络条件限制。

## 发布包

```text
https://github.com/Rocky753951/dsh-network-agent-collab/raw/main/dsh-network-agent-collab-0.4.0.tgz
```

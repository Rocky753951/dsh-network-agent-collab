# DSH Network Agent Collab

多端 DSH Agent 协作插件，连接方式分为两大类：**局域网**（普通局域网或 Tailscale 虚拟局域网）与**公网**（一台电脑作为 Host/Relay，其余电脑作为 Client）。

## 已实现：局域网协作

适用于 A、B、C 主机已可相互访问的场景。所有 DSH 客户端连接同一个局域网 WebSocket Relay；Agent 可以：

- 发现同一房间内的 Agent；
- 相互发送协作消息；
- 创建、领取、更新、完成共享任务；
- 向指定 Agent 或全部 Agent 投递“激活协作”请求；
- 对本机收到的激活请求审批或拒绝；
- 审批通过后在目标主机创建一个本地 DSH Agent，并将签名请求作为首条用户消息提交，唤醒其 Agent Loop。

> 激活不跨网络传递 DSH Session 或凭据：发送端只投递签名请求，**目标主机**基于自己的 provider/model 配置创建本地会话。

每个帧以共享密钥进行 HMAC-SHA-256 签名；LAN 模式拒绝启动，除非配置非默认、至少 32 字节的密钥和稳定唯一的 `agentId`。客户端拒绝签名错误、超过 ±5 分钟时钟偏差、超过 64 KiB 或重复的帧。Relay 不保存任务、消息或密钥，只按房间转发；Relay 未连接时写操作返回 `RELAY_UNAVAILABLE`，不会谎报已送达。

### 分级审批

`network_agent_activate` 的 `approvalLevel`：

| 等级 | 行为 |
|---|---|
| `none` | 请求发布后由目标主机直接创建本地协作 Agent。 |
| `peer` | 目标 Agent 必须使用 `network_agent_approve` 发送 `approved`；随后目标主机创建本地协作 Agent。 |
| `privileged` | 仅当目标主机把自身 `agentId` 列入 `privilegedApproverIds` 时可审批；审批通过后才创建本地协作 Agent。 |

审批帧必须匹配已存在、仍为 `pending` 的请求，且只能由该请求的目标 Agent 签发；其他同房间节点的伪造审批会被忽略。

## 连接方式

### 局域网（普通网络或 Tailscale）

```yaml
networkScope: lan
lanTransport: local       # 普通局域网
# 或 lanTransport: tailscale
relayUrl: ws://主机地址:8787
```

Tailscale 是局域网的子选项，不是独立的公网模式。

### 公网 Host/Client

一台电脑运行 Relay 并作为主机，其他电脑连接它：

```yaml
networkScope: public
publicRole: host           # 主机电脑
# publicRole: client       # 其他电脑
relayUrl: ws://主机公网地址:8787
```

公网使用时应配置端口转发、防火墙规则，并在生产环境使用 `wss://`、设备配对和 TLS。Host 下线时 Client 无法继续通信。

旧配置 `mode: internet` 仍保留兼容性，但不再推荐；请使用上面的 `networkScope`。

## 安装与首次连接

在插件目录执行：

```bash
dsh plugin --profile web add ./
```

插件必须加载在已有 Agent 上；没有 `agentLoop` 会拒绝启动。首次打开“协作中心”按三个可返回步骤操作：

1. 选择“局域网”或“公网 P2P”；
2. 选择 Host 或 Client（局域网还可选择物理网/Tailscale）；
3. Host 启动后生成 Host 邀请和六位匹配码，Client 粘贴两者申请加入。

Host 会在页面实时显示 Client 申请，可选择：单次/24 小时/永久，以及仅通信/可唤醒 Agent（需审批）/无条件信任。每个 Agent 只允许匹配一次。配对密钥只在 Host 批准后通过信令发送，状态和日志不会展示密钥。

公网 Host 必须填写客户端可访问的 `wss://` Relay 地址，并自行配置端口转发、TLS 和防火墙；公网 P2P 不提供免费的 NAT 穿透服务。
## 启动局域网 Relay

在局域网中一台可访问的机器上：

```bash
npm install
PORT=8787 node relay.js
```

跨不可信网络时应使用 TLS 反向代理和 `wss://`。HMAC 仅保证来源完整性，不加密消息内容。

## 图形协作中心

插件会在 DSH 左侧栏增加 **“协作中心”**。该页面可查看本机传输状态、已发现节点、共享任务和本机待审批激活请求，并可批准/拒绝激活、发送消息、创建任务。

页面通过仅绑定 `127.0.0.1:8788` 的本机桥接访问 Host 状态；不向网络公开密钥或管理接口。端口可配置：

```yaml
ui:
  enabled: true
  port: 8788
```

如果端口已被占用，修改 `port` 后重启 DSH；禁用界面桥接可设为 `enabled: false`。

## Agent 工具

LAN：`network_agent_status`、`network_agent_peers`、`network_agent_message`、`network_agent_activate`、`network_agent_approve`、`network_agent_task`。

两种模式均提供：`network_agent_tailscale_status`。

## 测试

```bash
npm test
```

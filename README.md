# DSH Network Agent Collab

多端 DSH Agent 协作插件，分为两种模式：**局域网（已实现）**与**互联网 / Tailscale（仅接入与状态检测，暂不传递协作业务）**。

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

## 互联网模式：Tailscale 脚手架

设置 `mode: internet` 后，插件**不会建立协作消息通道**。它仅提供 `network_agent_tailscale_status`，通过只读 `tailscale status --json` 返回本机、Tailnet 节点及连接状态，为后续 Internet transport 做准备。

## 安装

在插件目录执行：

```bash
dsh plugin --profile web add ./
```

配置每台 DSH 的 bundle。LAN/Tailscale Relay 模式必须使用相同的 `roomId` 与 `sharedSecret`。`agentId` 可省略，插件会按本机主机名自动生成稳定 ID；如果同一主机运行多个 DSH 实例，请手动指定唯一 ID：

```yaml
- name: dsh-network-agent-collab
  config:
    mode: lan
    relayUrl: ws://192.168.1.10:8787
    roomId: engineering-alpha
    sharedSecret: "替换为 openssl rand -base64 32 的输出"
    agentName: agent-a
    agentId: host-a-agent
    capabilities: [chat, tasks, activation]
```

互联网 / Tailscale 脚手架示例：

```yaml
- name: dsh-network-agent-collab
  config:
    mode: internet
    agentName: agent-a
    agentId: host-a-agent
```

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

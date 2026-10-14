<div align="center">

[English](../01-tutorial.md) · **简体中文** · [繁體中文](../zh-TW/01-tutorial.md) · [日本語](../ja/01-tutorial.md) · [한국어](../ko/01-tutorial.md) · [Deutsch](../de/01-tutorial.md) · [Español](../es/01-tutorial.md) · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_zh.md) · **教程** · [协议](02-protocol.md) · [架构](03-architecture.md) · [命令参考](command-reference.md)

</div>
# 教程：从零跑通 dsh-unreal-agentlink

本篇是端到端的上手路径。目标：让 DSH 里的 agent 能真正驱动本机 Unreal 编辑器，并知道什么该做、什么会卡住。

阅读顺序建议：本篇 → [协议](02-protocol.md) → [架构](03-architecture.md) → [命令参考](command-reference.md)。

---

## 1. 心智模型：先建立四个事实

在动手之前，这四件事决定了后面所有操作的写法。它们不是设计取舍，是 UnrealAgentLink 的既有约束。

**① 方向是反的。** 不是本插件去连编辑器，是**编辑器主动连出来**。UnrealAgentLink C++ 插件在 `StartupModule` 里无条件发起 `ws://127.0.0.1:17860`，本插件在这个端口上监听。所以启动顺序无所谓：编辑器先开就每 5 秒重试一轮，插件后启动照样接上。

**② 没有鉴权。** 无 token、无 header、无子协议。**端口本身就是凭证** —— 谁能连上 17860，谁就能驱动编辑器。因此默认只绑 loopback，不要改成 `0.0.0.0`。

**③ 命令在游戏线程上串行执行。** 编辑器收到命令后，如果不在游戏线程就重新投递到游戏线程，然后**同步执行到结束**。这带来两个后果：

- 同一编辑器的命令天然排队，本插件也按编辑器串行发送。
- **阻塞命令运行期间，编辑器什么都不回** —— 连 `sequence.render_status` 这类进度查询也不回。此时发任何别的命令都只是排在后面。

**④ 没有取消。** 协议里不存在 `query_task` / `cancel_task`。`ual_task` 的「杀作业」只停掉**本插件这边的等待**，引擎侧照跑不误，结果依然会回来。这是 `ual_task` 的工具描述里明确写给模型看的一句话。

---

## 2. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | 插件 `.uplugin` 声明的范围 |
| UnrealAgentLink | C++ 插件本体 | 放进工程的 `Plugins/` 目录 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 见 `package.json` 的 `engines` |
| DSH 运行时 | 可用即可 | 本插件作为 bundle 装入 |

**不需要 UEBox 桌面版。** 它只是同一厂商的另一个客户端，恰好也连 17860，所以同时跑会抢端口。详见 [README 的「不需要安装 UEBox」](../readme/README_zh.md#不需要安装-uebox)。

### 装 UnrealAgentLink 到 UE 工程

1. 把 `UnrealAgentLink` 整个目录复制到工程的 `Plugins/` 下（或引擎的 `Plugins/` 下，全局生效）。
2. 重新生成工程文件并打开工程。
3. **Edit → Plugins** 里确认 UnrealAgentLink 已启用。

插件会自动启用两个引擎自带依赖：`IKRig` 与 `PythonScriptPlugin`（见 `.uplugin`）。编辑器启动后即开始连 17860，无需任何配置。

> 若端口被占（比如 UEBox 桌面版在跑），给编辑器换端口：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> 本插件侧对应改 `port` 配置。

---

## 3. 安装本插件

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 154 个测试 + catalog 对账，一条命令
```

`npm run check` 必须全绿再往下走。它验证三件事：源码与测试都能通过类型检查、行为测试全过、170 条命令目录与 C++ 注册表逐条对齐。

### 作为 DSH bundle 装入

`package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，该文件只做一件事：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**注意**：DSH 配置分层中，后一层会**整体替换**这一行的 `config`，而不是深合并。要覆盖任何配置键，必须把想保留的键全部重写一遍。

---

## 4. 第一次跑通

### 第 1 步：确认桥活着

让 agent 调用 `ual_status`。关注四个字段：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → 插件没起来，或端口被占。看 DSH 日志里的 `EADDRINUSE` 提示。
- `listening: true` 但 `editors: []` → 桥在等编辑器。确认 UE 工程已打开、UnrealAgentLink 已启用。

编辑器连接后的**一瞬间**，记录里只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` —— `project` 等字段要等编辑器推来 `project.info` 才会出现。这是正常状态，不是错误。

### 第 2 步：发现能力

不要猜命令名。两步走：

```
ual_tools  { filter: "material" }     → 列出 material 族的命令与一行说明
ual_schema { method: "material.create" } → 该命令的参数键、必填键、结果键、状态码
```

`ual_schema` 的键名是从 C++ handler 里**逐字提取**的。这一步不能省：**UE 对未知或类型不对的键是静默忽略的** —— 传错键名不会报错，只会「成功」地什么都没做。

### 第 3 步：第一个真实调用

```
ual_call { method: "level.get_current" }
```

纯读，无副作用。返回编辑器 `result` 的**原样内容**，本插件不做任何重塑。

### 第 4 步：看一眼关卡

```
ual_screenshot { width: 1280, height: 720 }
```

返回的是**真实图片**，agent 能直接看到。比 `ual_call { method: "editor.screenshot" }` 好用 —— 后者只返回一个文件路径。

截图结果里的 `pending_shaders` / `pending_assets` 不为 0，说明画面还在编译或流式加载，**不是最终外观**。不要据此判断材质有问题。

---

## 5. 常见工作流

### 改一个 actor 的属性

```
ual_schema { method: "actor.set_property" }        # 先看键名
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

属性名拼错时，编辑器**返回候选建议**而不是 404。读建议，别重试错拼写。

### 批量操作

已知要做的一串事，用 `ual_batch` 一次往返完成：

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- 串行执行（编辑器本来就是串行的），默认**首个失败即停**，`continueOnError: true` 可改。
- 上限 `maxBatchCalls`（默认 12）。
- **只要有一项是危险操作，整批都走审批。** 审批提示会点名是哪个危险项。

### 长任务

阻塞游戏线程的命令必须走 `ual_task`：

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "渲染主序列" }
```

立即返回 `jobId`，对话继续。用 `job_output` 收结果。

哪些属于长任务：`sequence.render`、`cpp.compile`、`level.build`、`blueprint.compile_all`、`pcg.execute`、`pie.run`、资产导入。`ual_schema` 的超时列会标出「阻塞」。

**不要**在长任务跑的时候轮询编辑器 —— 它不会回。

### 撤销

```
ual_undo_history        # 先看缓冲区里有什么
ual_undo { dryRun: true }   # 演练
ual_undo                # 真的撤销
```

UnrealAgentLink 为每个编辑器维护**一条独立的 agent 撤销栈**，与用户的 Ctrl+Z 历史分开。本插件记录每一步属于哪个 DSH 会话，**只在本会话的步骤构成缓冲区的干净 LIFO 后缀时才回滚**。若期间别的会话动过编辑器，本工具**什么都不撤**，并把两份步骤列表都报出来，而不是默默撤掉别人的工作。

### 声明资产锁

多步修改某个资产前：

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... 改 ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

编辑器会在内容浏览器上画「AI 正在编辑」角标，用户动手改时会收到提醒。多个会话的声明由本插件合并成一张表下发给编辑器；编辑器重连后会重新下发。

### 看日志

```
ual_logs { level: "Warning", contains: "Niagara" }
```

日志环默认是空的 —— UE 侧的日志转发**默认关闭**，需要在编辑器内执行 `ual.ForwardLogs 1`（本插件无法远程开启）。`ual_logs` 返回空时会提示这一点。

转发关闭时用引擎自己的消息日志替代：

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. 出错时怎么读

本插件**绝不解析错误文案**（文案随编辑器文化切中英文），只按**错误类名与状态码**分类，共 16 种 kind。

| kind | 含义 | 该做什么 |
|---|---|---|
| `no-editor` | 没有编辑器连着 | 打开 UE 工程；确认插件已启用 |
| `timeout` | 超时，**命令可能还在跑** | **不要重发**。先用读命令确认结果，再决定 |
| `editor-lost` | 编辑器断开 | 等它按 5 秒周期重连 |
| `queue-stalled` | 前面有命令超时了 | 先查 `ual_status` 的 `orphaned` |
| `circuit-open` | 连续传输失败，熔断已开 | 停手，等冷却，查 `ual_status` |
| `rate-limited` | 限流队列满 | 降速 |
| `not-found` | 方法不存在或资产不存在 | 用 `ual_tools` 查真实命令名 |
| `bad-params` | 参数缺失或类型错 | 用 `ual_schema` 核对键名 |
| `precondition` | 前置条件不满足（412/413/422） | 读 `details`；422 意为「输入合法但一件都没写进去」 |
| `registry-busy` | 资产注册表还在扫描 | 轮询 `content.registry_status` |
| `unsupported` | 该编辑器版本不支持 | 例如 `anim.*` 需要 UE 5.5+ |
| `engine-error` | 编辑器自身出错 | 读 `result.message`（给人看）与 `details`（给机器看） |

**超时是最需要纪律的一种。** 协议没有取消语义，超时只表示「本插件不等了」，命令很可能仍在游戏线程上跑。正确反应是：先 `ual_status` 看 `orphaned`，再用只读命令验证实际状态，**不要重发**。

---

## 7. 配置

全部键都可改，默认值是「活着但惰性」。完整表见 [README](../readme/README_zh.md#配置)。几个值得留意的：

- **`port`** —— 改了这里，UE 侧也要用 `-UALServer=` 改。
- **`rateLimitRps: 0`** —— 关闭限流。
- **`rollbackOnDispose: false`** —— 会话结束时**不**自动撤销。打开它意味着会话销毁就回滚，而这通常是用户没要求的意外。
- **`logForwardingEnabled: false`** —— 只在编辑器内开过 `ual.ForwardLogs 1` 之后才置 `true`。

---

## 8. 故障排查

**`ual_status` 显示 `listening: true` 但没有编辑器**
UE 工程没开，或 UnrealAgentLink 没启用。也可查编辑器日志里的 `LogUALNetwork`：正常应看到 `Connecting to ws://127.0.0.1:17860` 与 `Connected to`。

**启动时 `EADDRINUSE`**
17860 被占。最常见的是 UEBox 桌面版。关掉它，或给编辑器与本插件同时换端口。

**命令都返回 `unknown-method` 或被直接拒绝**
本插件只放行目录里真实存在的 170 条命令。用 `ual_tools` 确认命令名。已废弃的命令（如 `editor.play`、`take_screenshot`）会明确给出替代方法。

**截图是黑的 / 半成品**
看 `pending_shaders` / `pending_assets`。非 0 就是还没编译完或还在流式加载。加大 `warmup_frames` 再试。

**`ual_undo` 拒绝执行**
本会话的步骤不是缓冲区的干净 LIFO 后缀 —— 期间有别的会话动过编辑器。这是**有意的保护**，不是 bug。用 `ual_undo_history` 看实际内容。

**改了配置没生效**
DSH 配置分层是**整体替换**该行的 `config`，不是深合并。必须把所有想保留的键一起写出来。

**`ual_task` 杀了作业但编辑器还在忙**
预期行为。协议没有取消语义。等它跑完 —— 或更实际地说，下次别在长任务运行期间发别的命令。

---

## 9. 下一步

- [协议参考](02-protocol.md) —— 报文结构、事件、状态码
- [架构](03-architecture.md) —— 门链、会话隔离、错误翻译的设计理由
- [命令参考](command-reference.md) —— 170 条命令的完整参数与结果键（自动生成）

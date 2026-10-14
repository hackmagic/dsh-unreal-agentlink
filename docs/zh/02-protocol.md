<div align="center">

[English](../02-protocol.md) · **简体中文** · [繁體中文](../zh-TW/02-protocol.md) · [日本語](../ja/02-protocol.md) · [한국어](../ko/02-protocol.md) · [Deutsch](../de/02-protocol.md) · [Español](../es/02-protocol.md) · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_zh.md) · [教程](01-tutorial.md) · **协议** · [架构](03-architecture.md) · [命令参考](command-reference.md)

</div>
# 协议参考

UnrealAgentLink 的线协议。本插件是**服务端**，Unreal 编辑器是**客户端**。

所有结论来自 `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/` 的 C++ 源码，关键处标注了文件与行号。

---

## 1. 连接

| 项 | 值 | 依据 |
|---|---|---|
| 方向 | UE 主动连出 | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| 默认地址 | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| 改地址 | 命令行 `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| 鉴权 | **无** —— 无 token、无 header、无子协议 | `CreateWebSocket` 只传 URL |
| 重连 | 固定 5 秒一轮，无退避 | `Network/UAL_NetworkManager.cpp:116` |
| 连接卡死保护 | 有（`ConnectTimeoutSeconds`） | `Network/UAL_NetworkManager.cpp:145-155` |

本插件侧监听 17860，`maxPayload` 64 MB。

### 来源校验

只接受 loopback 来源（`127.*`、`::1`、`::ffff:127.*`）。仅当配置的 `host` 被**故意**改成非 `127.0.0.1` / `localhost` 时才放宽。原因见「没有鉴权」——端口就是凭证。

### 握手

**没有握手。** 编辑器连上后立刻主动推 `project.info`，本插件据此标记该编辑器已识别（`editor-identified`）。在收到它之前，连接是「已连上但未识别」状态 —— 此时 `ual_status` 里那条记录只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`，没有 `project` 等字段。

---

## 2. 报文结构

```
UE → 插件:  { ver:"1.0", type:"req",  method, id, params }
插件 → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → 插件:  { ver:"1.0", type:"evt",  method, payload }
```

### `req`（本插件 → 编辑器）

| 字段 | 说明 |
|---|---|
| `ver` | 固定 `"1.0"` |
| `type` | `"req"` |
| `method` | 命令名，如 `actor.get_info` |
| `id` | 由**服务端**生成，格式 `dsh-<uuid>` |
| `params` | 可选。**为空时整个键省略**，不是 `null` |

`id` 必须非空：`SendResponse` 的第一行是 `if (RequestId.IsEmpty()) { return; }`（`Utils/UAL_CommandUtils.cpp:2503-2506`）——**没有 id 的请求永远不会有回复**。

编辑器侧的解析（`Commands/UAL_CommandHandler.cpp:87-94`）先读 `params`，读不到再回退到旧字段 `payload`。本插件只发 `params`。

### `res`（编辑器 → 本插件）

| 字段 | 说明 |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | 回显请求的 `id`，用于匹配 |
| `code` | **数字**，不是字符串 |
| `result` | 可选。**无内容时整个键省略** |

`result` 的省略逻辑在 `Utils/UAL_CommandUtils.cpp:2513-2516`：仅当 `Data.IsValid()` 才写入 `result`。

编辑器侧的响应体解析（`Commands/UAL_CommandHandler.cpp:98-104`）依次尝试 `result` → `data` → `payload`。本插件发的是 `result`。

### `evt`（编辑器 → 本插件，单向推送）

| 字段 | 说明 |
|---|---|
| `ver` | 事件由 `SendEvent` 发出时带；**内容浏览器扩展发出的 import 事件不带** |
| `type` | `"evt"` |
| `method` | 事件名 |
| `payload` | 可选 |
| `id` | **不存在** —— 事件不可回复 |

---

## 3. 失败如何表达

**只由 `code` 表达。** 报文里**没有** envelope 级的 `error` 字段。

| 码 | 含义 | 本插件的 kind |
|---|---|---|
| `200` | 成功 | — |
| `207` | 部分成功 | `partial: true` |
| `400` | 参数缺失/类型错 | `bad-params` |
| `404` | 方法或资产不存在 | `not-found` |
| `409` | 冲突（如独占的 profiling 已在跑） | `conflict` |
| `410` | 已移除 | `not-found` |
| `412` | 前置条件不满足 | `precondition` |
| `413` | 超出上限（如批量创建超过 cvar 上限） | `precondition` |
| `422` | 输入合法但什么都没写成 | `precondition` |
| `500` | 编辑器内部错误 | `engine-error` |
| `501` | 该版本不支持 | `unsupported` |
| `503` | 资产注册表还在扫描 | `registry-busy` |
| `504` | 编辑器侧超时 | `timeout` |

`0` **从未被使用**。

这 13 个码定义在 `protocol/types.ts` 的 `UAL_CODES`，`scripts/check-catalog.mjs` 的第 4 项检查会直接回查 C++ 源码（包括 `FUAL_RegistryReady::Ensure` 这类共享闸门发出的 503、以及 `Code = bOk ? 200 : 207` 这种表达式形式的码），少一个多一个都会失败。

### 错误文本在哪

```
result.message   ← 给人看的，按编辑器文化分中英文，绝不解析
result.details   ← 给机器看的（suggestions / expected_type / registry 进度）
```

`SendError` 构造 `{message: ...}`，4 参数重载再挂上 `details`（`Utils/UAL_CommandUtils.cpp:2525-2539`）。

### 200 也可能是失败

**这是最容易踩的坑。** 许多 handler 返回 `200`，但 `result.ok === false`：

- `editor.undo` —— 没有可撤销的步骤时
- `blueprint.compile` —— 编译有错时
- `pie.observe` —— 观察失败时

所以本插件用 `judge(result, code)` 判成败，而不是只看 code：

| 情况 | 判定 |
|---|---|
| `code === 200`，`result.ok !== false`，`result.error` 为空 | 成功 |
| `code === 207` | 成功但 `partial: true` |
| `result.ok === false` | **失败** |
| `result.error` 是非空字符串 | **失败** |
| `result` 不是对象（或无 `result`） | 按 code 判定，不猜 |

这条规则是**必需**的：C++ 里共有 55 处 `SetStringField(TEXT("error"), ...)`，分布在 14 个文件。也就是说「200 + 非空 error」是常态而非异常。

---

## 4. 事件

| 事件 | 何时发 | payload |
|---|---|---|
| `project.info` | 连上后立刻，作为握手的替代 | 项目名、路径、引擎版本、插件版本、运行模式、当前关卡、Python 可用性等 |
| `project.closed` | 编辑器关闭工程 | — |
| `system.heartbeat` | 每 **10 秒** | `{}`（**总是存在**，不是省略） |
| `log.entry` | UE 日志（需 cvar `ual.ForwardLogs 1`） | `text` / `category` / `level` |
| `content.import_folder` | 用户在内容浏览器右键「导入到虚幻盒子资产库」 | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | 同上，从关卡视口发起 | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### 心跳与判死

心跳是**独立的 10 秒 ticker**（`Network/UAL_NetworkManager.cpp:173`），与 5 秒重连无关。本插件在 **45 秒**无心跳后把编辑器标为 `stale` —— 与前端一致（`Network/UAL_NetworkManager.cpp:172` 的注释）。

### 两个 import 事件是即发即弃的

它们**不带 `id`**，编辑器**不等待回复**。编辑器侧的 `Handle_Response`（`Commands/UAL_CommandHandler.cpp:185-297`）只在收到 `type:"res"` 时弹一个 Slate 通知，读 `ok` / `count` / `importedPath` / `error`。

本插件是纯桥接、没有导入资产的能力，所以它把事件**转成日志与 agent 通知**，而**不回一个假的 `res`** —— 回 `ok:false` 只会让用户看到一个虚假的「导入失败」对话框，比沉默更糟。

---

## 5. 序列化规则

出站参数经 `protocol/serialization.ts` 的 `toSerializable()` 检查后才上线。它比 `JSON.stringify` 严格，因为 **UE 会把读不出的字段当作「没传」** —— 静默地什么都不做，比报错更难查。

| 输入 | 处理 |
|---|---|
| `null` / 布尔 / 字符串 | 原样 |
| 有限数字 | 原样 |
| **非有限数字**（`NaN` / `Infinity`） | **抛错** —— UE 会把它读成「字段不存在」 |
| `undefined`（顶层，或数组内） | **抛错** |
| `undefined`（对象属性的值） | **丢弃该键** |
| 函数 / symbol / bigint | **抛错** |
| 循环引用 | **抛错** |
| `Uint8Array` | 转 base64 字符串 |
| `Date` | 转 ISO 字符串 |
| `Map`（键必须是字符串） | 转普通对象 |
| `Set` | 转数组 |
| 其他非普通对象（类实例等） | **抛错** |

只有普通对象、数组与 JSON 标量可以通过。

---

## 6. 时序与并发

**同一编辑器的命令是串行的。** 本插件为每个编辑器维护一条发送队列，后一条挂在前一条的 `then` 上。这不是为了配合协议，而是因为编辑器本来就在游戏线程上同步执行到结束。

**跨编辑器的队列互相独立。** 多个编辑器同时连入时，各自一条队列。

### 超时

默认 180 秒，阻塞类命令按方法各自抬高下限（`ual_schema` 的超时列会标出「阻塞」）。

**超时 ≠ 命令没执行。** 超时只表示本插件不等了。此时：

1. 该编辑器被标记为「有孤儿命令」（`ual_status` 的 `orphaned`）。
2. 之后发往同一编辑器的**短命令会被直接拒绝**（`queue-stalled`），而不是排在可能永不返回的工作后面。
3. `long: true` 的调用仍可发出 —— 那是「我愿意等」的表达方式。

**被取消（abort）的调用同样如此**：`ual_task` 的杀作业走的就是 abort，而 abort 只停本插件的等待，引擎侧照跑。所以 abort 也会记孤儿。

### 断连

编辑器断开时，该编辑器所有在途请求以 `editor-lost` 失败，错误里带着全部方法名。

---

## 7. 本插件不发的东西

为了明确边界：

- **不传 token**，因为没有鉴权机制。
- **没有 `GET /api/ual/action`** —— 旧文档把它写成 HTTP 服务，那是错的。
- **没有任务轮询** —— 不存在 `query_task` / `cancel_task`。
- **不伪造 `res`** —— 见 import 事件一节。
- **不主动重连编辑器** —— 方向是反的，编辑器自己每 5 秒重试。

---

## 8. 相关文件

| 文件 | 内容 |
|---|---|
| `src/protocol/types.ts` | 报文类型、`UAL_CODES`、`UalError` |
| `src/protocol/bridge.ts` | WebSocket 服务端、队列、超时、孤儿、日志环 |
| `src/protocol/serialization.ts` | 上表全部序列化规则 |
| `src/service.ts` | `judge()`、门链、ledger |
| `src/errors/translate.ts` | 状态码/类名 → 16 种 kind |

C++ 侧对照：`Utils/UAL_CommandUtils.cpp`（`SendResponse` / `SendError` / `SendEvent`）、`Commands/UAL_CommandHandler.cpp`（入站分发）、`Network/UAL_NetworkManager.cpp`（连接、心跳、重连）。

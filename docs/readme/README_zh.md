<div align="center">

[English](../../README.md) · **简体中文** · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### 一个把 Unreal 编辑器交给 agent 的 DSH 插件。

**纯桥接。agent 负责规划，本插件只负责翻译。**

```
DSH agent  ──工具调用──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal 编辑器
（规划、决策）             （本插件：服务端、翻译）   编辑器主动连出
```

[需要什么](#需要什么) · [安装](#安装) · [12 个工具](#12-个工具) · [配置](#配置) · [文档](#文档)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

你的 agent 已经会读文件、跑命令了。这个插件把**编辑器本身**也交给它：查询关卡、生成 actor、编辑蓝图与材质、渲染序列、截取它能真正「看见」的图，出错时撤销自己的工作。

它**不规划任务**。任务规划属于 DSH 的原生 agent。本插件是一层带安全措施的翻译器 —— 把 agent 的意图翻成 UnrealAgentLink 命令，把编辑器的回答翻回 agent 能据以行动的形状。

---

## 需要什么

| 项 | 要求 |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | C++ 插件本体，放进工程的 `Plugins/` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH 运行时 | 可用即可，本插件作为 bundle 装入 |

### 不需要安装 UEBox

UEBox 桌面版**不是依赖**。它只是同一厂商的另一个客户端，恰好也连 17860，所以同时跑会抢端口 —— 关系仅此而已。依据：

- `UnrealAgentLink.uplugin:25-34` 只声明两个依赖，都是引擎自带：`IKRig` 与 `PythonScriptPlugin`。没有任何 uebox 模块。
- `UnrealAgentLink.Build.cs` 的每一项依赖都是引擎模块（UnrealEd / AssetRegistry / MovieScene / Landscape …）。没有 uebox SDK。
- 整个源码里 `uebox` 出现 3 次，都是 `// Copyright uebox.ai` 版权头。
- 没有任何代码调用 uebox.ai。唯一的 `FHttpModule` 用法是读本机代理配置（`UAL_ProxyDiagnostics.cpp:167`）。

插件放进工程后即自主运行：`StartupModule` 无条件调用 `Init("ws://127.0.0.1:17860")`（`Core/UnrealAgentLink.cpp:86-97`），连上的瞬间就推 `project.info`，无握手、无 token、无鉴权。

> 想换端口：编辑器侧 `-UALServer=ws://127.0.0.1:17861`，本插件侧改 `port` 配置。

---

## 安装

三件事：把 UnrealAgentLink C++ 插件放进 UE 工程、把这个插件装进 DSH、打开编辑器。就这样 —— **不需要 UEBox、不需要 token、不需要握手**。

### 第 1 步 —— 把 UnrealAgentLink 装进 UE 工程

1. 把整个 `UnrealAgentLink` 目录复制到工程的 `Plugins/`（要全局安装就放进引擎的 `Plugins/`）。
2. 重新生成工程文件，然后打开工程。
3. 确认 UnrealAgentLink 在 **Edit → Plugins** 里已启用。它会自动带入两个引擎自带依赖：`IKRig` 与 `PythonScriptPlugin`。

此后编辑器就自己往外连：`StartupModule` 无条件调用 `Init("ws://127.0.0.1:17860")`，每 5 秒重试一次，所以**启动顺序无所谓**。

> 端口被占（比如被 UEBox）？给编辑器换个端口，本插件侧同步改：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### 第 2 步 —— 把这个插件装进 DSH

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck（src + tests）+ 189 个测试 + catalog 对账，一条命令
```

`npm run check` 必须全绿再往下走 —— 它校验源码与测试的类型检查、行为测试，以及 170 条命令目录与 C++ 注册表逐条对账。

然后注册为 DSH bundle。`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，该文件只做一件事：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **配置分层**：后一层会**整体替换**该行的 `config`，而不是深合并。要覆盖任何键，必须把想保留的键全部重写一遍。

DSH 没有提供安装本地、仓库外插件的命令，所以本仓库自带一个安装脚本，把事情做完后把最后一步交还给真正的安装器：

```bash
npm run status:dsh -- --profile web     # 现在注册了什么（同一个脚本，走 npm 透传）
node scripts/install-dsh-plugin.mjs --profile web             # 镜像、改 manifest、安装、验证
```

它拒绝去动正在运行的 DSH 还持锁的 manifest，并且在回报成功之前先证明层已组装完成：`dsh --profile <profile> --dump-config` 必须包含 `# == dsh-unreal-agentlink`；只有 `desktop` 例外 —— CLI 不会合成该 profile，那里改用 `dsh plugin --profile desktop list` 证明，它读的是同一份包依赖图。声明的 peer 范围同时覆盖本插件构建所依据的版本，以及当前 dsh 出厂的 `0.2.x` 系列，所以 peer-dependency 版本闸门不会拦下正常安装；只有将来的运行时落在这些范围之外时，dsh 才会打印接受风险的确切命令 —— **那个决定是你的，不是脚本的**。

另有两条路，都写全了：下面的[手动安装](#手动安装不用脚本)，以及 [INSTALL-ai.md](../zh/INSTALL-ai.md) —— 一份 AI agent 可以阅读并逐步执行的版本。

### 第 3 步 —— 打开工程并验证

打开 UE 工程，然后让 agent 调 `ual_status`，看三个字段：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → 插件没起来，或端口被占。去 DSH 日志里找 `EADDRINUSE`。
- `listening: true` 但 `editors: []` → 桥在等。确认 UE 工程已打开、UnrealAgentLink 已启用。

编辑器连上后的**最初一瞬间**，它的记录只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`；`project` 这类字段要等编辑器推 `project.info` 才出现。这是正常状态，不是错误。

然后做一次纯读、无副作用的调用：

```
ual_call { method: "level.get_current" }
```

**完整走法 —— 工作流、怎么读失败、故障排查 —— 见[教程](../zh/01-tutorial.md)。**

### 手动安装（不用脚本）

上面的脚本只是方便；底层机制是四行 manifest 加一条产品命令。这里 `<profile>` 是 `web` —— `desktop` 也可以，只需做本节末尾提到的那一处替换 —— `$DSH_HOME` 默认是 `~/.dsh`：

```bash
# 1. 构建一次，然后只复制 npm pack 会发布的内容
npm run build
cp -r lib cordis.patch.yml package.json LICENSE README.md \
      "$DSH_HOME/profiles/<profile>/.vendor/"

# 2. 注册依赖与 bundle 层（两者都要）
"$DSH_HOME/profiles/<profile>/package.json"    # 加入下面两条

# 3. 让真正的安装器跑一遍
dsh plugin --profile <profile> install

# 4. 证明层已组装
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

两条，都在 `<profile>/package.json` 里：

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

两条都是必须的，而且失败方式不同：列了却没声明 `dsh.bundle` 的包会在启动时**大声失败**；装好却没列进清单的包**根本不贡献层**，`--dump-config` 里什么都看不到。

**为什么 `file:` 指向副本而不是工作区**：pnpm 在安装时复制它当时看到的内容，所以一个保存了一半的源文件 —— 或一次失败构建后被删掉的 `lib/` —— 就成了 DSH 实际加载的插件。先镜像，后安装。

**`desktop` profile 是受支持的安装目标，只有一处 CLI 缺口。** `dsh --profile desktop …` 会被直接拒绝（`bin.js:112`，`rejectElectronProfile`），因为 Electron 应用掌管该 profile 的生命周期 —— 但对 `dsh plugin` 这道守卫是有意跳过的（`bin.js:119`），应用自己调用的 Desktop 随附 CLI 正依赖这一点（`dsh-desktop-host/lib/cli.js:91-104` 传入 `manageDesktopProfile: true`）。所以按上面的步骤装进 `desktop`，只需改两处：第 4 步换成 `dsh plugin --profile desktop list`，并且必须先把应用完全退出。产品自己的提示写得很清楚 —— *「先打开一次 DeepSeek Harness Desktop 初始化其 profile，然后在运行 `dsh plugin --profile desktop` 之前把它完全退出」* —— 因为运行中的应用会用内存里的插件清单重写 manifest，在它底下做的修改可能丢失。装完后再启动 Desktop 即可挂载该层。

---

## 文档

| 文档 | 内容 |
|---|---|
| [教程](../zh/01-tutorial.md) | 端到端上手：装插件、跑通、常用工作流、故障排查 |
| [协议参考](../zh/02-protocol.md) | 报文结构、事件、13 个状态码、序列化规则、超时与并发语义 |
| [架构](../zh/03-architecture.md) | 门链、会话隔离与撤销、错误翻译、验证策略、踩过的坑 |
| [命令参考](../zh/command-reference.md) | 170 条命令的参数/必填/结果键/状态码（**自动生成**） |
| [安装指南（AI 可读）](../zh/INSTALL-ai.md) | 写给 AI agent 阅读并执行的安装流程，含前后必须做的校验 |

以上五份在每种语言下都有对应版本（`docs/<lang>/`）。

---

## 四个必须先建立的事实

这四条不是设计取舍，是 UnrealAgentLink 的既有约束，它们决定了所有操作的写法。

1. **方向是反的。** 本插件不去连编辑器 —— 是**编辑器主动连出来**。启动顺序无所谓：编辑器先开就每 5 秒重试一轮，直到插件出现。
2. **没有鉴权。** 无 token、无 header、无子协议。**端口就是凭证**，所以默认只绑 loopback。不要改成 `0.0.0.0`。
3. **命令在游戏线程上串行执行。** 而且阻塞命令运行期间**编辑器什么都不回** —— 连 `sequence.render_status` 这种进度查询也不回。
4. **没有取消。** `query_task` 与 `cancel_task` 不存在。杀掉 `ual_task` 作业只停本插件的等待，引擎照跑，结果依然会回来。

---

## 12 个工具

170 条命令如果各做一个工具，170 份 schema 会吃掉每次请求的 prompt，而绝大多数请求用不到其中任何一个。所以发现能力是两步：

| 工具 | 用途 |
|---|---|
| `ual_status` | 编辑器连接 / 熔断 / 限流 / 会话 / 孤儿命令。**出问题时先读这个** |
| `ual_tools` | 列出全部 170 条命令（22 个族），可按族或关键词过滤 |
| `ual_schema` | 单条命令的**精确键名** —— 调用前必看，UE 对未知键是静默忽略的 |
| `ual_call` | 执行一条命令，原样返回编辑器结果 |
| `ual_batch` | 一个往返执行多条（上限 `maxBatchCalls`；有一项危险则整批走审批） |
| `ual_screenshot` | 截图并返回**真实图片**，agent 能直接看到 |
| `ual_logs` | 读本地日志环（UE 侧转发默认关闭，见教程） |
| `ual_undo` / `ual_undo_history` | 会话级撤销 / 查看撤销缓冲区 |
| `ual_locks` | 声明资产锁，编辑器会画「AI 正在编辑」角标 |
| `ual_editor_bind` | 多个编辑器连着时，把会话固定到某一个 |
| `ual_task` | 把长的阻塞命令转成真实后台作业，对话可继续 |

### 风险分级

read 65 / write 89 / **destructive 2 / dangerous 14**（后 16 类走审批）。

`tools/pre-execute` 对 destructive 与 dangerous 方法（含 `ual_batch` 中任一危险项）返回 `{kind:'ask'}`，把决定权留给会话策略。**未注册的方法直接 `deny`**，不会转发进编辑器。

注意：`never` 策略下 `ask` 会被自动拒绝 —— 这正是「无人值守不得动编辑器」的正确读法。

---

## 配置

默认值是「活着但惰性」。完整表与理由见 [教程第 7 节](../zh/01-tutorial.md#7-配置)。

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | 保持 loopback：没有鉴权，够到端口 = 能驱动编辑器 |
| `timeoutMs` | `180000` | 阻塞类命令各自抬高下限 |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | 会话读缓存 |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | 每秒命令数 / 排队上限（0 关闭限流） |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | 连续传输失败开闸 / 冷却 |
| `logCapacity` / `logMinLevel` | `512` / `Display` | 日志环 |
| `logForwardingEnabled` | `false` | 只在编辑器内开过 `ual.ForwardLogs` 后置 `true` |
| `rollbackOnDispose` | `false` | 只有 LIFO 后缀才精确，见架构文档 |
| `notifyOnEditorChange` | `true` | 编辑器上下线时向 agent 注入一行说明 |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | 截图转图片块 / 体积上限 |
| `maxBatchCalls` | `12` | 单次 `ual_batch` 上限 |

---

## 开发

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + 测试 + catalog 对账（提交前跑这个）
npm test            # 仅测试
npm run typecheck   # src 与 tests 分别类型检查
```

### 源码结构

```
src/
  index.ts                  Cordis 生命周期、审批门、销毁时回滚
  config.ts                 Schemastery schema（默认值的唯一来源）
  service.ts                call() 门链：catalog → requires → 读缓存 → 熔断 → 限流 → 发送 → ledger → 翻译
  protocol/{bridge,serialization,types}.ts   WS 服务端 / 出站校验 / wire 类型
  catalog/{method-data,method-overrides,methods}.ts   170 命令目录（数据从 C++ 提取）
  errors/translate.ts       错误分类（按类名/状态码，不读文案）
  resilience/breaker.ts     限流 + 熔断
  sessions/state.ts         会话 ledger / LIFO 判定 / 锁合并 / 缓存 / 日志过滤
  tools/                    12 个工具
scripts/                    catalog 提取与对账、文档生成与规范化、语言集、DSH profile 安装脚本
docs/                       教程 / 协议 / 架构 / 命令参考 / 安装指南，共 9 种语言
tests/                      189 个测试
```

### 生成物：不要手改

`src/catalog/method-data.ts` 与 `docs/<lang>/command-reference.md` 都是**生成物**：

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # 从 C++ 重建目录
npm run build && node scripts/gen-docs.mjs                             # 重建命令参考（全部 9 种语言）
```

手维护的表建好了却没人 import，是本项目反复出现的缺陷类型（`REQUIRED_KEYS`、`EXTRA_PARAM_KEYS`、`UAL_CODES` 都中过）。对策是让检查**去问源头**，而不是问表自己 —— 详见[架构第 9 节](../zh/03-architecture.md#9-生成物与没人-import-的表)。

### 测试与校验

```bash
npm run check                       # typecheck（src + tests）+ 189 passed + catalog + 文档对账
npm test                            # 189 passed
node scripts/check-catalog.mjs      # 170/170 零漂移；每个 requires 键都在 C++ 里出现；码集与 C++ 一致
node scripts/gen-docs.mjs --check   # 9 种语言的命令参考是否为最新
node scripts/normalize-doc-headers.mjs --check   # 54 份文档的语言栏是否都是规范形
node scripts/normalize-doc-links.mjs --check     # 正文链接是否从所在位置能解析
npm run docs                        # 重新生成 + 重写 54 份文档的语言栏与链接
npm run install:dsh -- --profile web    # 把本插件注册进一个 dsh profile（见「安装」）
```

10 个测试文件按**它们能发现的缺陷类型**划分，各有理由 —— 见[架构第 11 节](../zh/03-architecture.md#11-验证策略)。

`requires` 不是手写的：从 handler 自身的 `SendError(..., 400, "Missing field: X")` 消息推导（28 处），因为写错一个键会让桥在引擎看到之前就拒掉一个合法调用。推导结果落在 `method-data.ts` 的 `REQUIRED_KEYS`，由 `methods.ts` 的 `requiresOf()` 合并进运行时（`service.call()` 的前置拒绝、`ual_schema` 的 `REQUIRED:` 行、错误提示都走这一个函数）。

刻意**只收窄不放大**：消息里带 `or`（`"Missing field: name or path"`）整条跳过；从同文件被调函数里挖出来的键按分支局部处理丢弃 —— 见 `scripts/extract-methods.mjs` 的 `REQUIRED_DROPPED`，每个条目都写了 C++ 行号。所以「一个键都没收」是安全的默认，不是漏检。

### 没有 Unreal Engine 也能测试

跑本插件不需要编辑器，也不需要 UEBox —— 接缝就是协议本身：UEBox 是**往外**拨号连到本桥的，所以一个假编辑器就是一个会应答的 WebSocket 客户端。

```bash
npm run smoke                        # 启动真实服务、接入一个假编辑器，
                                     # 调用全部 12 个工具、校验每个结果
npm run smoke -- --out /tmp/ual      # 把运行记录与 PNG 存到别处
npm run smoke -- --method actor.get  # 只跑一个目录方法，原样打印
npm run mock:ue                      # 只要那个假编辑器，方便手动试探
```

`tools/mock-ue-editor.mjs` 是一个真实进程，不是桩：它拨号连 `ws://127.0.0.1:17860`，推送 `project.info` 与 `system.heartbeat`，转发 `log.entry` 行，为 `editor.screenshot` 写出真正的 PNG，并应答**全部 170 个已编目方法** —— 对重要的几个方法族给出有真实感的响应体，其余给出带文档所述结果键的响应体。`tools/ual-smoke.mjs` 启动的是 `apply()` 启动的同一个 `UalService`，通过各工具真正的 `execute` 调用每个工具，用该工具自己的输出 schema 校验每个值，并打印模型本会看到的内容。它是 `tests/mock-editor.test.ts` 的手动孪生；两者都在[架构第 11 节](../zh/03-architecture.md#11-验证策略)里描述。

---

## 协议要点

```
UE → 插件:  { ver:"1.0", type:"req",  method, id, params }     // id 由服务端生成
插件 → UE:  { ver:"1.0", type:"res",  id, code, result }        // result 为空时整键省略
UE → 插件:  { ver,       type:"evt", method, payload }
```

- 失败**只由 `code` 表达**，报文里没有 envelope 级 `error` 字段。
- 错误文本在 `result.message`（按编辑器文化分中英文，**不要解析**），机器可读信息在 `result.details`。
- **许多 handler 返回 `200` 但 `result.ok === false`**（`editor.undo`、`blueprint.compile`、`pie.observe`），所以插件用 `judge()` 判成败，不只看 code。C++ 里有 55 处 `SetStringField(TEXT("error"), ...)`，分布 14 个文件 —— 这是常态而非异常。
- `content.import_folder` / `content.import_assets` 是**即发即弃**的外发推送：不带 `id`、不等待回复。插件把事件转成日志与 agent 通知，**不回一个假 `res`** —— 回 `ok:false` 只会让用户看到虚假的「导入失败」对话框，比沉默更糟。

完整细节（13 个状态码、序列化规则、超时语义）见[协议参考](../zh/02-protocol.md)。

---

## License

MIT

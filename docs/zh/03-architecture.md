<div align="center">

[English](../03-architecture.md) · **简体中文** · [繁體中文](../zh-TW/03-architecture.md) · [日本語](../ja/03-architecture.md) · [한국어](../ko/03-architecture.md) · [Deutsch](../de/03-architecture.md) · [Español](../es/03-architecture.md) · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_zh.md) · [教程](01-tutorial.md) · [协议](02-protocol.md) · **架构** · [命令参考](command-reference.md)

</div>
# 架构

本插件是一个**纯桥接**：它不规划任务、不决定做什么，只把 DSH 原生 agent 的意图翻译成 UnrealAgentLink 命令，并把编辑器的回答翻译回 agent 能用的形状。任务规划属于 DSH 的 agent，不属于这里。

这一节讲清楚代码为什么长成这样。

---

## 1. 模块图

```
src/
  index.ts          Cordis 生命周期、审批门、会话销毁
  config.ts         Schemastery schema（默认值的唯一来源）
  service.ts        call() 门链 —— 所有命令的唯一入口
  protocol/
    bridge.ts       WebSocket 服务端：连接、队列、超时、孤儿、日志环
    serialization.ts  出站参数校验（比 JSON.stringify 严格）
    types.ts        wire 类型与 UAL_CODES
  catalog/
    method-data.ts      从 C++ 提取的 5 张表（生成物，勿手改）
    method-overrides.ts 提取器跟不到的地方，人工补齐
    methods.ts          170 条命令的风险分级与说明 + 查询函数
  errors/translate.ts   错误分类（按类名/状态码，不读文案）
  resilience/breaker.ts 限流 + 熔断
  sessions/state.ts     会话 ledger、LIFO 判定、锁合并、缓存、日志过滤
  tools/                12 个工具
scripts/
  extract-methods.mjs   从 C++ 提取目录（生成 method-data.ts）
  check-catalog.mjs     双向对账目录与 C++ 注册表
  gen-docs.mjs          为全部 9 种语言渲染 docs/<lang>/command-reference.md
  languages.mjs         语言集 —— 生成器与文档测试共用
  normalize-doc-headers.mjs  按语言集重写语言栏与文档导航行
  normalize-doc-links.mjs    重写正文链接，使其从所在文件位置能解析
  install-dsh-plugin.mjs     把本插件注册进一个 dsh profile（镜像、manifest、安装、验证）
docs/                   教程 / 协议 / 架构 / 命令参考 / 安装指南，共 9 种语言
tests/                  173 个测试，9 个文件
```

### 依赖方向

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

没有反向依赖。`tools/` 只依赖 `service`，`service` 不依赖任何工具。

---

## 2. 门链：`service.call()`

**所有**命令都走这一个入口（`src/service.ts:190-332`），顺序固定：

```
1. catalog 门     方法不在目录里 → 直接拒绝，永不转发
2. requires 门    缺必填键 → 直接拒绝，永不转发
3. 读缓存         只读 + 可缓存 + 非 long → 命中则返回，不碰 socket
4. 熔断           acquire() 开闸则抛 / admit() 只放一个半开探测
5. 限流           队列满则抛
6. 发送           bridge.send() → 编辑器
7. judge()        200/207 + result.ok/error 判成败
8. ledger         仅"变更类且成功"才记入会话撤销栈
9. 翻译           失败时按类名/状态码分类
   finally        熔断器 release()
```

前两步的价值在于**在引擎看到之前就拒绝**。UE 对未知键是静默忽略的，所以一个拼错的键名会让调用「成功」地什么都不做 —— 那比报错难查得多。

`call()` **从不抛异常**。所有失败都以 `CallOutcome.value` 里的 `ok: false` 返回。这是刻意的：工具层的每个分支都要能渲染一个结构化结果，而不是各自 try/catch。

### 为什么前两步必须是"目录"而不是"风险表"

`riskOf()` 对**未知**方法返回 `'dangerous'`（保守默认）。早期版本用它反推「方法是否存在」，结果：

- 误拒 5 个真实存在的危险方法（`level.new`、`level.open`、`level.save`、`content.migrate`、`blueprint.import_t3d`）
- 同时放行任何伪造的 `editor.*` 名字

现在问的是 `isKnown()`（查目录），而不是 `riskOf()`。**存在性是目录问题，不是风险问题。**

---

## 3. 会话隔离与撤销

### 问题

UnrealAgentLink 为**每个编辑器维护一条 agent 撤销栈**，被所有 DSH 会话共享。DSH 侧可能有多个会话同时驱动同一个编辑器。

所以「撤销我这个会话做的事」不是一个协议支持的操作。

### 做法

`src/sessions/state.ts` 为每个会话记录它做过的每一步，并给每一步一个**全局递增序号**（`global`）。回滚前检查：本会话的步骤是否构成该编辑器缓冲区的**干净 LIFO 后缀** —— 即本会话最后一步的全局序号，晚于其他所有会话的最后一步。

```
是  → 回滚，只撤本会话的步数
否  → 什么都不撤，把两份步骤列表都报出来
```

宁可拒绝，也不默默撤掉别人的工作。

### `rollbackOnDispose` 默认 false

会话销毁时自动回滚听起来方便，但**用户没有要求过**。默认关闭；打开它的用户是在明确表达「会话结束就撤销」。

---

## 4. 错误翻译：为什么不读文案

错误文本随编辑器文化切中英文（`result.message`）。解析它等于把插件绑死在一种语言上，而且文案随时可能改。

`src/errors/translate.ts` 只按**错误类名**（`NoEditorError`、`BridgeTimeoutError`、…）与**状态码**分类，共 16 种 kind，然后为每种给出下一步该做什么的建议。

分类顺序是：先类名，再状态码。状态码里 `410` 按 `not-found`、`422` 按 `precondition`、`504` 按 `timeout` —— 这些都不是显而易见的映射，所以由 `scripts/check-catalog.mjs` 的第 4 项检查回查 C++ 源码保证覆盖完整。

**为什么漏分类有害**：兜底的 `engine-error` 提示语是「参数没问题、编辑器自己坏了」。所以一个没被分类的码会把模型往反方向带。典型例子是 `422` —— 它的真实含义是「输入合法但一件都没写进去」，与「编辑器坏了」完全不同。

---

## 5. 熔断与限流

### 熔断保护的是编辑器

`src/resilience/breaker.ts`。关键决策：**4xx 记作 `input`，不触发熔断。**

理由：agent 连打十个坏调用是在**工作**，不是在杀死编辑器。只有连续**传输**失败才说明编辑器真的有问题。

### 限流修过一个真实 bug

滑动窗口限流器原本让**第一个排队者立即放行** —— 突发第二个调用瞬间通过，限流形同虚设。修法见 `breaker.ts:schedule()`：首个释放要等满剩余间隔，而不是立即触发。

---

## 6. 日志环

编辑器推送 `log.entry`（需编辑器内 `ual.ForwardLogs 1`，本插件无法远程开启）。

`bridge.ts` 维护一个容量 512 的环：按最低级别过滤（默认 `Display`）、按 severity 排序、支持 `sinceSeq` 分页、category/text 不区分大小写过滤。

**为什么在本地做**：直接把每条日志转给模型会淹没上下文。环 + 过滤让 agent 按需取，而不是被动收。

---

## 7. 长任务：`ual_task`

协议**没有取消语义**。`ual_task` 把长调用包成真实的 DSH job（kind `ual`），让对话可以继续。

两件事必须写进工具描述，否则模型一定会误解：

1. **杀作业只停本插件的等待**，引擎侧照跑，结果依然会回来。
2. **阻塞命令运行期间编辑器什么都不回** —— 连 `sequence.render_status` 也不回。所以不要在长任务运行时轮询。

---

## 8. 工具面：12 个，不是 170 个

170 条命令如果各做一个工具，170 份 schema 会吃掉每次请求的 prompt —— 而绝大多数请求用不到其中任何一个。

所以：

- `ual_tools` 列出能力（可按族/关键词过滤）
- `ual_schema` 给出单条命令的精确键名
- `ual_call` 执行

**发现能力是两步，不是零步。** 这是刻意的取舍：多一次往返，换每次请求省下 170 份 schema。

---

## 9. 生成物与"没人 import 的表"

本项目反复出现同一类缺陷，值得单独记下来：**手维护的表建好了，但没人 import 它。**

已发生的实例：

| 表 | 症状 |
|---|---|
| `REQUIRED_KEYS` | 必填校验是死代码，`ual_schema` 从不显示 `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | 4 个 `PARAMS_UNRESOLVED` 方法参数列表为空 |
| `UAL_CODES` | `410`/`422`/`504` 未被分类，落回误导性的 `engine-error` |

共同点：表本身正确、有文档、经过 review，但运行时读的是另一条路径。

对策是让**检查去问源头**，而不是问表自己：

- `check-catalog.mjs` 第 3 项：每个 `requires` 键必须是 C++ 源码里出现过的字面量
- `check-catalog.mjs` 第 4 项：`UAL_CODES` 必须与 C++ 实际发出的码集合一致（含共享闸门与 `Code = bOk ? 200 : 207` 这类表达式形式）
- `gen-docs.mjs --check`：命令参考文档必须与目录一致

这些都是**非自证**的检查：改坏源头或改坏表，两边都会失败。

---

## 10. 类型安全的两个真实坑

### `undefined` 属性会炸

dsh-tools 在派发工具结果时跑**两段**流水线：

1. `snapshotJsonValue(value)` —— 有**任何**值为 `undefined` 的自有属性就抛 `value is not lossless JSON`
2. `validateJsonSchemaValue(schema, value)` —— 校验 schema

第一段比 schema 更严格，且**先跑**。所以只测 schema 的测试测不出这类 bug。

真实症状：编辑器**刚连上、还没推 `project.info`** 时，`ual_status` 的编辑器记录里有 `project: undefined` 等键 —— 于是「最该先读的工具」在编辑器出现的那一刻直接抛错。

修法是条件展开，而不是写 `undefined`：

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### 输出 schema 必须声明每一个键

工具的输出 schema 用 `additionalProperties: false`，注册表会**逐键**校验。所以 `ual_screenshot` 返回的 `attachment` 必须在 schema 里声明 —— 否则**截图成功的那一刻**抛 `ToolOutputError`，而文本路径反而正常。

schema 语言里没有 `ImageAttachmentRef` 节点，只能声明成 `{ type: 'json' }`。这会把推断出的类型放宽到 `JsonValue`，所以渲染时要用一个**运行时守卫**把它收窄回来，而不是用 `as` 断言：

```ts
const attachment = imageRef(record.attachment)   // 逐字段校验
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

编译器会拒绝单纯的 `as`（TS2352：两个类型没有充分重叠）—— 那是它在要求一个运行时检查，不是在刁难。

---

## 11. 验证策略

```bash
npm run check
```

等价于：

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests（src 的 tsconfig 不含 tests）
vitest run                         # 173 个测试
node scripts/check-catalog.mjs     # 4 项对账
node scripts/gen-docs.mjs --check  # 9 种语言的命令参考是否为最新
node scripts/normalize-doc-headers.mjs --check   # 54 份文档的语言栏是否都是规范形
node scripts/normalize-doc-links.mjs --check     # 正文链接是否从所在位置能解析
npm run install:dsh -- --profile web    # 把本插件注册进一个 dsh profile
```

测试分 9 个文件，按**它们能发现的缺陷类型**划分：

| 文件 | 覆盖 |
|---|---|
| `protocol.test.ts` | `judge()` 契约、序列化规则 |
| `translate.test.ts` | 16 种 kind 的分类与提示 |
| `resilience.test.ts` | 熔断状态机、限流排队、`notifierFor` |
| `catalog.test.ts` | 目录查询、原型链防护、审批门端到端 |
| `bridge.test.ts` | 真实 WebSocket：队列、超时孤儿、事件、关闭 |
| `tool-output.test.ts` | 每个工具的真实返回值过两段流水线 |
| `i18n.test.ts` | 9 种语言下文档都完整且内部自洽 |
| `end-to-end.test.ts` | 真实门链 + 真实 socket + 工具 schema |
| `installer.test.ts` | DSH profile 安装器：参数处理、两条 manifest 条目、镜像边界、拒绝持锁 |

**为什么要有 `end-to-end.test.ts`**：其他测试各自 stub 掉一层。而 `REQUIRED_KEYS` 那个 bug —— 生成、文档化、review 过、从未被 import —— 没有任何单元测试发现它，因为每一层单独看都自洽。只有把真实门链接上真实 socket，再喂给真实 schema，才能发现「这一层和那一层之间的缝」。

同理，`tool-output.test.ts` 用**真实**的 `snapshotJsonValue` + `validateJsonSchemaValue`，而不是自己写一个 schema 检查 —— 否则 `ual_status` 的 `undefined` 缺陷照样漏掉。

`installer.test.ts` 因第三个理由存在：安装器是这里唯一会写到**本仓库之外**的脚本，所以它一旦坏了，套件里没有任何其他东西会注意到。它用一个临时 profile 目录（`--profile-dir`）跑真实脚本，配一个会打印层标记的 `dsh` 桩 —— 也就是整个安装器减去它最后交还给产品的那一步。它钉住的正是单元测试里看不见的那些事：bundle 需要**同时**有依赖条目和 `dsh.profile.bundles` 条目，而且两者失败方式不同（列了却不是 bundle 会在启动时大声失败；装好却没列出则完全不贡献层）；manifest 会保留用户已有的每一个键；第二次运行什么都不会改；镜像只复制 `npm pack` 会发布的内容，所以 `.audit-tmp/` 不可能变成 dsh 加载的插件；持锁的 manifest 是被拒绝而不是被强夺。desktop 拒绝也被钉住，因为 `bin.js:38` 意味着一个自称能装的安装器只会写出一份操作员无法激活的 manifest。

`i18n.test.ts` 出于同样的理由，针对的是另一道缝。`src/` 底下的一切对 `docs/` 一无所知，所以现有测试无法发现某份翻译在语言栏里漏了一种语言、或指向了它自己改过名的标题。它改成把文档当资料读：每种语言都有那五个文件，每一栏都列出全部九种语言且只把自己的那份加粗，每一个相对链接都能解析到真实文件，每一个 `#anchor` 都能解析到真实标题。最后一项才是有趣的那项 —— 锚点是从*译文*标题文字推导出来的，所以翻译者一旦改写「Verification strategy」，指向该节的每一个链接都会静默失效，而任何地方都不会报错。`gen-docs.mjs --check` 以同样方式守着生成出来的命令参考；`i18n.test.ts` 是调用它，而不是重新实现一遍渲染。

它还抓到了测试自身的缺陷，那个更有教育意义。AI 可读的安装指南写成时先落地英文与简体中文，其余七份翻译后来才到，而整个窗口期套件一直是绿的。该指南不在 `FILES` 里，而 stray-file 测试不只是允许它 —— 它对它**毫无要求**。一次许可被当成了要求，而那个测试的全部职责就是发现缺失的文件。`SHARED_DOCS` 现在加入了其他列表，于是一份共用文档一旦被声明，就会立即被检查存在性、语言栏和链接；两个规范化脚本的 `TOPIC_DOCS` 也加了同一条目，因为语言栏生成器和 stray-file 测试必须对「存在什么」达成一致，否则两者都不可信。

测试还抓到了促成两个规范化脚本的那两类机械缺陷。翻译者按英文原文读起来对的方式写链接，于是 `docs/readme/README_zh.md` 链的是 `zh/01-tutorial.md` —— 它解析到并不存在的 `docs/readme/zh/…` —— 而根 README 有镜像版的 `../docs/01-tutorial.md`。同类漂移也击中了头部语言栏：德文主题文档链的是自己的语言而不是加粗它，而安装指南的翻译要么完全没有语言栏、要么 `../../README.md` 深度是错的。因此语言栏与链接都由 `normalize-doc-headers.mjs` 与 `normalize-doc-links.mjs` 从 `scripts/languages.mjs` 加文件自己的译文标签推导出来，且两者都有 `--check` 模式接进 `npm run check`，手写链接不可能再落地。

---

## 12. 配置

`src/config.ts` 的 Schemastery schema 是**默认值的唯一来源**。`cordis.patch.yml` 里的 `config` 只是复述 schema 已有的默认值。

**注意 DSH 配置分层**：后一层会**整体替换**该行的 `config`，不是深合并。要覆盖任何键，必须把想保留的键全部重写。

`allowDangerous` 这类开关**故意不存在** —— 风险门走的是 DSH 原生的 `tools/pre-execute` 审批缝，而不是插件自己造一个绕过机制。

---

## 13. 可选依赖的降级

`cordis.patch.yml` 里只声明了一个硬依赖：`tools` 注册表（通过 `inject`）。其余全部经 `ctx.get` 读取：

| 服务 | 缺失时 |
|---|---|
| `jobs` | `ual_task` 返回 `kind:'background'` 并说明不可用 |
| `fs` / `attachments` | 截图退化为文本路径 + 原因 |
| `agents` | 编辑器上下线不通知 agent |
| `approval` | `ask` 被 DSH 转为拒绝 |

这样一份省略了某个服务的 composition 只会**少一个功能**，而不是加载失败。

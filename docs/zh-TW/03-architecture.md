<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · **繁體中文** · [日本語](../ja/03-architecture.md) · [한국어](../ko/03-architecture.md) · [Deutsch](../de/03-architecture.md) · [Español](../es/03-architecture.md) · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_zh-TW.md) · [教學](01-tutorial.md) · [協議](02-protocol.md) · **架構** · [命令參考](command-reference.md)

</div>

# 架構

本外掛是**純橋接**：它不規劃任務，也不決定要做什麼。它把 DSH agent 的意圖翻譯成 UnrealAgentLink 命令，再把編輯器的答案翻譯回 agent 能用的形狀。規劃屬於 DSH 的 agent，不屬於這裡。

本節說明程式碼為什麼長成這樣。

---

## 1. 模組一覽

```
src/
  index.ts          Cordis lifecycle, approval gate, dispose-time rollback
  config.ts         Schemastery schema (the single source of default values)
  service.ts        call() gate chain — the one entry point for every command
  protocol/
    bridge.ts       WebSocket server: connections, queues, timeouts, orphans, log ring
    serialization.ts  outbound parameter validation (stricter than JSON.stringify)
    types.ts        wire types and UAL_CODES
  catalog/
    method-data.ts      five tables extracted from C++ (generated, do not hand-edit)
    method-overrides.ts  manual patches where the extractor cannot reach
    methods.ts          170 commands with risk tier and summary + query functions
  errors/translate.ts   error classification (by class name / status code, not by text)
  resilience/breaker.ts rate limiter + circuit breaker
  sessions/state.ts     session ledger, LIFO test, lock merging, cache, log filtering
  tools/                the 12 tools
scripts/
  extract-methods.mjs   extracts the catalog from the C++ (generates method-data.ts)
  check-catalog.mjs     reconciles catalog against the C++ registry, both directions
  gen-docs.mjs          renders docs/<lang>/command-reference.md for all 9 languages
  languages.mjs         the language set — shared by the generator and the docs tests
docs/                   tutorial / protocol / architecture / command reference / install guide, ×9 languages
tests/                  173 tests in 9 files
```

### 依賴方向

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

不存在反向依賴。`tools/` 只依賴 `service`，而 `service` 不依賴任何 tool。

---

## 2. 閘門鏈：`service.call()`

**每一條**命令都走這一個入口（`src/service.ts:190-332`），順序固定：

```
1. catalog gate    the method is not in the catalog → refuse, never forward
2. requires gate   a required key is missing → refuse, never forward
3. read cache      read-only + cacheable + not long → return, never touch the socket
4. breaker         acquire() throws when open / admit() lets exactly one half-open probe
5. rate limit      throws when the queue is full
6. send            bridge.send() → the editor
7. judge()         200/207 plus result.ok/error decides success
8. ledger          recorded only when the call both mutates and succeeds
9. translate       on failure, classify by class name / status code
   finally         breaker.release()
```

前兩步的價值在於：**在引擎看到這個呼叫之前就拒絕它**。UE 對未知鍵是靜默忽略的，所以鍵名拼錯會讓呼叫「成功」地什麼都沒做 —— 這比報錯難查得多。

`call()` **永遠不拋例外**。所有失敗都以 `ok: false` 的形式落在 `CallOutcome.value` 裡。這是刻意的：tool 層的每個分支都需要渲染一份結構化結果，而不是各自寫 try/catch。

### 前兩步為什麼必須是「目錄」而不是「風險表」

`riskOf()` 對**未知**方法會回傳 `'dangerous'`（保守預設）。早期版本用它來推斷「這個方法是否存在」，結果：

- 誤拒了 5 個確實存在的方法（`level.new`、`level.open`、`level.save`、`content.migrate`、`blueprint.import_t3d`）
- 同時放行任何憑空編造的 `editor.*` 名稱

現在的判斷是 `isKnown()`（查目錄），而不是 `riskOf()`。**存在與否是目錄問題，不是風險問題。**

---

## 3. 工作階段隔離與復原

### 問題

UnrealAgentLink 為每個編輯器維護**一條 agent 復原堆疊**，由所有 DSH 工作階段共用。而在 DSH 這一側，多個工作階段可能同時驅動同一個編輯器。

所以「復原本工作階段做過的事」不是協議支援的操作。

### 做法

`src/sessions/state.ts` 記錄每個工作階段做過的每一步，並給每一步一個**全域遞增的編號**（`global`）。復原前先檢查本工作階段的步驟是否構成該編輯器緩衝區的**乾淨 LIFO 後綴** —— 也就是本工作階段的最後一步，是否晚於其他每個工作階段的最後一步。

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

寧可拒絕，也不要默默丟掉別人的工作。

### `rollbackOnDispose` 預設為 false

工作階段銷毀時自動復原聽起來方便，但**使用者從沒要求過**。它預設關閉；打開它等於明確宣告「工作階段結束就該復原它的工作」。

---

## 4. 錯誤翻譯：為什麼不讀文字

錯誤文字會隨編輯器文化切換中英文（`result.message`）。解析它會把外掛綁死在一種語言上，而這段文字隨時可能改。

`src/errors/translate.ts` 只按**錯誤類別名稱**（`NoEditorError`、`BridgeTimeoutError` 等）與**狀態碼**分類，分成 16 種 kind，並為每一種給出下一步該做什麼的建議。

順序是：先類別名稱，再狀態碼。狀態碼中，`410` 對應 `not-found`、`422` 對應 `precondition`、`504` 對應 `timeout` —— 這些對應關係都不顯而易見，這就是 `scripts/check-catalog.mjs` 第 4 項檢查要直接查 C++ 原始碼以確保覆寫完整的原因。

**為什麼漏分類是有害的**：後備的 `engine-error` 的意思是「參數沒問題，是編輯器本身壞了」。所以一個未被分類的狀態碼會把模型引向完全錯誤的方向。最清楚的例子是 `422` —— 它的真正含義是「輸入合法但什麼都沒寫進去」，跟「編輯器壞了」毫不相干。

---

## 5. 斷路器與限流器

### 斷路器保護的是編輯器

`src/resilience/breaker.ts`。關鍵決定：**4xx 記為 `input`，不會讓斷路器跳閘。**

理由：agent 連續打十個錯呼叫，是在**工作**，不是要搞死編輯器。只有反覆出現**傳輸層**失敗，才代表編輯器本身出了問題。

### 限流器修掉了一個真實的 bug

滑動視窗限流器原本會讓**第一個排隊的呼叫立即通過** —— 於是突發中的第二個呼叫也是瞬間通過，限制形同虛設。修法在 `breaker.ts:schedule()`：第一次釋放會等完剩下的間隔，而不是立刻放行。

---

## 6. 日誌環

編輯器推送 `log.entry`（需要在編輯器內開啟 `ual.ForwardLogs 1`，本外掛無法遠端開啟）。

`bridge.ts` 維護一個容量 512 的環：按最低級別過濾（預設 `Display`）、按嚴重度排序、透過 `sinceSeq` 分頁、支援不分大小寫的 category／文字過濾。

**為什麼要在本地做**：把每一行日誌直接轉發給模型會淹沒它的上下文。環狀緩衝加過濾，讓 agent 自己拉取需要的內容，而不是被動接收全部。

---

## 7. 長任務：`ual_task`

協議**沒有取消語義**。`ual_task` 把一個長呼叫包裝成真正的 DSH 作業（kind `ual`），讓對話可以繼續往下走。

有兩件事必須寫進工具描述，否則模型一定會誤解：

1. **殺掉作業只會停掉本外掛這邊的等待。** 引擎照跑，結果依然會回來。
2. **阻塞命令運行期間，編輯器什麼都不回** —— 連 `sequence.render_status` 也不回。所以長任務運行期間不要輪詢。

---

## 8. 工具面：12 個，不是 170 個

如果 170 條命令每條都是一個工具，170 個 schema 會吃掉每次請求的提示詞 —— 而絕大多數請求根本用不到其中任何一個。

因此：

- `ual_tools` 列出能力（可按族或關鍵字過濾）
- `ual_schema` 給出單一命令的準確鍵名
- `ual_call` 負責執行

**探索能力需要兩步，而不是零步。** 這是刻意的取捨：多一次往返，換每次請求少 170 個 schema。

---

## 9. 產生物與「沒人 import 的表」

有一類缺陷在這個專案反覆出現，值得單獨記一筆：**手動維護的表建好了，卻沒有人 import 它。**

目前為止的實例：

| 表格 | 症狀 |
|---|---|
| `REQUIRED_KEYS` | 必填鍵檢查是死碼，`ual_schema` 也從不顯示 `REQUIRED:` |
| `EXTRA_PARAM_KEYS` | 4 個 `PARAMS_UNRESOLVED` 方法的參數清單是空的 |
| `UAL_CODES` | `410`／`422`／`504` 未被分類，落到誤導人的 `engine-error` |

共同點：表本身是正確的、有文件、也經過審視 —— 但執行時讀的是另一條路徑。

對策是讓每項檢查去**問原始碼**，而不是問表：

- `check-catalog.mjs` 第 3 項：每個 `requires` 鍵都必須是在 C++ 原始碼裡實際出現的字面值
- `check-catalog.mjs` 第 4 項：`UAL_CODES` 必須與 C++ 實際送出的狀態碼集合一致（包含共用閘門，以及 `Code = bOk ? 200 : 207` 這類運算式寫法）
- `gen-docs.mjs --check`：命令參考必須與目錄一致
- `i18n.test.ts`：文件必須完整且內部自洽 —— 對翻譯檔而言，這意味著「連結依然有效」，而錨點是從*譯文*標題推導出來的，所以會靜默失效

語言集合是這種形態最新的實例。`gen-docs.mjs` 與 `tests/i18n.test.ts` 都需要知道存在哪些語言，而在各自保留一份副本的時期，新增一種語言意味著手工找出兩處 —— 而產生器寫了、測試卻從不檢查的語言，就是沒人驗證的語言。`scripts/languages.mjs` 現在是單一來源，兩邊都 import 它。

這些都是**不自證**的檢查：弄壞原始碼或弄壞表，任一邊都會失敗。

---

## 10. 兩個真實的型別安全陷阱

### `undefined` 屬性會炸

dsh-tools 在派發工具結果時會跑一條**兩段式**管線：

1. `snapshotJsonValue(value)` —— 只要**任何一個**自有屬性是 `undefined` 就拋出 `value is not lossless JSON`
2. `validateJsonSchemaValue(schema, value)` —— 依 schema 驗證

第一段比 schema 更嚴，而且**先跑**，所以只檢查 schema 的測試抓不到這一類 bug。

實際症狀：編輯器連上後、推來 `project.info` 之前的**那一瞬間**，它的 `ual_status` 記錄裡有 `project: undefined` 這類鍵 —— 於是「你第一個會讀的工具」在編輯器一出現就拋例外。

修法是條件式展開，而不是寫 `undefined`：

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### 輸出 schema 必須宣告每一個鍵

工具的輸出 schema 使用 `additionalProperties: false`，註冊中心會**逐鍵**驗證。所以 `ual_screenshot` 回傳的 `attachment` 必須在 schema 裡宣告 —— 否則它會在**截圖成功的那一刻**拋出 `ToolOutputError`，而純文字路徑完全正常。

schema 語言裡沒有 `ImageAttachmentRef` 節點，所以只能宣告成 `{ type: 'json' }`。這會把推導出的型別放寬到 `JsonValue`，因此渲染路徑必須用**執行期守衛**把它收窄回來，而不是用 `as` 斷言：

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

編譯器在這裡會拒絕單純的 `as`（TS2352: the two types do not sufficiently overlap）—— 那是它在要求執行期檢查，不是故意刁難。

---

## 11. 驗證策略

```bash
npm run check
```

其等價於：

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 173 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
node scripts/gen-docs.mjs --check  # command reference current in 9 languages
node scripts/normalize-doc-headers.mjs --check   # language bars canonical in 54 files
node scripts/normalize-doc-links.mjs --check     # body links resolve from where they sit
npm run install:dsh -- --profile web    # register this plugin with a dsh profile
```

測試分布在 9 個檔案裡，按**它們能發現哪一類缺陷**劃分：

| 檔案 | 覆蓋範圍 |
|---|---|
| `protocol.test.ts` | `judge()` 契約、序列化規則 |
| `translate.test.ts` | 16 種 kind 全部分類與提示 |
| `resilience.test.ts` | 斷路器狀態機、限流排隊、`notifierFor` |
| `catalog.test.ts` | 目錄查詢、原型鏈保護、審批閘門端到端 |
| `bridge.test.ts` | 真實 WebSocket：佇列、逾時孤立、事件、關閉 |
| `tool-output.test.ts` | 每個工具的真實回傳值走完整條兩段式管線 |
| `i18n.test.ts` | 9 種語言下文件都完整且內部自洽 |
| `end-to-end.test.ts` | 真實閘門鏈 + 真實 socket + 真實工具 schema |
| `installer.test.ts` | DSH profile 安裝程式：引數處理、兩筆 manifest 條目、鏡像邊界、拒絕持鎖 |

**為什麼 `end-to-end.test.ts` 必須存在**：其他每個測試都會把某一層打成樁。`REQUIRED_KEYS` 這個 bug —— 有產生、有文件、經過審視、卻從未被 import —— 沒有任何單元測試抓到它，因為每一層孤立地看都是自洽的。只有把真實閘門鏈接到真實 socket 上、再餵給真實 schema，才能暴露**層與層之間的接縫**。

同理，`tool-output.test.ts` 用的是**真的** `snapshotJsonValue` + `validateJsonSchemaValue`，而不是自己寫一套 schema 檢查 —— 否則 `ual_status` 的 `undefined` 缺陷會以同樣的方式溜過去。

`i18n.test.ts` 出於同樣的理由，針對的是另一道接縫。`src/` 底下的一切對 `docs/` 一無所知，所以現有測試無法發現某份翻譯檔在切換列裡漏了一種語言、或指向了一個已被改名的標題。它改成把文件當資料讀：每種語言都有那五個檔案，每一列都列出全部九種語言且只把自己的那份加粗，每一個相對連結都能解析到真實檔案，每一個 `#anchor` 都能解析到真實標題。最後一項才是真正有意思的 —— 錨點是從*譯文*標題文字推導出來的，所以翻譯者一旦改寫「Verification strategy」，指向該節的每一個連結都會靜默失效，而且沒有任何地方會報錯。`gen-docs.mjs --check` 以同樣的方式守著產生出來的命令參考；`i18n.test.ts` 是呼叫它，而不是重新實作一次渲染。

---

## 12. 配置

`src/config.ts` 裡的 Schemastery schema 是**預設值的單一來源**。`cordis.patch.yml` 裡的 `config` 只是把 schema 已有的預設值再說一遍。

**注意 DSH 的配置分層**：後一層會**整體替換**該行的 `config`，而不是深合併。要覆寫任何一個鍵，必須把想保留的鍵全部重寫一遍。

像 `allowDangerous` 這樣的開關**刻意不存在** —— 風險閘門走的是 DSH 原生的 `tools/pre-execute` 審批接縫，而不是由外掛自己發明一個繞道。

---

## 13. 選配依賴缺失時降級

`cordis.patch.yml` 只宣告一項硬依賴：`tools` 註冊中心（透過 `inject`）。其他一切都透過 `ctx.get` 讀取：

| 服務 | 缺失時 |
|---|---|
| `jobs` | `ual_task` 回傳 `kind:'background'` 並說明不可用 |
| `fs` / `attachments` | 截圖降級為文字路徑，並附上原因 |
| `agents` | 編輯器連線／斷線不會通知 agent |
| `approval` | `ask` 會被 DSH 轉成拒絕 |

這樣一來，某種組合少掛一項服務，會**少掉一個功能**，而不是整個載入失敗。

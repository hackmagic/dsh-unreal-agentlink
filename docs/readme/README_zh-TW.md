<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · **繁體中文** · [日本語](README_ja.md) · [한국어](README_ko.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### 一個把 Unreal 編輯器交給 agent 的 DSH 外掛。

**純橋接。agent 負責規劃，本外掛只負責翻譯。**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[系統需求](#系統需求) · [安裝](#安裝) · [12 個工具](#12-個工具) · [配置](#配置) · [文件](#文件) · [不使用指令碼的手動安裝](#不使用指令碼的手動安裝)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

agent 已經會讀檔案、跑命令了。這個外掛把**編輯器本身**也交給它：查詢關卡、生成 actor、編輯藍圖與材質、渲染序列、截取它能真正*看見*的畫面，並在出錯時復原自己的成果。

它**不規劃任務**。任務規劃屬於 DSH 的原生 agent。本外掛是一層帶安全措施的翻譯器 —— 把 agent 的意圖轉成 UnrealAgentLink 命令，再把編輯器的回答轉回 agent 能據以行動的形式。

---

## 安裝

總共三個部分：把 UnrealAgentLink C++ 外掛放進你的 UE 專案、把這個外掛裝進 DSH、開啟編輯器。就這樣 —— **不需要 UEBox、不需要 token、不需要握手**。

### 步驟 1 — 把 UnrealAgentLink 裝進 UE 專案

1. 把整個 `UnrealAgentLink` 目錄複製到專案的 `Plugins/` 下（或引擎的 `Plugins/` 下，做全域安裝）。
2. 重新產生專案檔，然後開啟專案。
3. 在 **Edit → Plugins** 下確認 UnrealAgentLink 已啟用。它會自動帶入兩個引擎自帶的依賴：`IKRig` 與 `PythonScriptPlugin`。

從此編輯器就自己往外連：`StartupModule` 無條件呼叫 `Init("ws://127.0.0.1:17860")`，並每 5 秒重試一次，所以**啟動順序無所謂**。

> 連接埠已經被佔了（例如被 UEBox）？給編輯器換一個，並在本側配合修改：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### 步驟 2 — 把這個外掛裝進 DSH

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 189 tests + catalog + doc reconciliation, one command
```

再往下走之前 `npm run check` 必須全綠 —— 它驗證原始碼與測試都能通過型別檢查、行為測試全過，以及 170 條命令的目錄與 C++ 註冊表逐條對齊。

接著把它登記為 DSH bundle。`package.json` 宣告 `dsh.bundle.patch: ./cordis.patch.yml`，而那個檔案只做一件事：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **配置分層**：後一層會**整體替換**該行的 `config`，而不是深合併。要覆寫任何內容，必須把想保留的鍵全部重寫一遍。

DSH 沒有附帶任何安裝本機 out-of-tree 外掛的指令，因此本倉庫附帶了一個安裝程式，它做完這件事之後就把接下來交給真正的安裝器：

```bash
npm run status:dsh -- --profile web     # what is registered right now (same script, npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web             # mirror, edit the manifest, install, verify
```

它拒絕碰一個執行中的 DSH 仍持有的 manifest，並在回報成功之前證明 layer 已被合成：`dsh --profile <profile> --dump-config` 必須包含 `# == dsh-unreal-agentlink`；只有 `desktop` 例外 —— CLI 不會合成該 profile，那裡改由 `dsh plugin --profile desktop list` 證明，它讀的是同一份套件依賴圖。如果 peer dependency 守衛擋下了安裝，它會印出接受風險的確切指令 —— **那個決定是你的，不是腳本的**。

另外還有兩條路，兩邊都寫出來了：下面的[不使用指令碼的手動安裝](#不使用指令碼的手動安裝)，以及 [INSTALL-ai.md](../zh-TW/INSTALL-ai.md) —— 一個 AI agent 能讀並逐步照做的版本。

### 步驟 3 — 開啟專案並確認

開啟 UE 專案，然後請 agent 呼叫 `ual_status`，檢查三個欄位：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → 外掛沒啟動，或連接埠被佔。在 DSH 日誌裡找 `EADDRINUSE`。
- `listening: true` 但 `editors: []` → 橋接在等編輯器。確認 UE 專案已開啟、UnrealAgentLink 已啟用。

編輯器連上後的**第一瞬間**，它的記錄裡只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`；像 `project` 這樣的欄位要等編輯器推來 `project.info` 之後才會出現。那是正常狀態，不是錯誤。

接著試一個無副作用的純讀取：

```
ual_call { method: "level.get_current" }
```

**完整走過一遍 —— 工作流程、怎麼讀失敗、疑難排解 —— 都在[教學](../zh-TW/01-tutorial.md)。**

---

## 系統需求

| 項目 | 要求 |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | C++ 外掛本體，放進工程的 `Plugins/` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH 執行環境 | 本外掛以 bundle 形式安裝即可運作 |

### 不需要安裝 UEBox

UEBox 桌面版**不是依賴**。它只是同一廠商的另一個用戶端，恰好也連 17860，所以同時執行會搶連接埠 —— 關係僅此而已。依據：

- `UnrealAgentLink.uplugin:25-34` 只宣告兩個依賴，都是引擎自帶：`IKRig` 與 `PythonScriptPlugin`。沒有任何 uebox 模組。
- `UnrealAgentLink.Build.cs` 的每一項依賴都是引擎模組（UnrealEd / AssetRegistry / MovieScene / Landscape …）。沒有 uebox SDK。
- 整個原始碼裡 `uebox` 出現 3 次，都是 `// Copyright uebox.ai` 版權標頭。
- 沒有任何程式碼呼叫 uebox.ai。唯一的 `FHttpModule` 用法是讀取本機代理設定（`UAL_ProxyDiagnostics.cpp:167`）。

外掛放進工程後即自主運行：`StartupModule` 無條件呼叫 `Init("ws://127.0.0.1:17860")`（`Core/UnrealAgentLink.cpp:86-97`），連上的瞬間就推送 `project.info`，沒有握手、沒有 token、沒有認證。

> 想換連接埠：編輯器側 `-UALServer=ws://127.0.0.1:17861`，本外掛側改 `port` 設定。

---

## 不使用指令碼的手動安裝

上面的指令碼只是個方便；底層機制是四行 manifest 加上一條產品指令。其中 `<profile>` 是 `web` —— `desktop` 也可以，只要做本節末尾提到的那一處替換 —— `$DSH_HOME` 預設是 `~/.dsh`：

```bash
# 1. 先建置一次，然後只複製 npm pack 會出貨的東西
npm run build
cp -r lib cordis.patch.yml package.json LICENSE README.md \
      "$DSH_HOME/profiles/<profile>/.vendor/"

# 2. 登記依賴與 bundle 層（兩者都是必需的）
"$DSH_HOME/profiles/<profile>/package.json"    # add the two entries shown below

# 3. 讓真正的安裝器跑起來
dsh plugin --profile <profile> install

# 4. 證明 layer 已被合成
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

那兩筆登記，在 `<profile>/package.json` 裡：

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

兩者都是必需的，而且失敗的方式不同：被列出的套件若沒有宣告 `dsh.bundle`，會在開機時**大聲失敗**；而裝了卻沒被列出的套件**完全不貢獻任何 layer**，`--dump-config` 裡什麼都不會出現。

**為什麼 `file:` 指向一份複本，而不是你的工作區**：pnpm 在安裝時會複製它找到的東西，所以一個存到一半的原始檔 —— 或建置失敗後被刪掉的 `lib/` —— 會變成 DSH 載入的那個外掛。先鏡像，再安裝。

**`desktop` profile 是受支援的安裝目標，只有一處 CLI 缺口。** `dsh --profile desktop …` 會被直接拒絕（`bin.js:112`，`rejectElectronProfile`），因為 Electron 應用程式掌管該 profile 的生命週期 —— 但對 `dsh plugin` 這道守衛是有意跳過的（`bin.js:119`），應用程式自己呼叫的 Desktop 隨附 CLI 正依賴這一點（`dsh-desktop-host/lib/cli.js:91-104` 傳入 `manageDesktopProfile: true`）。所以照上面的步驟裝進 `desktop`，只要改兩處：第 4 步換成 `dsh plugin --profile desktop list`，而且必須先把應用程式完全關掉。產品自己的訊息寫得很清楚 —— *「先開啟一次 DeepSeek Harness Desktop 初始化它的 profile，然後在執行 `dsh plugin --profile desktop` 之前把它完全關掉」* —— 因為執行中的應用程式會用記憶體裡的插件清單重寫 manifest，在它底下做的修改可能遺失。裝完後再啟動 Desktop 即可掛載該 layer。

> 上面的步驟 2 已經用一條命令完成了這件事 —— 你只在需要自己控制每一步時才走這條路。

---

## 文件

| 文件 | 內容 |
|---|---|
| [教學](../zh-TW/01-tutorial.md) | 端到端：安裝外掛、連上編輯器、常見工作流程、疑難排解 |
| [協議參考](../zh-TW/02-protocol.md) | 訊息結構、事件、13 個狀態碼、序列化規則、逾時與並發語義 |
| [架構](../zh-TW/03-architecture.md) | 閘門鏈、工作階段隔離與復原、錯誤翻譯、驗證策略、踩過的坑 |
| [命令參考](../zh-TW/command-reference.md) | 170 條命令的參數／必填鍵／結果鍵／狀態碼（**自動產生**） |
| [安裝指南（AI 可讀）](../zh-TW/INSTALL-ai.md) | 寫給 AI agent 讀並執行的安裝程序，並附上它前後必須執行的檢查 |

以上五份在頂部列出的每種語言下都有對應版本，位於 `docs/<lang>/` —— `en`（正式版，直接放在 `docs/` 下）、`zh`、`zh-TW`、`ja`、`ko`、`de`、`es`、`fr`、`ru`。

> 只有**散文**會被翻譯。命令名、參數鍵、結果鍵、狀態碼、配置鍵與 C++ 行號參考在所有語言中一律逐字保留 —— 因為 UE 會靜默忽略它不認識的鍵，把 `asset_path` 翻譯成別的名字只會得到一個靜默失效的鍵，而不是本地化。`tests/i18n.test.ts` 強制執行讓這套做法可維護的幾個不變式：每種語言都有自己的檔案、每個語言切換列都列出所有語言、每個內部連結與 `#anchor` 都能解析。最後一條特別重要，因為錨點是從**譯文標題**推導出來的 —— 改寫一個標題就會無聲地破壞所有指向它的連結。

---

## 四個必須先建立的事實

這四條不是設計取捨，是 UnrealAgentLink 的既有約束，它們決定了所有操作的寫法。

1. **方向是反的。** 本外掛不去連編輯器 —— 是**編輯器主動連出來**。啟動順序無所謂：編輯器先開就每 5 秒重試一輪，直到外掛出現。
2. **沒有認證。** 無 token、無 header、無子協議。**連接埠就是憑證**，所以預設只綁 loopback。不要改成 `0.0.0.0`。
3. **命令在遊戲執行緒上串行執行。** 而且阻塞命令執行期間**編輯器什麼都不回** —— 連 `sequence.render_status` 這種進度查詢也不回。
4. **沒有取消。** `query_task` 與 `cancel_task` 不存在。殺掉 `ual_task` 作業只停本外掛的等待，引擎照跑，結果依然會回來。

---

## 12 個工具

170 條命令若各做成一個工具，會用掉每次請求 prompt 的一大塊，而給定任務很少會碰到其中絕大多數。因此發現能力要兩步，而不是零步：

| 工具 | 用途 |
|---|---|
| `ual_status` | 編輯器連線／斷路器／限流／工作階段／孤兒命令。**出問題時先讀這個** |
| `ual_tools` | 列出全部 170 條命令（22 個族），可按族或關鍵詞過濾 |
| `ual_schema` | 單條命令的**精確鍵名** —— 呼叫前必看，UE 對未知鍵是靜默忽略的 |
| `ual_call` | 執行一條命令，原樣回傳編輯器結果 |
| `ual_batch` | 一個往返執行多條（上限 `maxBatchCalls`；有一項危險則整批走審批） |
| `ual_screenshot` | 截圖並回傳**真實圖片**，agent 能直接看到 |
| `ual_logs` | 讀取本機日誌環（UE 側轉發預設關閉，見教學） |
| `ual_undo` / `ual_undo_history` | 工作階段級復原／檢視復原緩衝區 |
| `ual_locks` | 宣告資產鎖，編輯器會畫出「AI 正在編輯」角標 |
| `ual_editor_bind` | 多個編輯器連著時，把工作階段固定到其中一個 |
| `ual_task` | 把長的阻塞命令轉成真實的後台作業，對話可繼續 |

### 風險分級

read 65 / write 89 / **destructive 2 / dangerous 14**（最後 16 類走審批）。

`tools/pre-execute` 對 destructive 與 dangerous 方法（含 `ual_batch` 中任一危險項）回傳 `{kind:'ask'}`，把決定權留給工作階段策略。**未註冊的方法直接 `deny`**，不會轉發進編輯器。

注意：在 `never` 策略下 `ask` 會被自動拒絕 —— 這正是「無人值守不得動編輯器」的正確解讀。

---

## 配置

預設值是「活著但惰性」。完整表格與理由見 [教學第 7 節](../zh-TW/01-tutorial.md#7-配置)。

| 鍵 | 預設 | 說明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | 保持 loopback：沒有認證，夠到連接埠就能驅動編輯器 |
| `timeoutMs` | `180000` | 阻塞類命令各自抬高下限 |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | 工作階段讀快取 |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | 每秒命令數／排隊上限（0 關閉限流） |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | 連續傳輸失敗即開斷路／冷卻時間 |
| `logCapacity` / `logMinLevel` | `512` / `Display` | 日誌環 |
| `logForwardingEnabled` | `false` | 只在編輯器內執行過 `ual.ForwardLogs` 之後才設為 `true` |
| `rollbackOnDispose` | `false` | 只有 LIFO 後綴才精確 —— 見架構文件 |
| `notifyOnEditorChange` | `true` | 編輯器連上或掉線時向 agent 注入一行說明 |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | 截圖轉圖片區塊／體積上限 |
| `maxBatchCalls` | `12` | 單次 `ual_batch` 上限 |

---

## 開發

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### 原始碼結構

```
src/
  index.ts                  Cordis lifecycle, approval gate, dispose-time rollback
  config.ts                 Schemastery schema (the single source of default values)
  service.ts                call() gate chain: catalog → requires → read cache → breaker → rate limit → send → ledger → translate
  protocol/{bridge,serialization,types}.ts   WS server / outbound validation / wire types
  catalog/{method-data,method-overrides,methods}.ts   170-command catalog (data extracted from C++)
  errors/translate.ts       Error classification (by class name / status code, never by message text)
  resilience/breaker.ts     Rate limiter + circuit breaker
  sessions/state.ts         Session ledger / LIFO test / lock merging / cache / log filtering
  tools/                    The 12 tools
scripts/                    目錄擷取與對帳、文件產生與正規化、
                             語言集合，以及 DSH profile 安裝程式
docs/                       教學／協定／架構／指令參考／安裝指南，
                             共 9 種語言
tests/                      189 tests
```

### 產生物：請勿手動修改

`src/catalog/method-data.ts` 與 `docs/<lang>/command-reference.md` 都是**產生物**：

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference
```

手維護卻沒有人 import 的表，是本專案反覆出現的一類缺陷（`REQUIRED_KEYS`、`EXTRA_PARAM_KEYS` 與 `UAL_CODES` 都栽在過它上面）。對策是讓每項檢查**去問源頭**，而不是問表自己 —— 見 [架構第 9 節](../zh-TW/03-architecture.md#9-產生物與沒人-import-的表)。

### 測試與檢查

```bash
npm run check                       # typecheck (src + tests) + 189 passed + catalog + doc reconciliation
npm test                            # 189 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date
```

10 個測試檔案按**它們能發現的缺陷類型**劃分，各有道理 —— 見 [架構第 11 節](../zh-TW/03-architecture.md#11-驗證策略)。

`requires` 不是手寫的：它從 handler 自己的 `SendError(..., 400, "Missing field: X")` 訊息推導而來（共 28 處），因為寫錯一個必填鍵會讓橋接層在引擎看到之前就拒掉一個*合法*呼叫。推導結果落在 `method-data.ts` 的 `REQUIRED_KEYS`，並由 `methods.ts` 的 `requiresOf()` 合併進執行期（`service.call()` 的前置拒絕、`ual_schema` 的 `REQUIRED:` 行、錯誤提示都走這同一個函式）。

它刻意**只收窄、不放大**：訊息中含有 `or`（`"Missing field: name or path"`）的整條跳過；從同檔案中被呼叫的函式裡擷取到的鍵，一律視為分支區域性而丟棄 —— 見 `scripts/extract-methods.mjs` 的 `REQUIRED_DROPPED`，每個條目都標明其 C++ 行號。所以「一個鍵都沒擷取到」是安全的預設，不是漏檢。

### 沒有 Unreal Engine 也能測試

跑本外掛不需要編輯器，也不需要 UEBox —— 接縫就是協議本身：UEBox 是**往外**撥號連到本橋接的，所以一個假編輯器就是一個會應答的 WebSocket 用戶端。

```bash
npm run smoke                        # 啟動真實服務、接入一個假編輯器，
                                     # 呼叫全部 12 個工具、驗證每個結果
npm run smoke -- --out /tmp/ual      # 把執行紀錄與 PNG 存到別處
npm run smoke -- --method actor.get  # 只跑一個目錄方法，原樣印出
npm run mock:ue                      # 只要那個假編輯器，方便手動試探
```

`tools/mock-ue-editor.mjs` 是一個真實行程，不是樁：它撥號連 `ws://127.0.0.1:17860`，推送 `project.info` 與 `system.heartbeat`，轉發 `log.entry` 行，為 `editor.screenshot` 寫出真正的 PNG，並應答**全部 170 個已編目方法** —— 對重要的幾個方法族給出有真實感的回應主體，其餘給出帶文件所述結果鍵的回應主體。`tools/ual-smoke.mjs` 啟動的是 `apply()` 啟動的同一個 `UalService`，透過各工具真正的 `execute` 呼叫每個工具，用該工具自己的輸出 schema 驗證每個值，並印出模型原本會看到的內容。它是 `tests/mock-editor.test.ts` 的手動孿生；兩者都在[架構第 11 節](../zh-TW/03-architecture.md#11-驗證策略)裡描述。

---

## 協議重點

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- 失敗**只由 `code` 表達**，訊息裡沒有 envelope 級 `error` 欄位。
- 人類可讀的文字在 `result.message`（按編輯器文化分中文或英文，**不要解析**）；機器可讀的資訊在 `result.details`。
- **許多 handler 回傳 `200` 但 `result.ok === false`**（`editor.undo`、`blueprint.compile`、`pie.observe`），所以外掛用 `judge()` 判成敗，不只看 code。C++ 裡有 55 處 `SetStringField(TEXT("error"), ...)`，分布在 14 個檔案 —— 這是常態而非異常。
- `content.import_folder` / `content.import_assets` 是**即發即棄**的外發推送：不帶 `id`、不等待回覆。外掛把事件轉成日誌與 agent 通知，**不回一個假 `res`** —— 回 `ok:false` 只會讓用戶看到虛假的「導入失敗」對話框，比沉默更糟。

完整細節（13 個狀態碼、序列化規則、逾時語義）見 [協議參考](../zh-TW/02-protocol.md)。

---

## License

MIT

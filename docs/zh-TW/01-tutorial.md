<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · **繁體中文** · [日本語](../ja/01-tutorial.md) · [한국어](../ko/01-tutorial.md) · [Deutsch](../de/01-tutorial.md) · [Español](../es/01-tutorial.md) · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_zh-TW.md) · **教學** · [協議](02-protocol.md) · [架構](03-architecture.md) · [命令參考](command-reference.md)

</div>

# 教學：從零跑通 dsh-unreal-agentlink

本篇是端到端的上手路徑。目標：讓 DSH 裡的 agent 能真正驅動本機的 Unreal 編輯器，並知道什麼該做、什麼會卡住。

建議閱讀順序：本篇 → [協議](02-protocol.md) → [架構](03-architecture.md) → [命令參考](command-reference.md)。

---

## 1. 心智模型：先建立四個事實

在動手之前，這四件事決定了後面所有操作的寫法。它們不是設計取捨，是 UnrealAgentLink 的既有約束。

**① 方向是反的。** 不是本外掛去連編輯器，是**編輯器主動連出來**。UnrealAgentLink C++ 外掛在 `StartupModule` 裡無條件發起 `ws://127.0.0.1:17860`，本外掛在這個連接埠上監聽。所以啟動順序無所謂：編輯器先開就每 5 秒重試一輪，外掛後出現一樣接得上。

**② 沒有認證。** 無 token、無 header、無子協議。**連接埠本身就是憑證** —— 誰能連上 17860，誰就能驅動編輯器。因此預設只綁 loopback，也不要改成 `0.0.0.0`。

**③ 命令在遊戲執行緒上序列執行。** 編輯器收到命令後，若不在遊戲執行緒就重新投遞過去，然後**同步執行到結束**。這帶來兩個後果：

- 同一編輯器的命令天然排隊，本外掛也按編輯器序列發送。
- **阻塞命令運行期間，編輯器什麼都不回** —— 連 `sequence.render_status` 這類進度查詢也不回。此時發任何別的命令都只是排在後面。

**④ 沒有取消。** 協議中不存在 `query_task` / `cancel_task`。殺掉 `ual_task` 作業只停掉**本外掛這邊的等待**，引擎側照跑，結果依然會回來。這句話也寫進了 `ual_task` 的工具描述裡，供模型閱讀。

---

## 2. 前置條件

| 項 | 要求 | 說明 |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | 外掛 `.uplugin` 聲明的範圍 |
| UnrealAgentLink | C++ 外掛本體 | 放進專案的 `Plugins/` 目錄 |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 見 `package.json` 的 `engines` |
| DSH 執行環境 | 可用即可 | 本外掛作為 bundle 載入 |

**不需要 UEBox 桌面版。** 它只是同一廠商的另一個用戶端，恰好也連 17860，所以同時執行會搶連接埠。詳見 [README 的「不需要安裝 UEBox」](../readme/README_zh-TW.md#不需要安裝-uebox)。

**你也不需要 Unreal Engine**，如果你只是想看到本外掛跑起來。UEBox 是*往外*撥號連到本橋接的，所以一個假編輯器就是一個會應答的 WebSocket 用戶端：

```bash
npm run smoke     # 真實服務 + 假編輯器：呼叫全部 12 個工具，驗證每個結果
npm run mock:ue   # 只要那個假編輯器，方便手動試探
```

`tools/mock-ue-editor.mjs` 撥號連 `ws://127.0.0.1:17860`，推送 `project.info` 與 `system.heartbeat`，轉發 `log.entry` 行，為 `editor.screenshot` 寫出真正的 PNG，並應答全部 170 個已編目方法。下面每一步都可以對著它走一遍。

### 把 UnrealAgentLink 裝進 UE 專案

1. 把 `UnrealAgentLink` 整個目錄複製到專案的 `Plugins/` 下（或引擎的 `Plugins/` 下，全域生效）。
2. 重新產生專案檔並開啟專案。
3. 在 **Edit → Plugins** 下確認 UnrealAgentLink 已啟用。

外掛會自動啟用兩個引擎自帶的依賴：`IKRig` 與 `PythonScriptPlugin`（見 `.uplugin`）。編輯器啟動後即開始連 17860，無需任何配置。

> 若連接埠被佔（例如 UEBox 桌面版正在執行），給編輯器換一個：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> 本外掛側的 `port` 配置也要一併改。

---

## 3. 安裝本外掛

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 189 tests + catalog + doc reconciliation, one command
```

往下走之前，`npm run check` 必須全綠。它驗證三件事：原始碼與測試都能通過型別檢查、行為測試全過、170 條命令的目錄與 C++ 註冊表逐條對齊。

### 作為 DSH bundle 載入

`package.json` 宣告了 `dsh.bundle.patch: ./cordis.patch.yml`，該檔案只做一件事：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**注意**：DSH 的配置分層中，後一層會**整體替換**這一行的 `config`，而不是深合併。要覆寫任何一個鍵，必須把想保留的鍵全部重寫一遍。

#### 使用安裝指令碼

DSH 自己**沒有**安裝本機 out-of-tree 外掛的指令，因此本倉庫附帶了一個安裝程式，它做好前置工作之後就把接下來的安裝交給真正的安裝器：

```bash
npm run status:dsh -- --profile web     # what is registered right now (same script, npm passthrough)
node scripts/install-dsh-plugin.mjs --profile web             # mirror, edit the manifest, install, verify
```

它拒絕碰一個執行中的 DSH 仍持有的 manifest，並在回報成功之前證明 layer 已被合成 —— 除了 `desktop` profile 之外，處處都走 `--dump-config`（`dsh --profile <profile> --dump-config` 必須包含 `# == dsh-unreal-agentlink`）；`desktop` 是 CLI 不會合成的 profile，所以改由 `dsh plugin --profile desktop list` 代勞。宣告的 peer 範圍同時涵蓋本外掛建置所依據的版本，以及目前 dsh 出貨的 `0.2.x` 系列，所以 peer dependency 守衛不會擋下正常安裝；只有將來的執行環境落在這些範圍之外時，dsh 才會印出接受風險的確切指令（`--accept-risk`）；**那個決定是你的，不是腳本的**。

#### 手動安裝

上面的指令碼只是個方便；底層機制是四步 manifest 編輯加上一條產品指令。其中 `<profile>` 是 `web`（也可以是 `desktop`，見下面的說明），`$DSH_HOME` 預設是 `~/.dsh`：

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

**`desktop` profile 同樣走這四步，只是沒有最後一步。** `dsh --profile desktop …` 會被拒絕（`bin.js:112` 拒絕 Electron profile），而 `dsh plugin --profile desktop …` 是有意豁免的（`bin.js:119`），Desktop 隨附的 CLI 自己走的就是這條路。所以先把應用程式完全關掉 —— 產品自己的訊息正是這樣要求，因為執行中的應用程式會用記憶體裡的插件清單重寫 manifest —— 然後跑安裝，並用 `dsh plugin --profile desktop list` 代替第 4 步來驗證。

如果你是在讓一個 AI agent 做這件事，把 [INSTALL-ai.md](INSTALL-ai.md) 給它 —— 那是一份機器可讀的逐步程序，連失敗時的讀法都寫在裡面。

---

## 4. 首次連通

### 第 1 步：確認橋接活著

讓 agent 呼叫 `ual_status`。關注四個欄位：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → 外掛沒啟動，或連接埠被佔。看 DSH 日誌裡的 `EADDRINUSE`。
- `listening: true` 但 `editors: []` → 橋接在等編輯器。確認 UE 專案已開啟、UnrealAgentLink 已啟用。

編輯器連上後的**第一瞬間**，記錄裡只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` —— `project` 這類欄位要等編輯器推來 `project.info` 才會出現。這是正常狀態，不是錯誤。

### 第 2 步：探索能力

不要猜命令名。兩步走：

```
ual_tools  { filter: "material" }        → 列出 material 族的命令與一行說明
ual_schema { method: "material.create" } → 該命令的參數鍵、必填鍵、結果鍵、狀態碼
```

`ual_schema` 的鍵名是從 C++ handler 裡**逐字擷取**的。這一步不能省：**UE 對未知或型別不對的鍵是靜默忽略的** —— 鍵名拼錯不會報錯，只會「成功」地什麼都沒做。

### 第 3 步：第一次真實呼叫

```
ual_call { method: "level.get_current" }
```

純讀取，無副作用。回傳編輯器 `result` 的**原樣內容**，本外掛不做任何重塑。

### 第 4 步：看一眼關卡

```
ual_screenshot { width: 1280, height: 720 }
```

回傳的是**真實圖片**，agent 能直接看到。這比 `ual_call { method: "editor.screenshot" }` 好用 —— 後者只回傳一個檔案路徑。

截圖裡的 `pending_shaders` / `pending_assets` 不為 0，說明畫面還在編譯或串流載入，**不是最終外觀**。不要據此判定材質有問題。

---

## 5. 常見工作流程

### 修改一個 actor 的屬性

```
ual_schema { method: "actor.set_property" }        # 先看鍵名
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

屬性名拼錯時，編輯器**回傳候選建議**而不是 404。讀建議，別重試錯拼寫。

### 批次操作

已知要做的一連串事，用 `ual_batch` 一次往返完成：

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- 序列執行（編輯器本來就是序列的），預設**第一個失敗即停**，`continueOnError: true` 可改。
- 上限 `maxBatchCalls`（預設 12）。
- **只要有一項是危險操作，整批都走審批。** 審批提示會點名是哪一項。

### 長任務

阻塞遊戲執行緒的命令必須走 `ual_task`：

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

立即回傳 `jobId`，對話繼續。用 `job_output` 收結果。

哪些屬於長任務：`sequence.render`、`cpp.compile`、`level.build`、`blueprint.compile_all`、`pcg.execute`、`pie.run`、資產匯入。`ual_schema` 的逾時欄會標出「阻塞」。

**不要**在長任務運行期間輪詢編輯器 —— 它不會回。

### 復原

```
ual_undo_history            # 先看緩衝區裡有什麼
ual_undo { dryRun: true }   # 演練
ual_undo                    # 真的復原
```

UnrealAgentLink 為每個編輯器維護**一條獨立的 agent 復原堆疊**，與使用者的 Ctrl+Z 歷史分開。本外掛記錄每一步屬於哪個 DSH 工作階段，**只在本工作階段的步驟構成緩衝區乾淨的 LIFO 後綴時才復原**。若期間別的工作階段動過編輯器，本工具**什麼都不復原**，並把兩份步驟清單都報出來，而不是默默丟掉別人的工作。

### 宣告資產鎖

多步修改某個資產之前：

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... 修改 ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

編輯器會在內容瀏覽器畫上「AI 正在編輯」角標，使用者手動改動時會收到警告。多個工作階段的宣告由本外掛合併成一張表後下發，編輯器重連後會重新下發。

### 讀取日誌

```
ual_logs { level: "Warning", contains: "Niagara" }
```

日誌環預設是空的 —— UE 側的日誌轉發**預設關閉**，需要在編輯器內執行 `ual.ForwardLogs 1`（本外掛無法遠端開啟）。`ual_logs` 回傳空值時會提示這一點。

轉發關閉時，改用引擎自己的訊息日誌。它是一棵**類別樹**，不是一張平鋪清單：先問它持有哪些類別，再問其中一個類別裡的行。

```
ual_logs { pullMessageLog: true }                     # 引擎持有的類別
ual_logs { pullMessageLog: true, category: "PIE" }    # 其中一個類別裡的行
```

第一種形式呼叫的是 `messagelog.list`，它**不接收任何參數**，並以 `{categories: [{name, label}]}` 應答 —— 所以它只能告訴你某個類別存在，永遠說不出它講了什麼。行來自 `messagelog.get`，它需要一個 `category`；第二種形式呼叫的就是它。如果想要原始酬載，兩者都可以透過 `ual_call` 取得。

---

## 6. 解讀失敗

本外掛**絕不解析錯誤文字**（文字會隨編輯器文化切換中英文），只按**錯誤類別名稱與狀態碼**分類，共 16 種 kind。

| kind | 含義 | 該做什麼 |
|---|---|---|
| `no-editor` | 沒有編輯器連著 | 開啟 UE 專案；確認外掛已啟用 |
| `timeout` | 逾時，**命令可能還在跑** | **不要重發**。先用讀取命令確認實際狀態，再決定 |
| `editor-lost` | 編輯器斷線 | 等它按 5 秒週期重連 |
| `queue-stalled` | 前面有命令逾時了 | 先查 `ual_status` 的 `orphaned` |
| `circuit-open` | 連續傳輸失敗，斷路已開 | 停手，等冷卻，查 `ual_status` |
| `rate-limited` | 限流佇列滿 | 降速 |
| `not-found` | 方法不存在或資產不存在 | 用 `ual_tools` 查真實命令名 |
| `bad-params` | 參數缺失或型別錯誤 | 用 `ual_schema` 核對鍵名 |
| `precondition` | 前置條件不滿足（412/413/422） | 讀 `details`；422 意為「輸入合法但一件都沒寫進去」 |
| `registry-busy` | 資產註冊表還在掃描 | 輪詢 `content.registry_status` |
| `unsupported` | 該編輯器版本不支援 | 例如 `anim.*` 需要 UE 5.5+ |
| `engine-error` | 編輯器自身出錯 | 讀 `result.message`（給人看）與 `details`（給機器看） |

**逾時是最需要紀律的一種。** 協議沒有取消語義，逾時只表示「本外掛不等了」，命令很可能仍在遊戲執行緒上跑。正確反應是：先查 `ual_status` 的 `orphaned`，再用唯讀命令驗證實際狀態，**不要重發**。

---

## 7. 配置

全部鍵都可改，預設值是「活著但惰性」。完整表格見 [README 的配置](../readme/README_zh-TW.md#配置)。幾個值得留意的：

- **`port`** —— 改了這裡，UE 側也要用 `-UALServer=` 改。
- **`rateLimitRps: 0`** —— 關閉限流。
- **`rollbackOnDispose: false`** —— 工作階段結束時**不**自動復原。打開它代表銷毀工作階段就復原，而這通常是使用者沒要求的意外。
- **`logForwardingEnabled: false`** —— 只在編輯器內開過 `ual.ForwardLogs 1` 之後才置 `true`。

---

## 8. 疑難排解

**`ual_status` 顯示 `listening: true` 但沒有編輯器**
UE 專案沒開，或 UnrealAgentLink 沒啟用。也可查編輯器日誌裡的 `LogUALNetwork`：正常應看到 `Connecting to ws://127.0.0.1:17860` 與 `Connected to`。

**啟動時 `EADDRINUSE`**
17860 被佔。最常見的是 UEBox 桌面版。關掉它，或給編輯器與本外掛同時換連接埠。

**命令都回傳 `unknown-method` 或被直接拒絕**
本外掛只放行目錄裡真實存在的 170 條命令。用 `ual_tools` 確認命令名。已廢棄的命令（如 `editor.play`、`take_screenshot`）會明確給出替代方法。

**截圖是全黑的／半成品**
看 `pending_shaders` / `pending_assets`。非 0 就是還沒編譯完或還在串流載入。加大 `warmup_frames` 再試。

**`ual_undo` 拒絕執行**
本工作階段的步驟不是緩衝區乾淨的 LIFO 後綴 —— 期間有別的工作階段動過編輯器。這是**有意的保護**，不是 bug。用 `ual_undo_history` 看實際內容。

**改了配置沒生效**
DSH 的配置分層是**整體替換**該行的 `config`，不是深合併。必須把所有想保留的鍵一起寫出來。

**`ual_task` 殺了作業但編輯器還在忙**
預期行為。協議沒有取消語義。等它跑完 —— 或更實際地說，下次別在長任務運行期間發別的指令。

---

## 9. 下一步

- [協議參考](02-protocol.md) —— 訊息結構、事件、狀態碼
- [架構](03-architecture.md) —— 閘門鏈、工作階段隔離、錯誤翻譯的設計理由
- [命令參考](command-reference.md) —— 170 條命令的完整參數與結果鍵（自動產生）

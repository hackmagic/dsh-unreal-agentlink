<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · **繁體中文** · [日本語](../ja/02-protocol.md) · [한국어](../ko/02-protocol.md) · [Deutsch](../de/02-protocol.md) · [Español](../es/02-protocol.md) · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_zh-TW.md) · [教學](01-tutorial.md) · **協議** · [架構](03-architecture.md) · [命令參考](command-reference.md)

</div>

# 協議參考

UnrealAgentLink 的通訊協議。本外掛是**伺服器**，Unreal 編輯器是**用戶端**。

這裡的每個結論都出自 `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/` 下的 C++ 原始碼，關鍵處都附上了檔案與行號。

---

## 1. 連線

| 項 | 值 | 證據 |
|---|---|---|
| 方向 | 編輯器主動連出 | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| 預設位址 | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| 更改方式 | 命令列 `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| 認證 | **無** —— 無 token、無 header、無子協議 | `CreateWebSocket` 只吃一個 URL |
| 重連 | 固定 5 秒週期，無退避 | `Network/UAL_NetworkManager.cpp:116` |
| 連線卡住保護 | 有（`ConnectTimeoutSeconds`） | `Network/UAL_NetworkManager.cpp:145-155` |

本外掛在 17860 上監聽，`maxPayload` 為 64 MB。

### 來源檢查

只接受 loopback 來源（`127.*`、`::1`、`::ffff:127.*`）。只有當配置的 `host` 被**刻意**設成 `127.0.0.1` / `localhost` 以外的值時才會放寬。原因就在「沒有認證」—— 連接埠就是憑證。

### 握手

**沒有握手。** 編輯器一連上就推 `project.info`，本外掛用它把對方標記為已識別（`editor-identified`）。在它到來之前，連線處於「已連線但未識別」狀態 —— `ual_status` 裡這種記錄只有 `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale`，沒有 `project` 等欄位。

---

## 2. 訊息結構

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → plugin:  { ver:"1.0", type:"evt",  method, payload }
```

### `req`（本外掛 → 編輯器）

| 欄位 | 說明 |
|---|---|
| `ver` | 一律 `"1.0"` |
| `type` | `"req"` |
| `method` | 命令名，例如 `actor.get_info` |
| `id` | 由**伺服器**產生，格式為 `dsh-<uuid>` |
| `params` | 可選。**內容為空時整個鍵一併省略**，不會送 `null` |

`id` 必須非空：`SendResponse` 的第一行是 `if (RequestId.IsEmpty()) { return; }`（`Utils/UAL_CommandUtils.cpp:2503-2506`）—— **沒有 `id` 的請求永遠不會收到回覆**。

編輯器側的解析（`Commands/UAL_CommandHandler.cpp:87-94`）先讀 `params`，讀不到才退回舊欄位 `payload`。本外掛只送 `params`。

### `res`（編輯器 → 本外掛）

| 欄位 | 說明 |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | 回顯請求的 `id`，用於配對 |
| `code` | 一個**數字**，不是字串 |
| `result` | 可選。**沒有內容時整個鍵一併省略** |

省略邏輯在 `Utils/UAL_CommandUtils.cpp:2513-2516`：只有 `Data.IsValid()` 時才寫 `result`。

編輯器側的回應本文解析（`Commands/UAL_CommandHandler.cpp:98-104`）按 `result` → `data` → `payload` 的順序嘗試。本外掛送 `result`。

### `evt`（編輯器 → 本外掛，單向推送）

| 欄位 | 說明 |
|---|---|
| `ver` | 事件經 `SendEvent` 送出時會有；**內容瀏覽器擴充的匯入事件不帶它** |
| `type` | `"evt"` |
| `method` | 事件名 |
| `payload` | 可選 |
| `id` | **不存在** —— 事件無法被回覆 |

---

## 3. 失敗怎麼表達

**只靠 `code`。** 訊息裡**沒有**封包外殼層級的 `error` 欄位。

| 狀態碼 | 含義 | 本外掛的 kind |
|---|---|---|
| `200` | 成功 | — |
| `207` | 部分成功 | `partial: true` |
| `400` | 參數缺失或型別錯誤 | `bad-params` |
| `404` | 方法或資產不存在 | `not-found` |
| `409` | 衝突（例如獨佔的效能分析器已在運行） | `conflict` |
| `410` | 已移除 | `not-found` |
| `412` | 前置條件未滿足 | `precondition` |
| `413` | 超過上限（例如批次建立超過 cvar 限制） | `precondition` |
| `422` | 輸入合法但什麼都沒寫進去 | `precondition` |
| `500` | 編輯器內部錯誤 | `engine-error` |
| `501` | 此版本不支援 | `unsupported` |
| `503` | 資產註冊表還在掃描 | `registry-busy` |
| `504` | 編輯器側逾時 | `timeout` |

`0` **永遠不會出現**。

這 13 個狀態碼定義在 `protocol/types.ts` 的 `UAL_CODES`，而 `scripts/check-catalog.mjs` 的第 4 項檢查會直接查 C++ 原始碼核對 —— 包括 `FUAL_RegistryReady::Ensure` 這類共用閘門發出的 503，以及 `Code = bOk ? 200 : 207` 這類運算式寫法。少一個或多一個都會讓檢查失敗。

### 錯誤文字放在哪裡

```
result.message   ← 給人看，依編輯器文化為中文或英文，永遠不要解析
result.details   ← 給機器看（候選建議 / expected_type / 註冊表進度）
```

`SendError` 會建出 `{message: ...}`，4 參數的重載會一併附上 `details`（`Utils/UAL_CommandUtils.cpp:2525-2539`）。

### 200 也可能是失敗

**這是最容易踩的坑。** 許多 handler 回傳 `200` 但 `result.ok === false`：

- `editor.undo` —— 沒有可復原的東西時
- `blueprint.compile` —— 編譯有錯誤時
- `pie.observe` —— 觀察失敗時

所以本外掛用 `judge(result, code)` 判定成敗，而不是只看狀態碼：

| 情況 | 判定 |
|---|---|
| `code === 200`、`result.ok !== false`、`result.error` 為空 | 成功 |
| `code === 207` | 成功，但 `partial: true` |
| `result.ok === false` | **失敗** |
| `result.error` 是非空字串 | **失敗** |
| `result` 不是物件（或不存在） | 依狀態碼判定；不要猜 |

這條規則是**必要的**：14 個 C++ 檔案裡有 55 處 `SetStringField(TEXT("error"), ...)`。換句話說，「200 且帶非空 error」是常態，不是異常。

---

## 4. 事件

| 事件 | 時機 | 內容 |
|---|---|---|
| `project.info` | 連上即推，代替握手 | 專案名、路徑、引擎版本、外掛版本、運行模式、目前關卡、Python 可用性等 |
| `project.closed` | 編輯器關閉專案 | — |
| `system.heartbeat` | 每 **10 秒** | `{}`（**永遠存在**，不會省略） |
| `log.entry` | UE 日誌輸出（需要 cvar `ual.ForwardLogs 1`） | `text` / `category` / `level` |
| `content.import_folder` | 使用者在內容瀏覽器右鍵選單選「import to UnrealBox asset library」 | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | 同上，從關卡視埠觸發 | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### 心跳與宣告編輯器死亡

心跳是一個**獨立的 10 秒計時器**（`Network/UAL_NetworkManager.cpp:173`），與 5 秒重連無關。本外掛在 **45 秒**沒有心跳後把編輯器標為 `stale` —— 與前端一致（`Network/UAL_NetworkManager.cpp:172`）。

### 兩個匯入事件是即發即棄的

它們**不帶 `id`**，編輯器也**不等回覆**。編輯器側的 `Handle_Response`（`Commands/UAL_CommandHandler.cpp:185-297`）只在收到 `type:"res"` 時才彈出 Slate 通知，讀取 `ok` / `count` / `importedPath` / `error`。

本外掛是純橋接，沒有匯入資產的能力，因此把事件轉成**日誌與 agent 通知**，並且**不偽造 `res`** —— 回 `ok:false` 只會讓使用者看到虛假的「匯入失敗」對話框，比沉默更糟。

---

## 5. 序列化規則

外發參數在送上線路之前，會先經過 `protocol/serialization.ts` 的 `toSerializable()`。它比 `JSON.stringify` 更嚴格，因為 **UE 把讀不到的欄位視為「沒送」** —— 靜默地什麼都不做，比報錯更難診斷。

| 輸入 | 處理方式 |
|---|---|
| `null` / 布林 / 字串 | 原樣送出 |
| 有限數字 | 原樣送出 |
| **非有限數字**（`NaN` / `Infinity`） | **拋出例外** —— UE 會把它讀成「欄位不存在」 |
| `undefined`（頂層，或陣列元素） | **拋出例外** |
| `undefined`（作為物件屬性的值） | **整個鍵丟棄** |
| function / symbol / bigint | **拋出例外** |
| 循環參照 | **拋出例外** |
| `Uint8Array` | 轉成 base64 字串 |
| `Date` | 轉成 ISO 字串 |
| `Map`（鍵必須是字串） | 轉成純物件 |
| `Set` | 轉成陣列 |
| 其他非純物件（類別實例等） | **拋出例外** |

只有純物件、陣列與 JSON 純量能通過。

---

## 6. 時序與並發

**同一個編輯器的命令是序列的。** 本外掛為每個編輯器維護一條發送佇列，把每條命令接到前一條的 `then` 後面。這不是為了滿足協議 —— 編輯器本來就會在遊戲執行緒上同步執行到結束。

**佇列在各編輯器之間彼此獨立。** 多個編輯器連著時，各自一條佇列。

### 逾時

預設 180 秒，阻塞類命令會各自抬高下限（`ual_schema` 的逾時欄會標出「阻塞」）。

**逾時不代表命令沒有執行。** 它只表示本外掛停止等待。此時：

1. 編輯器會被標記為有孤立命令（`ual_status` 的 `orphaned`）。
2. 之後發給**同一個編輯器的短命令會被直接拒絕**（`queue-stalled`），而不是排在可能永不回覆的工作後面。
3. `long: true` 的呼叫仍然可以送 —— 這就是「我願意等」的表達方式。

**中止的呼叫同理**：殺掉 `ual_task` 作業會走中止流程，而中止只停掉本外掛這邊的等待，引擎側照跑。所以中止也會記下一筆孤立。

### 斷線

編輯器斷線時，它所有進行中的請求都會以 `editor-lost` 失敗，錯誤裡會帶上全部的命令名。

---

## 7. 本外掛不會送出的東西

為了把邊界講清楚：

- **沒有 token** —— 不存在認證機制。
- **沒有 `GET /api/ual/action`** —— 舊文件把它描述成 HTTP 服務，那是錯的。
- **沒有任務輪詢** —— `query_task` / `cancel_task` 不存在。
- **不偽造 `res`** —— 見匯入事件那一節。
- **不主動重連編輯器** —— 方向是反的，編輯器自己每 5 秒重試一輪。

---

## 8. 相關檔案

| 檔案 | 內容 |
|---|---|
| `src/protocol/types.ts` | 訊息型別、`UAL_CODES`、`UalError` |
| `src/protocol/bridge.ts` | WebSocket 伺服器、佇列、逾時、孤立、日誌環 |
| `src/protocol/serialization.ts` | 上面表格裡的每一條序列化規則 |
| `src/service.ts` | `judge()`、閘門鏈、帳本 |
| `src/errors/translate.ts` | 狀態碼 / 類別名稱 → 16 種 kind |

C++ 對應檔案：`Utils/UAL_CommandUtils.cpp`（`SendResponse` / `SendError` / `SendEvent`）、`Commands/UAL_CommandHandler.cpp`（入埠分派）、`Network/UAL_NetworkManager.cpp`（連線、心跳、重連）。

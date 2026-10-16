<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · **繁體中文** · [日本語](../ja/INSTALL-ai.md) · [한국어](../ko/INSTALL-ai.md) · [Deutsch](../de/INSTALL-ai.md) · [Español](../es/INSTALL-ai.md) · [Français](../fr/INSTALL-ai.md) · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_zh-TW.md) · [教學](01-tutorial.md) · [協定](02-protocol.md) · [架構](03-architecture.md) · [指令參考](command-reference.md) · **安裝指南**

</div>

# 安裝（AI 可讀）

這份檔案是寫給會讀檔案、會照順序執行步驟的 AI 助理的。
不要跳過任何步驟；每個步驟都有一個可驗證的結果。人類要安裝的話，看
[README](../readme/README_zh-TW.md) 或[教學](01-tutorial.md)。

> AI 只需要執行 `scripts/install-dsh-plugin.mjs`。那個腳本包辦了一切：鏡像 → 編輯
> profile manifest → 呼叫真正的安裝器 → 驗證合成結果。下面每一步都是一個
> **驗證點**：如果某一步對不上，停下來並回報它。不要繼續。

---

## 0. 先檢查（唯讀，不安裝任何東西）

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` 與 `bundle layer:` 應該讀作 `present` / `listed`。只有當它們讀作
`(absent)` / `(not listed)` 時，才需要執行安裝。

接著檢查 UnrealAgentLink 那一側：

- 專案裡存在 `Plugins/UnrealAgentLink/`，並且在 `Edit → Plugins` 下已啟用
  （編輯器需要重新啟動）。
- 連接埠 17860 是空的（`uebox` 桌面版會佔用同一個連接埠；本外掛不需要它）。

---

## 1. 安裝（一條命令）

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

這個腳本執行五個動作，每個動作都會留下證據：

| 步驟 | 產物 | 失敗時的意義 |
| --- | --- | --- |
| build | `lib/`，64 個檔案 | 先跑 `npm run check`；不要安裝一個壞掉的建置 |
| mirror | `<profile>/.vendor/`，只含 `files` 條目 | 磁碟或權限問題 |
| manifest 編輯 | `<profile>/package.json` 多出一行依賴與一行 bundle | 見 §4 |
| installer | pnpm 印出 `Done in Xs` | 見 §2 |
| verify | `install: ... is now a bundle layer of profile "web"` | 見 §3 |

**只有最後一行代表安裝成功。** 如果前四步過了而第五步失敗，layer 就沒有被合成，dsh 不會載入這個外掛。

---

## 2. 如果安裝器拒絕了（版本守衛）

dsh 有一個產品層級的守衛：當外掛的 `peerDependencies` 與執行環境的 dsh 版本不相容時，安裝會被拒絕。本專案把每個 `@deepseek-ai/dsh-*` peer 宣告為 `>=0.1.6-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0`，它同時接受本外掛建置並測試所依據的版本（`0.1.6-alpha.2`）與目前 dsh 出貨的 `0.2.x` 系列 —— 所以在受支援的執行環境上正常安裝**不會**停在這裡。

> 這兩個分支不是裝飾。semver 不會把一個 prerelease 版本匹配到比較符不帶 prerelease 標記的範圍，
> 所以裸寫 `^0.1.6-alpha.2` 會讓每個 `0.2.0-rc.*` 執行環境都顯得不相容。每條受支援的產品線
> 因此都需要自己帶顯式 prerelease 下界的分支，而上界則停在沒人測過其 API 的下一條產品線。

守衛仍會在這兩個範圍之外的執行環境上觸發 —— 將來的 `0.3.x`，或比 `0.1.6-alpha.2` 更舊的 `0.1.x`。
**那是一個產品決定；腳本刻意不替你作主。** dsh 拒絕安裝時會印出確切的指令：

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

執行它需要人類確認。然後從 §1 重新執行安裝。

> `--status` 會在 `version guard:` 那一行顯示豁免是否已經生效。

---

## 3. 如果驗證步驟失敗（layer 沒有被合成）

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

它必須印出：

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

沒有印出時，三個已知原因：

1. `dsh.profile.bundles` 沒有列出這個外掛 —— 腳本應該已經加上了；檢查 `<profile>/package.json`。
2. 套件在 `node_modules` 裡，但沒有宣告 `dsh.bundle` —— 這會在載入時**大聲失敗**（`declares no dsh.bundle in its package.json`）；檢查鏡像過去的 `package.json`。
3. `--dump-config` 本身就報錯了 —— 原樣回報完整輸出，不要猜。

---

## 4. 如果 manifest 編輯被鎖拒絕

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh 用一個 `wx` 建立的 `.lock` 兄弟檔保護 profile manifest，而**競爭者永不刪除另一個持有者的鎖**。持有者就是執行中的 dsh 應用程式本身。

- 對 `web` profile：關掉執行中的 DeepSeek Harness 桌面應用程式，或換一個沒有被持有的 profile。
- 對 `desktop` profile：CLI 的*啟動*命令是**被禁止的**（`bin.js:112`
  `rejectElectronProfile`），但 `dsh plugin --profile desktop …` 是有意豁免的
  （`bin.js:119`）—— 應用程式自己呼叫的 Desktop 隨附 CLI 走的就是這條路。產品要求先把應用程式完全關掉，
  因為執行中的應用程式會用自己的插件清單重寫 manifest。把它關掉，跑安裝，
  裝完後再啟動 Desktop 以掛載該 layer。
- 腳本會拒絕並點名持有者；它不會去搶那個鎖。

---

## 5. 驗證外掛真的在工作（裝上了不算）

```bash
# a) 編輯器側：開啟專案。UE 日誌應該會顯示一條連線。
#    （UnrealAgentLink 每 5 秒重試一次；不需要手動連線。）

# b) DSH 側：在一個 session 裡請 agent「用 ual_status 檢查編輯器」。
```

`ual_status` 的三個欄位就是驗收條件：

| 欄位 | 預期 |
| --- | --- |
| `listening` | `true` |
| `editors` | 至少一個，並帶有 `project` 名稱 |
| `orphanedMethods` | `[]` |

`listening: false` = 沒有東西在聽（外掛沒載入，或連接埠被佔）。
`editors: []` = UE 沒有連上（專案關著、外掛停用，或連接埠不一致）。
`orphanedMethods` 非空 = 有一個請求逾時但仍可能在跑；
重試前先看 `ual_logs`。

然後用一個最小的呼叫確認整條路徑：

```bash
# 在一個 session 裡：ual_call { "method": "level.get_current" }
```

---

## 6. 卸載

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

腳本會同時移除依賴與 bundle 條目，然後跑一次真正的安裝器，讓 pnpm 同步 `node_modules`。鏡像目錄 `<profile>/.vendor` 會被保留，下次安裝時重新建置；想讓它消失就手動刪掉。

---

## 給 AI 的硬性規則

1. **不要**編輯本專案的 `peerDependencies` 來讓安裝通過 ——
   那會掩蓋一個真實的版本不相容。
2. **不要**手動編輯 `<profile>/package.json`；腳本會做，而且它會檢查鎖。
3. **不要**把 `--accept-risk` 當成可以自動執行的東西；它需要人類確認。
4. 如果任何一步的輸出與上面描述的不同，**停下來並原樣回報輸出**；
   不要「試個修正再跑一次」。
5. 這裡每一步都能用唯讀命令重新驗證（`--status`、
   `--dump-config`、`ual_status`）。

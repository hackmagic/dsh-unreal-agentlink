<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · **日本語** · [한국어](README_ko.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Русский](README_ru.md)

# dsh-unreal-agentlink

### 手元の Unreal エディタをエージェントの支配下に置く DSH プラグイン

**純粋なブリッジ。エージェントが計画し、このプラグインは翻訳するだけ。**

```
DSH agent  ──tool calls──►  dsh-unreal-agentlink  ◄──WebSocket──  Unreal Editor
(plans, decides)            (this plugin: server, translator)   editor dials out
```

[インストール](#インストール) · [必要なもの](#必要なもの) · [12 個のツール](#12-個のツール) · [設定](#設定) · [ドキュメント](#ドキュメント)

<code>npm install &amp;&amp; npm run check</code>

</div>

---

エージェントはすでにファイルを読み、コマンドを実行できる。このプラグインはそれに**エディタそのもの**を与える：レベルを問い合わせ、アクターをスポーンさせ、ブループリントとマテリアルを編集し、シーケンスをレンダリングし、実際に*見える*スクリーンショットを撮り、何かうまくいかないときは自分の作業を巻き戻す。

タスクの**計画はしない**。計画は DSH のネイティブエージェントの領分だ。このプラグインは安全層を備えた翻訳器 —— エージェントの意図を UnrealAgentLink コマンドに翻訳し、エディタの答えをエージェントが行動できる形に翻訳し直す。

---

## インストール

3 つの部分がある：UnrealAgentLink C++ プラグインを UE プロジェクトに入れ、このプラグインを DSH にインストールし、エディタを開く。それだけだ —— **UEBox もトークンもハンドシェイクも不要**。

### ステップ 1 — UnrealAgentLink を UE プロジェクトに入れる

1. `UnrealAgentLink` ディレクトリ全体をプロジェクトの `Plugins/` にコピーする（グローバルに入れる場合はエンジンの `Plugins/`）。
2. プロジェクトファイルを再生成してからプロジェクトを開く。
3. **Edit → Plugins** で UnrealAgentLink が有効になっていることを確認する。エンジン付属の 2 つの依存（`IKRig` と `PythonScriptPlugin`）は自動的に取り込まれる。

その後はエディタが自分からダイヤルアウトする：`StartupModule` が無条件に `Init("ws://127.0.0.1:17860")` を呼び出し、5 秒ごとにリトライするので、**起動順序は関係ない**。

> ポートがすでに埋まっている場合（UEBox など）、エディタに別のポートを与え、この側でも合わせる：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`

### ステップ 2 — このプラグインを DSH にインストールする

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck (src + tests) + 173 tests + catalog + doc reconciliation, one command
```

先に進む前に `npm run check` が完全にグリーンでなければならない —— ソースとテストが型チェックを通ること、振る舞いのテストが通ること、170 コマンドのカタログが C++ のレジストリと 1 件ずつ一致することを確かめる。

次に DSH バンドルとして登録する。`package.json` は `dsh.bundle.patch: ./cordis.patch.yml` を宣言しており、そのファイルがすることは 1 つだけだ：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

> **設定のレイヤリング**：後の層はその行の `config` をディープマージではなく**全体置き換え**する。何かを上書きするには、残したいキーをすべて書き直すこと。

DSH にはローカルの out-of-tree プラグインをインストールするコマンドが同梱されておらず、`dsh plugin --profile desktop` は Electron アプリがその profile を独占管理しているためその場で拒否される（`bin.js:38`）。だからこのリポジトリは、その作業を行ってから本当のインストーラに委ねるインストーラを同梱している：

```bash
npm run status:dsh -- --profile web     # 現在登録されている内容（同じスクリプト、npm パススルー）
node scripts/install-dsh-plugin.mjs --profile web             # ミラー、manifest の編集、インストール、検証
```

それは `desktop` profile を拒否し、動作中の DSH がまだ保持している manifest に触ることを拒否し、成功を報告する前に layer が合成されていることを証明する（`dsh --profile web --dump-config` に `# == dsh-unreal-agentlink` が含まれていなければならない）。ピア依存のガードがインストールを止めた場合、リスクを受け入れるための正確なコマンドが出力される —— **その決定はあなたのものであって、スクリプトのものではない**。

あと 2 つの道のりがあり、どちらも文章化されている：下記の[スクリプトなしで手動インストールする](#スクリプトなしで手動インストールする)と、[INSTALL-ai.md](../ja/INSTALL-ai.md) —— AI エージェントが読んで順番に実行できるバージョン。

### ステップ 3 — プロジェクトを開いて確認する

UE プロジェクトを開き、エージェントに `ual_status` を呼ばせて 3 つのフィールドを確認する：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → プラグインが起動していないか、ポートが埋まっている。DSH のログで `EADDRINUSE` を探す。
- `listening: true` だが `editors: []` → ブリッジは待機中だ。UE プロジェクトが開いていて、UnrealAgentLink が有効になっていることを確認する。

エディタが接続した**最初の瞬間**、そのレコードには `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` しかない。`project` などのフィールドは、エディタが `project.info` をプッシュした後に初めて現れる。これは正常な状態で、エラーではない。

次に副作用のない純粋な読み取りを試す：

```
ual_call { method: "level.get_current" }
```

**端から端までの手順 —— ワークフロー、失敗の読み方、トラブルシューティング —— は [チュートリアル](../ja/01-tutorial.md) にある。**

---

## 必要なもの

| 項目 | 要件 |
|---|---|
| Unreal Engine | 5.0 – 5.8 |
| UnrealAgentLink | C++ プラグイン本体。プロジェクトの `Plugins/` に配置する |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| DSH ランタイム | このプラグインがバンドルとしてインストールされていること |

### UEBox は不要

UEBox デスクトップアプリは**依存関係ではない**。同じベンダーの別のクライアントで、たまたま同じ 17860 ポートを使っているだけなので、両方を同時に動かすとポート衝突になる —— 関係はそれだけだ。根拠：

- `UnrealAgentLink.uplugin:25-34` は依存を 2 つだけ宣言しており、どちらもエンジン付属：`IKRig` と `PythonScriptPlugin`。uebox モジュールはない。
- `UnrealAgentLink.Build.cs` のエントリはすべてエンジンモジュール（UnrealEd / AssetRegistry / MovieScene / Landscape …）。uebox SDK はない。
- ソース全体で `uebox` は 3 回現れるだけで、すべて `// Copyright uebox.ai` のヘッダだ。
- 何も uebox.ai を呼び出していない。唯一の `FHttpModule` の使用は、ローカルマシンのプロキシ設定を読むものだけ（`UAL_ProxyDiagnostics.cpp:167`）。

プラグインをプロジェクトに入れれば、あとは自分で動く：`StartupModule` が無条件に `Init("ws://127.0.0.1:17860")` を呼び出し（`Core/UnrealAgentLink.cpp:86-97`）、接続した瞬間に `project.info` をプッシュし、ハンドシェイクもトークンも認証もない。

> ポートを変えるには：エディタ側で `-UALServer=ws://127.0.0.1:17861`、このプラグイン側で `port` 設定を変える。

---

## スクリプトなしで手動インストールする

上記のスクリプトは便利さのためのものだ。根底にある機構は 4 行の manifest と 1 つの製品コマンドだ。`<profile>` は `web`（または desktop 以外の任意の profile）であり、`$DSH_HOME` はデフォルトで `~/.dsh` とする：

```bash
# 1. 一度ビルドし、npm pack が出すものだけをコピーする
npm run build
cp -r lib cordis.patch.yml package.json LICENSE README.md \
      "$DSH_HOME/profiles/<profile>/.vendor/"

# 2. 依存とバンドルレイヤーを登録する（どちらも必須）
"$DSH_HOME/profiles/<profile>/package.json"    # 下記の 2 つのエントリを追加する

# 3. 本当のインストーラを実行させる
dsh plugin --profile <profile> install

# 4. layer が合成されていることを証明する
dsh --profile <profile> --dump-config | grep -A2 '# == dsh-unreal-agentlink'
```

`<profile>/package.json` 内の 2 つのエントリ：

```json
"dependencies": { "dsh-unreal-agentlink": "file:C:/Users/you/.dsh/profiles/web/.vendor" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-unreal-agentlink"] } }
```

どちらも必須で、失敗のしかたが違う：`dsh.bundle` を宣言しない列挙されたパッケージは起動時に**大声で失敗する**が、インストールされているのに列挙されていないパッケージは**レイヤーをまったく提供せず**、`--dump-config` に何も現れない。

**なぜ `file:` がコピーを指すのか、作業スペースを指さないのか**：pnpm はインストール時に見つけたものをコピーするので、半分保存されたソースファイル —— あるいはビルド失敗後に削除された `lib/` —— が DSH が読み込むプラグインになってしまう。まずミラーし、次にインストールする。

**`desktop` profile に CLI 経路はない。** `bin.js:38` はそれを拒否する。Electron アプリケーションが独占管理しており、そのアプリは動作中 `desktop/package.json` に `wx` ロックを保持している（`dsh-atomic-write`。競合者は他の保持者のロックを決して削除しない）。選択肢は GUI 自身のプラグインマネージャを使うか、アプリを閉じて上記 4 ステップを手動で行うかだ。最初に `web` にインストールして結果をコピーするのが最も侵襲性が低い。

---

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [チュートリアル](../ja/01-tutorial.md) | 端から端まで：プラグインのインストール、接続の確立、よく使うワークフロー、トラブルシューティング |
| [プロトコルリファレンス](../ja/02-protocol.md) | メッセージ構造、イベント、13 個のステータスコード、シリアライズ規則、タイムアウトと並行性のセマンティクス |
| [アーキテクチャ](../ja/03-architecture.md) | ゲートチェーン、セッション分離とロールバック、エラー翻訳、検証戦略、遭遇した罠 |
| [コマンドリファレンス](../ja/command-reference.md) | 全 170 コマンドのパラメータ / 必須キー / 結果キー / ステータスコード（**自動生成**） |
| [インストールガイド（AI 可読）](../ja/INSTALL-ai.md) | AI エージェントが読んで実行するために書かれたインストール手順。前後に実行すべきチェックとともに |

上記 5 点はすべて、このファイル先頭に挙げたすべての言語で、`docs/<lang>/` 配下に用意されている —— `en`（正式版。`docs/` 直下）、`zh`、`zh-TW`、`ja`、`ko`、`de`、`es`、`fr`、`ru`。

> 翻訳されるのは*本文*だけだ。コマンド名、パラメータキー、結果キー、ステータスコード、設定キー、C++ の行参照はすべての言語で逐語的に保たれる。なぜなら UE は認識しないキーを黙って無視するからだ —— 翻訳された `asset_path` はローカライズではなく、静かに死んだキーになってしまう。`tests/i18n.test.ts` は、これを保守可能にする不変条件を強制する：すべての言語にファイルがあり、すべての言語切替バーにすべての言語が並び、すべての内部リンクと `#anchor` が解決する。最後の 1 つが重要なのは、アンカーが*翻訳された*見出しから導出されるためだ。見出しの言い回しを変えれば、それを指すすべてのリンクが静かに壊れる。

---

## まず確立すべき 4 つの事実

これらは設計上の選択ではない。UnrealAgentLink の既存の制約であり、すべての操作の書き方を決める。

1. **向きが逆だ。** このプラグインはエディタにダイヤルしない —— **エディタがダイヤルアウトする**。起動順序は関係ない：エディタを先に開いておけば、プラグインが現れるまで 5 秒ごとにリトライし続ける。
2. **認証はない。** トークンもヘッダーもサブプロトコルもない。**ポートこそが資格情報**なので、デフォルトではループバックにのみバインドする。`0.0.0.0` には変更しないこと。
3. **コマンドはゲームスレッド上で直列に実行される。** そしてブロッキングコマンドの実行中は**エディタは何も返さない** —— `sequence.render_status` のような進捗問い合わせすら返さない。
4. **取り消しはない。** `query_task` と `cancel_task` は存在しない。`ual_task` のジョブを kill しても止まるのはこのプラグインの待機だけだ。エンジンは動き続け、結果は依然として返ってくる。

---

## 12 個のツール

170 個のコマンドを 170 個のツールとして露出させると、各リクエストのプロンプトの大部分を、そのタスクが決して触れない機能のために費やすことになる。だから機能の発見は 2 ステップだ。0 ステップではない：

| ツール | 用途 |
|---|---|
| `ual_status` | エディタの接続 / ブレーカー / レート制限 / セッション / 孤立コマンド。**何かおかしいときはまずこれを読む** |
| `ual_tools` | 全 170 コマンド（22 ファミリー）を列挙。ファミリーやキーワードで絞り込み可能 |
| `ual_schema` | 1 コマンドの**正確なキー名** —— 呼び出し前に確認を。UE は未知のキーを黙って無視する |
| `ual_call` | 1 つのコマンドを実行し、エディタの結果を逐語的に返す |
| `ual_batch` | 1 往復で複数コマンドを実行（上限は `maxBatchCalls`。危険な項目が 1 つでもあるとバッチ全体が承認を通過する） |
| `ual_screenshot` | エージェントが実際に見られる**本物の画像**をキャプチャして返す |
| `ual_logs` | ローカルのログリングを読む（UE 側の転送はデフォルト無効 —— チュートリアル参照） |
| `ual_undo` / `ual_undo_history` | セッション単位のロールバック / アンドゥバッファの確認 |
| `ual_locks` | アセットロックを取得。エディタは「AI が編集中」バッジを描画する |
| `ual_editor_bind` | 複数のエディタが接続されているとき、セッションを 1 つに固定する |
| `ual_task` | 長いブロッキングコマンドを本当のバックグラウンドジョブに変え、会話を続行できるようにする |

### リスク階層

read 65 / write 89 / **destructive 2 / dangerous 14**（この 16 件は承認を通過する）。

`tools/pre-execute` は destructive と dangerous のメソッド（`ual_batch` 内の危険な項目を含む）に対して `{kind:'ask'}` を返し、決定はセッションポリシーに委ねる。**未登録のメソッドはその場で拒否され**、エディタに到達することはない。

`never` ポリシーの下では `ask` は自動的に拒否されることに注意 —— これは「無人セッションはエディタを触ってはならない」の正しい解釈だ。

---

## 設定

デフォルト値は「動くが怠惰」。理由付きの完全な表は [チュートリアル §7](../ja/01-tutorial.md#7-設定) にある。

| キー | デフォルト | 意味 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `17860` | ループバックのままに：認証がないので、ポートに到達できればエディタを駆動できる |
| `timeoutMs` | `180000` | ブロッキング系コマンドは各自で下限を引き上げる |
| `cacheTtlMs` / `cacheMaxEntries` | `2000` / `128` | セッション単位の読み取りキャッシュ |
| `rateLimitRps` / `rateLimitQueue` | `5` / `32` | 秒あたりのコマンド数 / キュー上限（0 でレート制限を無効化） |
| `breakerThreshold` / `breakerCooldownMs` | `3` / `30000` | 連続した通信失敗で開く / クールダウン |
| `logCapacity` / `logMinLevel` | `512` / `Display` | ログリング |
| `logForwardingEnabled` | `false` | エディタ内で `ual.ForwardLogs` を実行した後にのみ `true` にする |
| `rollbackOnDispose` | `false` | 正確に戻せるのは LIFO サフィックスのみ —— アーキテクチャのドキュメントを参照 |
| `notifyOnEditorChange` | `true` | エディタの接続 / 切断時にエージェントへ 1 行注入する |
| `screenshotAttachments` / `screenshotMaxBytes` | `true` / 12MB | 画像ブロック / サイズ上限 |
| `maxBatchCalls` | `12` | 1 回の `ual_batch` あたりの上限 |

---

## 開発

```bash
npm run build       # tsc → lib/
npm run dev         # tsc --watch
npm run check       # typecheck + tests + catalog reconciliation (run before committing)
npm test            # tests only
npm run typecheck   # src and tests typechecked separately
```

### ソース構成

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
scripts/                    カタログ抽出と照合、ドキュメント生成と正規化、
                            言語セット、DSH profile インストーラ
docs/                       チュートリアル / プロトコル / アーキテクチャ / コマンドリファレンス / インストールガイド、
                            9 言語対応
tests/                      173 tests
```

### 生成ファイル：手で編集しないこと

`src/catalog/method-data.ts` と `docs/<lang>/command-reference.md` はどちらも**生成物**だ：

```bash
node scripts/extract-methods.mjs .ua-ref/plugin/UnrealAgentLink/Source   # rebuild the catalog from C++
npm run build && node scripts/gen-docs.mjs                             # rebuild the command reference (all 9 languages)
```

誰も import しない手書きの表は、このプロジェクトで繰り返し現れる欠陥クラスだ（`REQUIRED_KEYS`、`EXTRA_PARAM_KEYS`、`UAL_CODES` がすべてそれに罹患した）。対策は、各チェックに**表に聞かせる**のではなく**ソースに聞かせる**こと —— [アーキテクチャ §9](../ja/03-architecture.md#9-生成ファイルと誰も-import-しない表) を参照。

### テストとチェック

```bash
npm run check                       # typecheck (src + tests) + 173 passed + catalog + doc reconciliation
npm test                            # 173 passed
node scripts/check-catalog.mjs      # 170/170 zero drift; every requires key appears in C++; code set matches C++
node scripts/gen-docs.mjs --check   # is the command reference up to date in all 9 languages
```

8 つのテストファイルは**それらが見つけられる欠陥の種類**で分かれており、それぞれに理由がある —— [アーキテクチャ §11](../ja/03-architecture.md#11-検証戦略) を参照。

`requires` は手書きではない：ハンドラ自身の `SendError(..., 400, "Missing field: X")` メッセージ（28 箇所）から導出される。必須キーを 1 つ書き間違えると、エンジンが見る前にブリッジが*正当な*呼び出しを拒否してしまうからだ。結果は `method-data.ts` の `REQUIRED_KEYS` として格納され、`methods.ts` の `requiresOf()` がそれを実行時にマージする（`service.call()` の早期拒否、`ual_schema` の `REQUIRED:` 行、エラーヒントはすべてこの 1 つの関数を通る）。

これは意図的に**狭めるだけで、広げることはない**：`or` を含むメッセージ（`"Missing field: name or path"`）はまるごとスキップされ、同じファイル内の呼び出し先関数から採取したキーは分岐ローカルとして破棄される —— `scripts/extract-methods.mjs` の `REQUIRED_DROPPED` を参照。各エントリには C++ の行番号が書かれている。つまり「1 つも採取されなかった」は安全なデフォルトであって、見落としではない。

---

## プロトコルの要点

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }     // id is generated by the server
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }        // the key is omitted when empty
UE → plugin:  { ver,       type:"evt", method, payload }
```

- 失敗は**`code` だけ**で表現される。メッセージにエンベロープレベルの `error` フィールドは存在しない。
- 人間向けのテキストは `result.message`（エディタの言語設定に応じて中文か英文 —— **解析してはならない**）、機械向けの詳細は `result.details` にある。
- **多くのハンドラは `result.ok === false` とともに `200` を返す**（`editor.undo`、`blueprint.compile`、`pie.observe`）。だからプラグインは code だけではなく `judge()` で成否を判定する。C++ の 14 ファイルに 55 箇所の `SetStringField(TEXT("error"), ...)` がある —— これは常態であり、異常ではない。
- `content.import_folder` / `content.import_assets` は**送りっぱなしの外発プッシュ**だ：`id` はなく、返信も期待しない。プラグインはそれらをログとエージェント通知に変換し、**偽の `res` を作らない** —— `ok:false` で返してもユーザーには誤った「インポートに失敗しました」ダイアログが見えるだけで、沈黙より悪い。

詳細（13 個のステータスコードすべて、シリアライズ規則、タイムアウトのセマンティクス）は [プロトコルリファレンス](../ja/02-protocol.md) を参照。

---

## ライセンス

MIT

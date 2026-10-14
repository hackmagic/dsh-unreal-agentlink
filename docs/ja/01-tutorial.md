<div align="center">

[English](../01-tutorial.md) · [简体中文](../zh/01-tutorial.md) · [繁體中文](../zh-TW/01-tutorial.md) · **日本語** · [한국어](../ko/01-tutorial.md) · [Deutsch](../de/01-tutorial.md) · [Español](../es/01-tutorial.md) · [Français](../fr/01-tutorial.md) · [Русский](../ru/01-tutorial.md)

[README](../readme/README_ja.md) · **チュートリアル** · [プロトコル](02-protocol.md) · [アーキテクチャ](03-architecture.md) · [コマンドリファレンス](command-reference.md)

</div>

# チュートリアル：ゼロから動くブリッジまで

これは端から端までの手順だ。目標：DSH の中のエージェントが実際にローカルの Unreal Editor を駆動できるようにし、何をすべきか、何が詰まるのかを知ること。

推奨する読み順：このページ → [プロトコル](02-protocol.md) → [アーキテクチャ](03-architecture.md) → [コマンドリファレンス](command-reference.md)。

---

## 1. メンタルモデル：まず 4 つの事実

何かに触る前に、この 4 つの事実が後続のすべての操作の書き方を決める。これらは設計上の選択ではない —— UnrealAgentLink の既存の制約だ。

**① 向きが逆だ。** このプラグインはエディタにダイヤルしない。**エディタがダイヤルアウトする**。UnrealAgentLink C++ プラグインは `StartupModule` で無条件に `ws://127.0.0.1:17860` を開き、このプラグインがそのポートを待ち受ける。だから起動順序は関係ない：エディタが先に起きれば 5 秒ごとにリトライし、プラグインが現れた時点で接続できる。

**② 認証はない。** トークンもヘッダーもサブプロトコルもない。**ポートそのものが資格情報**だ —— 17860 に到達できる者は誰でもエディタを駆動できる。だからデフォルトではループバックにのみバインドし、`0.0.0.0` には変更すべきでない。

**③ コマンドはゲームスレッド上で直列に実行される。** エディタはコマンドを受け取ると、まだゲームスレッドにいなければそこへ再投稿し、**完了まで同期的に実行する**。2 つの帰結：

- 同じエディタへのコマンドは自然にキューイングし、このプラグインもエディタごとに直列に送信する。
- **ブロッキングコマンドの実行中、エディタは何も返さない** —— `sequence.render_status` のような進捗問い合わせすら返さない。その間に何かを送っても、ただ後ろに並ぶだけだ。

**④ 取り消しはない。** プロトコルに `query_task` / `cancel_task` は存在しない。`ual_task` のジョブを kill しても止まるのは**このプラグイン側の待機**だけだ。エンジンは動き続け、結果は依然として返ってくる。この文は、モデルが読めるように `ual_task` のツール説明に書き込まれている。

---

## 2. 前提条件

| 項目 | 要件 | 備考 |
|---|---|---|
| Unreal Engine | 5.0 – 5.8 | プラグインの `.uplugin` が宣言する範囲 |
| UnrealAgentLink | C++ プラグイン本体 | プロジェクトの `Plugins/` にコピーする |
| Node.js | `^22.19.0 \|\| >=24.0.0` | `package.json` の `engines` を参照 |
| DSH ランタイム | 動作するインストールなら何でも | このプラグインはバンドルとして読み込まれる |

**UEBox デスクトップアプリは不要。** 同じベンダーの別のクライアントで、たまたま同じ 17860 ポートを使っているだけなので、両方を同時に動かすとポート衝突になる。詳しくは [README の「UEBox は不要」](../readme/README_ja.md#uebox-は不要) を参照。

### UE プロジェクトへの UnrealAgentLink のインストール

1. `UnrealAgentLink` ディレクトリ全体をプロジェクトの `Plugins/` にコピーする（グローバルに入れる場合はエンジンの `Plugins/`）。
2. プロジェクトファイルを再生成して開く。
3. **Edit → Plugins** で UnrealAgentLink が有効になっていることを確認する。

プラグインは 2 つのエンジン付属依存（`IKRig` と `PythonScriptPlugin`）を自動的に有効にする（`.uplugin` を参照）。エディタが起動すれば、設定なしで 17860 への接続を始める。

> ポートが埋まっている場合（UEBox デスクトップアプリなど）、エディタに別のポートを与える：
> `UnrealEditor.exe MyProject.uproject -UALServer=ws://127.0.0.1:17861`
> このプラグイン側の `port` 設定も合わせて変更する。

---

## 3. このプラグインのインストール

```bash
git clone <this-repo> dsh-unreal-agentlink
cd dsh-unreal-agentlink
npm install
npm run check      # typecheck + 154 tests + catalog reconciliation, one command
```

先に進む前に `npm run check` が完全にグリーンでなければならない。それが確かめるのは 3 つ：ソースとテストの両方が型チェックを通ること、振る舞いのテストがすべて通ること、170 コマンドのカタログが C++ のレジストリと 1 件ずつ一致すること。

### DSH バンドルとしてインストールする

`package.json` は `dsh.bundle.patch: ./cordis.patch.yml` を宣言し、そのファイルがすることは 1 つだけ：

```yaml
- insert:
    - id: unreal-agentlink
      name: dsh-unreal-agentlink
```

**注意**：DSH の設定レイヤリングでは、後の層はこの行の `config` をディープマージではなく**全体置き換え**する。任意のキーを上書きするには、残したいキーをすべて書き直す必要がある。

---

## 4. 最初の接続

### ステップ 1：ブリッジが生きているか確認する

エージェントに `ual_status` を呼ばせる。4 つのフィールドを見る：

```
listening: true
url: ws://127.0.0.1:17860
editors: [ { sessionId: "ue-xxxxxxxx", project: "MyProject", ... } ]
```

- `listening: false` → プラグインが起動していないか、ポートが埋まっている。DSH のログで `EADDRINUSE` を探す。
- `listening: true` だが `editors: []` → ブリッジは待機中だ。UE プロジェクトが開いていて、UnrealAgentLink が有効になっていることを確認する。

エディタが接続した**最初の瞬間**、そのレコードには `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` しかない。`project` などのフィールドは、エディタが `project.info` をプッシュした後に初めて現れる。これは正常な状態で、エラーではない。

### ステップ 2：機能を発見する

コマンド名を推測してはならない。2 ステップで：

```
ual_tools  { filter: "material" }        → list the material family with a one-line summary each
ual_schema { method: "material.create" } → that command's param keys, required keys, result keys, status codes
```

`ual_schema` のキー名は C++ ハンドラから**逐語的に抽出**されている。このステップを飛ばさないこと：**UE は未知のキーや型の違うキーを黙って無視する** —— キー名のスペルミスはエラーにならず、何もしないまま「成功」してしまう。

### ステップ 3：最初の実呼び出し

```
ual_call { method: "level.get_current" }
```

純粋な読み取りで、副作用はない。エディタの `result` を**逐語的に**返す。このプラグインはそれを作り変えない。

### ステップ 4：レベルを見る

```
ual_screenshot { width: 1280, height: 720 }
```

返ってくるのはエージェントが直接見られる**本物の画像**だ。ファイルパスだけを返す `ual_call { method: "editor.screenshot" }` より優れている。

スクリーンショットの `pending_shaders` / `pending_assets` が 0 でない場合、ビューはまだコンパイル中かストリーミング中で、**最終的な見た目ではない**。それだけでマテリアルが壊れていると判断してはならない。

---

## 5. よく使うワークフロー

### アクターのプロパティを変更する

```
ual_schema { method: "actor.set_property" }        # check key names first
ual_call   { method: "actor.get_info", params: { targets: { names: ["Cube_1"] } } }
ual_call   { method: "actor.set_property", params: {
               targets: { names: ["Cube_1"] },
               properties: { Mobility: "Movable" } } }
```

プロパティ名のスペルを間違えると、エディタは 404 ではなく**候補を返す**。候補を読むこと。間違えた綴りを再試行してはならない。

### バッチ操作

既知の手順の連続には、1 往復で済ませるために `ual_batch` を使う：

```
ual_batch { calls: [
  { method: "actor.spawn", params: { asset_id: "cube", name: "A" } },
  { method: "actor.spawn", params: { asset_id: "cube", name: "B" } },
  { method: "actor.get_info", params: { targets: { names: ["A", "B"] } } }
] }
```

- 直列に実行される（エディタ自体が直列なので）し、デフォルトでは**最初の失敗で止まる**。`continueOnError: true` がそれを変える。
- 上限は `maxBatchCalls`（デフォルト 12）。
- **1 つでも危険な項目があれば、バッチ全体が承認を通過する。** 承認プロンプトにはどの項目だったかが書かれる。

### 長時間のタスク

ゲームスレッドをブロックするコマンドは `ual_task` を通さなければならない：

```
ual_task { method: "sequence.render", params: { sequence_path: "/Game/Seq/Main" }, label: "Render main sequence" }
```

`jobId` を即座に返し、会話は続行できる。結果は `job_output` で回収する。

どれが長いか：`sequence.render`、`cpp.compile`、`level.build`、`blueprint.compile_all`、`pcg.execute`、`pie.run`、アセットのインポート。`ual_schema` のタイムアウト列が "blocking" と印を付けている。

長時間タスクの実行中はエディタをポーリング**しないこと** —— 返事はない。

### ロールバック

```
ual_undo_history            # see what is in the buffer first
ual_undo { dryRun: true }   # rehearse
ual_undo                    # actually undo
```

UnrealAgentLink は**エディタごとに 1 つの独立したエージェント用アンドゥスタック**を保持しており、ユーザーの Ctrl+Z 履歴とは別物だ。このプラグインは各ステップがどの DSH セッションのものかを記録し、**このセッションのステップがバッファのきれいな LIFO サフィックスを形成する場合にのみロールバックする**。間に別のセッションがエディタを触っていた場合、このツールは**何も取り消さず**、他人の作業をこっそり捨てる代わりに両方のステップ一覧を報告する。

### アセットロックの取得

アセットへの複数ステップにわたる変更の前に：

```
ual_locks { claim: ["/Game/Materials/M_Rock"] }
... make changes ...
ual_locks { release: ["/Game/Materials/M_Rock"] }
```

エディタはコンテンツブラウザに「AI が編集中」バッジを描画し、ユーザーが手で編集し始めると警告される。複数セッションからの要求は、このプラグインが送信前に 1 つのテーブルにマージし、エディタの再接続後に再送する。

### ログを読む

```
ual_logs { level: "Warning", contains: "Niagara" }
```

ログリングはデフォルトで空だ —— UE 側のログ転送は**デフォルトで無効**で、エディタ内で `ual.ForwardLogs 1` を実行する必要がある（このプラグインはリモートで有効にできない）。何も返らないとき、`ual_logs` はその旨を伝える。

転送が無効な間は、エンジン自身のメッセージログを使う：

```
ual_call { method: "messagelog.list", params: { limit: 50 } }
```

---

## 6. 失敗を読む

このプラグインは**エラーテキストを決して解析しない**（テキストはエディタの言語設定によって中文と英文を行き来する）。分類は**エラークラス名とステータスコード**だけに基づき、16 種類に分ける。

| kind | 意味 | 対処 |
|---|---|---|
| `no-editor` | エディタが接続されていない | UE プロジェクトを開く。プラグインが有効か確認する |
| `timeout` | タイムアウト。**コマンドはまだ実行中の可能性がある** | **再送しない**。まず読み取りコマンドで実際の状態を確認する |
| `editor-lost` | エディタが切断した | 5 秒周期の再接続を待つ |
| `queue-stalled` | 先行コマンドがタイムアウトした | `ual_status` の `orphaned` を確認する |
| `circuit-open` | 繰り返す通信失敗でブレーカーが開いた | 止まってクールダウンを待つ。`ual_status` を確認する |
| `rate-limited` | レート制限のキューが満杯 | 間隔を空ける |
| `not-found` | そのようなメソッドまたはアセットは存在しない | `ual_tools` で実際のコマンド名を調べる |
| `bad-params` | パラメータが欠けているか型が違う | `ual_schema` でキー名を確認する |
| `precondition` | 事前条件の失敗（412/413/422） | `details` を読む。422 は「入力は正当だが何も書き込まれなかった」を意味する |
| `registry-busy` | アセットレジストリがまだスキャン中 | `content.registry_status` をポーリングする |
| `unsupported` | このエディタのバージョンでは非対応 | 例：`anim.*` は UE 5.5 以降が必要 |
| `engine-error` | エディタ自体が失敗した | `result.message`（人間向け）と `details`（機械向け）を読む |

**最も規律を必要とするのがタイムアウトだ。** プロトコルに取り消しはないので、タイムアウトは「このプラグインが待つことをやめた」ことだけを意味する —— コマンドはゲームスレッド上でまだ動いている可能性が高い。正しい対処：`ual_status` の `orphaned` を確認し、読み取り専用コマンドで実際の状態を確かめ、**再送しない**。

---

## 7. 設定

すべてのキーは変更可能で、デフォルト値は「動くが怠惰」だ。完全な表は [README の「設定」](../readme/README_ja.md#設定) にある。特筆すべきは：

- **`port`** —— ここで変えたら、UE 側でも `-UALServer=` が必要になる。
- **`rateLimitRps: 0`** —— レート制限を無効化する。
- **`rollbackOnDispose: false`** —— セッション終了時に自動では取り消さない。オンにすると破棄時にロールバックするようになり、たいていユーザーが求めていない驚きになる。
- **`logForwardingEnabled: false`** —— エディタ内で `ual.ForwardLogs 1` を実行した後にのみ `true` にする。

---

## 8. トラブルシューティング

**`ual_status` が `listening: true` を示すがエディタがいない**
UE プロジェクトが開かれていないか、UnrealAgentLink が有効になっていない。エディタのログで `LogUALNetwork` も確認できる：通常は `Connecting to ws://127.0.0.1:17860` と `Connected to` が見えるはずだ。

**起動時に `EADDRINUSE`**
17860 が埋まっている。多くは UEBox デスクトップアプリが原因だ。それを閉じるか、エディタとこのプラグインの両方を別のポートに移す。

**コマンドがすべて `unknown-method` を返す、あるいはその場で拒否される**
このプラグインは、カタログに実在する 170 コマンドだけを通す。`ual_tools` で名前を確認すること。非推奨のコマンド（`editor.play`、`take_screenshot` など）は、代わりに使うべきコマンドを返す。

**スクリーンショットが黒い、または未完成**
`pending_shaders` / `pending_assets` を確認する。0 でなければ、コンパイルまたはストリーミングが終わっていない。`warmup_frames` を増やして再試行する。

**`ual_undo` が実行を拒否する**
このセッションのステップがバッファのきれいな LIFO サフィックスになっていない —— 間に別のセッションがエディタを触った。これは**意図的な保護**であり、バグではない。`ual_undo_history` で実際の内容を見る。

**設定の変更が効かなかった**
DSH の設定レイヤリングはその行の `config` をディープマージではなく**全体置き換え**する。残したいキーはすべて書き出す必要がある。

**`ual_task` のジョブを kill したがエディタがまだビジー**
想定内だ。プロトコルに取り消しはない。終わるまで待つ —— あるいは、もっと実用的には、長時間タスクの実行中は他のコマンドを送らない。

---

## 9. 次のステップ

- [プロトコルリファレンス](02-protocol.md) — メッセージ構造、イベント、ステータスコード
- [アーキテクチャ](03-architecture.md) — ゲートチェーン、セッション分離、エラー翻訳の背景にある理由
- [コマンドリファレンス](command-reference.md) — 全 170 コマンドのパラメータと結果キー（自動生成）

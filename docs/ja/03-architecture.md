<div align="center">

[English](../03-architecture.md) · [简体中文](../zh/03-architecture.md) · [繁體中文](../zh-TW/03-architecture.md) · **日本語** · [한국어](../ko/03-architecture.md) · [Deutsch](../de/03-architecture.md) · [Español](../es/03-architecture.md) · [Français](../fr/03-architecture.md) · [Русский](../ru/03-architecture.md)

[README](../readme/README_ja.md) · [チュートリアル](01-tutorial.md) · [プロトコル](02-protocol.md) · **アーキテクチャ** · [コマンドリファレンス](command-reference.md)

</div>

# アーキテクチャ

このプラグインは**純粋なブリッジ**だ：タスクを計画したり何をするか決めたりはしない。DSH エージェントの意図を UnrealAgentLink コマンドに翻訳し、エディタの答えをエージェントが使える形に翻訳し直すだけだ。計画は DSH のエージェントの仕事であって、ここではない。

この節では、コードがそうなっている理由を説明する。

---

## 1. モジュールマップ

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
  tools/                あの 12 個のツール
scripts/
  extract-methods.mjs   C++ からカタログを抽出する（method-data.ts を生成）
  check-catalog.mjs     カタログと C++ レジストリを双方向で照合する
  gen-docs.mjs          9 言語すべての docs/<lang>/command-reference.md を描画する
  languages.mjs         言語セット —— 生成器とドキュメントテストで共有される
  normalize-doc-headers.mjs  言語セットから言語バーとドキュメントナビゲーション行を書き換える
  normalize-doc-links.mjs    本文リンクを、そのファイル自身の位置から解決できるように書き換える
  install-dsh-plugin.mjs     このプラグインを dsh プロファイルに登録する（ミラー、マニフェスト、インストール、検証）
docs/                   チュートリアル / プロトコル / アーキテクチャ / コマンドリファレンス / インストールガイド、
                         ×9 言語
tests/                  9 ファイルに 173 テスト
```

### 依存の向き

```
index.ts ──► service.ts ──► protocol/bridge.ts
    │            │
    │            ├──► catalog/methods.ts ──► catalog/method-data.ts
    │            ├──► resilience/breaker.ts
    │            ├──► sessions/state.ts
    │            └──► errors/translate.ts
    └──► tools/* ──► service.ts
```

逆依存はない。`tools/` は `service` にだけ依存し、`service` はいかなるツールにも依存しない。

---

## 2. ゲートチェーン：`service.call()`

**すべての**コマンドがこの 1 つの入り口（`src/service.ts:190-332`）を通り、固定された順序で処理される：

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

最初の 2 ステップの価値は、**エンジンがその呼び出しを見る前に拒否する**ことだ。UE は未知のキーを黙って無視するので、キー名のスペルミスは呼び出しを「何もせず成功した」ことにしてしまう —— エラーよりずっとデバッグしにくい。

`call()` は**決して例外を投げない**。すべての失敗は `CallOutcome.value` の中の `ok: false` として返る。これは意図的だ：ツール層の各分岐は、それぞれが自分で try/catch するのではなく、構造化された結果を描画できる必要がある。

### 最初の 2 ステップが「リスク表」ではなく「カタログ」でなければならない理由

`riskOf()` は**未知の**メソッドに対して `'dangerous'` を返す（保守的なデフォルト）。以前のバージョンはこれを使って「このメソッドは存在するか」を推測していたが、それには 2 つの問題があった：

- 実際に存在する 5 つのメソッド（`level.new`、`level.open`、`level.save`、`content.migrate`、`blueprint.import_t3d`）を誤って拒否する
- 一方で、でっち上げられた `editor.*` の名前は何でも通してしまう

問いは今では `isKnown()`（カタログ検索）であり、`riskOf()` ではない。**存在することはカタログの問いであって、リスクの問いではない。**

---

## 3. セッション分離とロールバック

### 問題

UnrealAgentLink は**エディタごとに 1 つのエージェント用アンドゥスタック**を保持しており、すべての DSH セッションで共有される。DSH 側では、複数のセッションが同時に同じエディタを駆動しうる。

だから「自分のセッションがやったことを取り消す」は、プロトコルがサポートしていない操作なのだ。

### アプローチ

`src/sessions/state.ts` は各セッションが行ったすべてのステップを記録し、それぞれに**単調増加する番号**（`global`）を振る。ロールバックする前に、このセッションのステップがそのエディタのバッファの**きれいな LIFO サフィックス**を形成しているか —— つまり、このセッションの最後のステップが他のすべてのセッションの最後のステップより新しいか —— を確認する。

```
yes  → roll back, undoing only this session's steps
no   → undo nothing, and report both step lists
```

他人の作業を黙って捨てるくらいなら、拒否するほうがましだ。

### `rollbackOnDispose` のデフォルトは false

セッションが破棄されたときに自動でロールバックするのは便利そうだが、**ユーザーはそれを望んでいない**。デフォルトはオフで、オンにすることは「セッションの終了はその作業を取り消すべきだ」という明確な宣言になる。

---

## 4. エラー翻訳：なぜテキストを読まないのか

エラーテキストはエディタの言語設定によって中文と英文を行き来する（`result.message`）。それを解析すれば、プラグインは 1 つの言語に縛り付けられ、テキストはいつでも変わりうる。

`src/errors/translate.ts` は**エラークラス名**（`NoEditorError`、`BridgeTimeoutError`、…）と**ステータスコード**だけに基づいて 16 種類に分類し、それぞれについて次に何をすべきかの提案を与える。

順序は：まずクラス名、次にステータスコード。ステータスコードのうち、`410` は `not-found`、`422` は `precondition`、`504` は `timeout` に写像される —— これらの写像はどれも自明ではなく、だからこそ `scripts/check-catalog.mjs` の check 4 が C++ のソースに問い合わせて網羅性を保証している。

**分類の欠落が有害な理由**：フォールバックの `engine-error` は「パラメータは問題なく、エディタ自体が壊れている」と言う。だから未分類のコードはモデルをまったく誤った方向へ導く。最も明白な例が `422` —— 本当の意味は「入力は正当だったが何も書き込まれなかった」で、「エディタが壊れている」とは似ても似つかない。

---

## 5. サーキットブレーカーとレート制限

### ブレーカーはエディタを守る

`src/resilience/breaker.ts`。重要な決定：**4xx は `input` として記録され、ブレーカーは作動しない。**

理由：連続して 10 回の悪い呼び出しをするエージェントは、エディタを殺しているのではなく**働いている**のだ。繰り返される**トランスポート**の失敗だけが、エディタ自体が困っていることを意味する。

### レート制限は実際のバグを直した

スライディングウィンドウ式のリミッターは当初、**キューで最初の呼び出し手を即座に通していた** —— バーストの 2 番目の呼び出しが瞬時に通り、制限が何の役にも立たなかった。修正は `breaker.ts:schedule()` にある：最初の release は即座に発火せず、残りの間隔を待つ。

---

## 6. ログリング

エディタは `log.entry` をプッシュする（エディタ内での `ual.ForwardLogs 1` が必要で、これはこのプラグインがリモートで有効にできない）。

`bridge.ts` は容量 512 のリングを保持する：最小レベル（デフォルト `Display`）でフィルタし、重大度順に並べ、`sinceSeq` でページングし、カテゴリとテキストの絞り込みは大文字小文字を区別しない。

**なぜローカルでやるか**：すべてのログ行をそのままモデルに転送すれば、そのコンテキストが溺れてしまう。リングと絞り込みがあれば、エージェントはすべてを押し付けられる代わりに、必要な分だけ引き出せる。

---

## 7. 長時間処理：`ual_task`

プロトコルに**取り消しのセマンティクスはない**。`ual_task` は長い呼び出しを本物の DSH ジョブ（kind `ual`）に包むことで、会話を続行できるようにする。

ツール説明には 2 つのことを書いておかなければならない。さもないとモデルは必ず誤解する：

1. **ジョブを kill しても止まるのはこのプラグインの待機だけだ。** エンジンは動き続け、結果は依然として返ってくる。
2. **ブロッキングコマンドの実行中、エディタは何も返さない** —— `sequence.render_status` すらも。だから長時間タスクの実行中はポーリングしないこと。

---

## 8. ツール面：170 ではなく 12

170 個のコマンドがそれぞれ自分のツールだったら、170 個のスキーマがすべてのリクエストのプロンプトを食いつくす —— そしてリクエストの圧倒的多数はそのどれも使わない。

だから：

- `ual_tools` が機能を列挙する（ファミリーまたはキーワードで絞り込み可能）
- `ual_schema` が 1 コマンドの正確なキー名を与える
- `ual_call` が実行する

**機能の発見は 2 ステップかかる。0 ステップではない。** これは意図的なトレードオフだ：1 往復を余分に払う代わりに、リクエストごとのスキーマを 170 個減らす。

---

## 9. 生成ファイルと「誰も import しない表」

このプロジェクトで繰り返し現れる 1 つの欠陥クラスがあり、それ自体の説明に値する：**手で維持された表が作られるが、誰も import しない。**

これまでの事例：

| テーブル | 症状 |
|---|---|
| `REQUIRED_KEYS` | 必須キー検証が死んだコードになり、`ual_schema` が `REQUIRED:` を表示しなかった |
| `EXTRA_PARAM_KEYS` | 4 つの `PARAMS_UNRESOLVED` メソッドのパラメータリストが空だった |
| `UAL_CODES` | `410` / `422` / `504` が未分類で、誤解を招く `engine-error` にフォールバックしていた |

共通点：表そのものは正しく、ドキュメント化され、レビューも受けていた —— しかし実行時は別の経路を読んでいた。

対策は、各チェックが**表に聞く**のではなく**ソースに聞く**ようにすることだ：

- `check-catalog.mjs` check 3：すべての `requires` キーは C++ ソースに現れるリテラルでなければならない
- `check-catalog.mjs` check 4：`UAL_CODES` は C++ が実際に送るコードの集合と一致しなければならない（`FUAL_RegistryReady::Ensure` のような共通ゲートや、`Code = bOk ? 200 : 207` のような式形式も含む）
- `gen-docs.mjs --check`：コマンドリファレンスはカタログと一致しなければならない
- `i18n.test.ts`：ドキュメントが完全で内部整合的でなければならない —— 翻訳にとっては「リンクが解決し続ける」ことを意味し、アンカーは*翻訳された*見出しから導出されるため、静かに壊れる

言語セットは、この形の最新の事例だ。`gen-docs.mjs` と `tests/i18n.test.ts` はどちらもどの言語が存在するかを知る必要があり、それぞれが自分のコピーを持っていた間は、言語を 1 つ追加するたびに両方を手で探す必要があった —— そして、生成器が書くがテストが確認しない言語は、誰にも検証されない言語だ。`scripts/languages.mjs` が今や単一の情報源であり、両方から import される。

これらはすべて**自己正当化しない**チェックだ：ソースを壊しても表を壊しても、どちらかが落ちる。

---

## 10. 実際にあった 2 つの型安全性の罠

### `undefined` プロパティは爆発する

dsh-tools はツールの結果をディスパッチするとき、**2 段構え**のパイプラインを実行する：

1. `snapshotJsonValue(value)` —— **いずれかの**独自プロパティが `undefined` なら `value is not lossless JSON` を投げる
2. `validateJsonSchemaValue(schema, value)` —— スキーマに対して検証する

第 1 段はスキーマより厳しく、しかも**先に実行される**ので、スキーマだけを確かめるテストではこの種のバグを捕捉できない。

実際の症状：エディタが接続して `project.info` をプッシュする**直前の瞬間**、その `ual_status` レコードは `project: undefined` のようなキーを持っていた —— つまり「最初に読むあのツール」が、エディタが現れた瞬間に例外を投げていた。

修正は、`undefined` を書き込むのではなく条件付きスプレッドを使うことだ：

```ts
...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {})
```

### 出力スキーマはすべてのキーを宣言しなければならない

ツールの出力スキーマは `additionalProperties: false` を使い、レジストリはそれを**キー単位で**検証する。だから `ual_screenshot` が返す `attachment` はスキーマに宣言されなければならない —— さもないと、**スクリーンショットが成功した瞬間**に `ToolOutputError` を投げる。テキスト経路のほうは問題なく動くのに。

スキーマ言語には `ImageAttachmentRef` ノードがないので、宣言できるのは `{ type: 'json' }` だけだ。そうすると推論された型が `JsonValue` に広がるので、描画経路は `as` によるアサーションではなく**実行時ガード**で絞り戻さなければならない：

```ts
const attachment = imageRef(record.attachment)   // validates field by field
return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
```

コンパイラはここで安易な `as` を拒否する（TS2352: the two types do not sufficiently overlap）—— それは実行時のチェックを要求しているのであって、融通が利かないのではない。

---

## 11. 検証戦略

```bash
npm run check
```

これは以下と等価だ：

```bash
tsc -p tsconfig.json --noEmit      # src
tsc -p tsconfig.test.json          # tests (src's tsconfig does not include tests)
vitest run                         # 173 tests
node scripts/check-catalog.mjs     # 4 reconciliation checks
node scripts/gen-docs.mjs --check  # 9 言語のコマンドリファレンスが最新であること
node scripts/normalize-doc-headers.mjs --check   # 54 ファイルの言語バーが規造型であること
node scripts/normalize-doc-links.mjs --check     # 本文リンクがその位置から解決できること
npm run install:dsh -- --profile web    # このプラグインを dsh プロファイルに登録する
```

テストは 9 ファイルに分かれており、分け方は**それらが見つけられる欠陥の種類**だ：

| ファイル | 対象 |
|---|---|
| `protocol.test.ts` | `judge()` の契約、シリアライズ規則 |
| `translate.test.ts` | 全 16 種類の分類とヒント |
| `resilience.test.ts` | ブレーカーのステートマシン、レート制限のキューイング、`notifierFor` |
| `catalog.test.ts` | カタログ検索、プロトタイプチェーン保護、承認ゲートのエンドツーエンド |
| `bridge.test.ts` | 本物の WebSocket：キュー、タイムアウトによる孤立、イベント、シャットダウン |
| `tool-output.test.ts` | 全ツールの実際の戻り値を 2 段パイプラインに通す |
| `i18n.test.ts` | ドキュメントが完全で内部整合的であること、全 9 言語で |
| `end-to-end.test.ts` | 本物のゲートチェーン + 本物のソケット + 本物のツールスキーマ |
| `installer.test.ts` | DSH プロファイルインストーラ：引数の処理、2 つのマニフェスト項目、ミラーの境界、ロック時の拒否 |

**なぜ `end-to-end.test.ts` が必要か**：他のテストはどれも 1 つの層をスタブにしている。`REQUIRED_KEYS` のバグ —— 生成され、ドキュメント化され、レビューされ、そして import されなかった —— はどの単体テストにも捕捉されなかった。なぜなら各層は単体では自己矛盾がなかったからだ。本物のゲートチェーンを本物のソケットに配線し、本物のスキーマに与えてこそ、**層の間の継ぎ目**が露わになる。

同じ理由で、`tool-output.test.ts` は独自のスキーマチェックを書くのではなく、**本物の** `snapshotJsonValue` + `validateJsonSchemaValue` を使う —— さもないと `ual_status` の `undefined` 欠陥が同じようにすり抜けてしまう。

`i18n.test.ts` が存在するのも同じ理由で、ただし別の継ぎ目についてだ。`src/` の下のすべては `docs/` について何も知らないので、既存のどのテストも、言語切替バーに言語が 1 つ抜けていた翻訳や、改名した見出しに指していた翻訳に気づけなかった。このテストはドキュメントをデータとして読む：すべての言語に 5 つのファイルがあり、すべてのバーに 9 言語すべてが並び、ちょうど自分の言語だけが太字になり、すべての相対リンクが実際のファイルに解決し、すべての `#anchor` が実際の見出しに解決する。最後の 1 つが面白い —— アンカーは*翻訳された*見出しテキストから導出されるため、"Verification strategy" の言い回しを変えた翻訳者は、その節へのすべてのリンクを、どこにもエラーを出さずに静かに無効化してしまう。`gen-docs.mjs --check` は生成されたコマンドリファレンスを同じように守る。`i18n.test.ts` はレンダリングを再実装するのではなく、それにシェルアウトする。

---

## 12. 設定

`src/config.ts` の Schemastery スキーマは**デフォルト値の唯一の情報源**だ。`cordis.patch.yml` の `config` は、スキーマがすでに持っているデフォルトを単に書き写しているにすぎない。

**DSH の設定レイヤリングに注意**：後の層はその行の `config` をディープマージではなく**全体置き換え**する。任意のキーを上書きするには、残したいキーをすべて書き直す必要がある。

`allowDangerous` のようなスイッチは**意図的に存在しない** —— リスクのゲートは、プラグインが独自のバイパスを発明するのではなく、DSH ネイティブの `tools/pre-execute` の承認の継ぎ目を通る。

---

## 13. 任意依存での縮退

`cordis.patch.yml` が宣言するハードな依存は 1 つだけ：`tools` レジストリ（`inject` 経由）。それ以外はすべて `ctx.get` 経由で読み取られる：

| サービス | 欠けている場合 |
|---|---|
| `jobs` | `ual_task` は `kind:'background'` を返し、利用できない旨を説明する |
| `fs` / `attachments` | スクリーンショットがテキスト経路に縮退し、理由を返す |
| `agents` | エディタの接続 / 切断をエージェントに通知しない |
| `approval` | `ask` は DSH によって拒否に変えられる |

こうすることで、1 つのサービスを欠いた構成は、読み込みに失敗するのではなく**1 つの機能を失う**だけで済む。

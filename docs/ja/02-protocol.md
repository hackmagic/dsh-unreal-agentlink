<div align="center">

[English](../02-protocol.md) · [简体中文](../zh/02-protocol.md) · [繁體中文](../zh-TW/02-protocol.md) · **日本語** · [한국어](../ko/02-protocol.md) · [Deutsch](../de/02-protocol.md) · [Español](../es/02-protocol.md) · [Français](../fr/02-protocol.md) · [Русский](../ru/02-protocol.md)

[README](../readme/README_ja.md) · [チュートリアル](01-tutorial.md) · **プロトコル** · [アーキテクチャ](03-architecture.md) · [コマンドリファレンス](command-reference.md)

</div>

# プロトコルリファレンス

UnrealAgentLink の通信プロトコル。このプラグインは**サーバー**、Unreal Editor は**クライアント**だ。

ここにある結論はすべて `.ua-ref/plugin/UnrealAgentLink/Source/UnrealAgentLink/` の C++ から来ており、要点となる箇所にはファイルと行番号の参照が付いている。

---

## 1. 接続

| 項目 | 値 | 根拠 |
|---|---|---|
| 方向 | UE 側がダイヤルアウトする | `Network/UAL_NetworkManager.cpp:77` `CreateWebSocket(TargetUrl)` |
| デフォルトアドレス | `ws://127.0.0.1:17860` | `Core/UnrealAgentLink.cpp:88` |
| 変更方法 | コマンドライン `-UALServer=ws://host:port` | `Core/UnrealAgentLink.cpp:90` |
| 認証 | **なし** —— トークンもヘッダーもサブプロトコルもない | `CreateWebSocket` は URL しか取らない |
| 再接続 | 固定 5 秒周期、バックオフなし | `Network/UAL_NetworkManager.cpp:116` |
| 接続停滞対策 | あり（`ConnectTimeoutSeconds`） | `Network/UAL_NetworkManager.cpp:145-155` |

このプラグインは 17860 を `maxPayload` 64 MB で待ち受ける。

### オリジンチェック

受け付けるのはループバックのオリジンのみ（`127.*`、`::1`、`::ffff:127.*`）。設定された `host` が**意図的に** `127.0.0.1` / `localhost` 以外に設定された場合にのみ、これが緩められる。理由は「認証がない」ことにある —— ポートこそが資格情報なのだ。

### ハンドシェイク

**ハンドシェイクはない。** エディタは接続直後に `project.info` をプッシュし、このプラグインはそれを以て識別済み（`editor-identified`）とマークする。それが届く前は「接続済みだが未識別」の状態 —— `ual_status` におけるそのようなレコードには `sessionId` / `connectedAt` / `lastSeenAt` / `heartbeats` / `stale` しかなく、`project` などは含まれない。

---

## 2. メッセージ構造

```
UE → plugin:  { ver:"1.0", type:"req",  method, id, params }
plugin → UE:  { ver:"1.0", type:"res",  id, code, result }
UE → plugin:  { ver:"1.0", type:"evt",  method, payload }
```

### `req`（このプラグイン → エディタ）

| フィールド | 備考 |
|---|---|
| `ver` | 常に `"1.0"` |
| `type` | `"req"` |
| `method` | コマンド名。例：`actor.get_info` |
| `id` | **サーバー**が生成。形式は `dsh-<uuid>` |
| `params` | 任意。**空の場合はキー全体が省略される**。`null` では送られない |

`id` は空であってはならない：`SendResponse` の最初の行は `if (RequestId.IsEmpty()) { return; }`（`Utils/UAL_CommandUtils.cpp:2503-2506`）—— **id のないリクエストには決して返信が来ない**。

エディタ側の解析（`Commands/UAL_CommandHandler.cpp:87-94`）はまず `params` を読み、無ければ旧フィールドの `payload` にフォールバックする。このプラグインは `params` だけを送る。

### `res`（エディタ → このプラグイン）

| フィールド | 備考 |
|---|---|
| `ver` | `"1.0"` |
| `type` | `"res"` |
| `id` | リクエストの `id` をエコー。突き合わせに使う |
| `code` | **数値**。文字列ではない |
| `result` | 任意。**内容がない場合はキー全体が省略される** |

この省略のロジックは `Utils/UAL_CommandUtils.cpp:2513-2516` にある：`result` は `Data.IsValid()` のときだけ書き込まれる。

エディタ側の応答本体の解析（`Commands/UAL_CommandHandler.cpp:98-104`）は `result` → `data` → `payload` の順に試す。このプラグインが送るのは `result`。

### `evt`（エディタ → このプラグイン、一方通行のプッシュ）

| フィールド | 備考 |
|---|---|
| `ver` | `SendEvent` 経由で送信されるイベントの場合は存在する。**コンテンツブラウザ拡張からのインポートイベントには付かない** |
| `type` | `"evt"` |
| `method` | イベント名 |
| `payload` | 任意 |
| `id` | **存在しない** —— イベントには返信できない |

---

## 3. 失敗の表現方法

**`code` だけによる。** メッセージにエンベロープレベルの `error` フィールドは**存在しない**。

| コード | 意味 | このプラグインの kind |
|---|---|---|
| `200` | 成功 | — |
| `207` | 部分成功 | `partial: true` |
| `400` | パラメータが欠けているか型が違う | `bad-params` |
| `404` | そのようなメソッドまたはアセットは存在しない | `not-found` |
| `409` | 競合（例：排他的なプロファイラが既に実行中） | `conflict` |
| `410` | 削除済み | `not-found` |
| `412` | 事前条件未達 | `precondition` |
| `413` | 上限超過（例：cvar の上限を超えるバッチ作成） | `precondition` |
| `422` | 入力は正当だが何も書き込まれなかった | `precondition` |
| `500` | エディタ内部エラー | `engine-error` |
| `501` | このバージョンでは非対応 | `unsupported` |
| `503` | アセットレジストリがまだスキャン中 | `registry-busy` |
| `504` | エディタ側のタイムアウト | `timeout` |

`0` は**決して使われない**。

この 13 個のコードは `protocol/types.ts` で `UAL_CODES` として定義されており、`scripts/check-catalog.mjs` の check 4 が C++ のソースに直接問い合わせて照合する —— `FUAL_RegistryReady::Ensure` のような共通ゲートが出す 503 や、`Code = bOk ? 200 : 207` のような式形式も含めて。1 つでも欠けていたり余分だったりすると、このチェックは落ちる。

### エラーテキストの置き場所

```
result.message   ← for humans, Chinese or English by editor culture, never parse it
result.details   ← for machines (suggestions / expected_type / registry progress)
```

`SendError` は `{message: ...}` を組み立て、4 引数のオーバーロードは `details` も付加する（`Utils/UAL_CommandUtils.cpp:2525-2539`）。

### 200 でも失敗になりうる

**最も落ちやすい罠だ。** 多くのハンドラは `result.ok === false` とともに `200` を返す：

- `editor.undo` —— 取り消すものがないとき
- `blueprint.compile` —— コンパイルにエラーがあるとき
- `pie.observe` —— 観測に失敗したとき

だからこのプラグインは code だけではなく `judge(result, code)` で成否を判定する：

| 状況 | 判定 |
|---|---|
| `code === 200`、`result.ok !== false`、`result.error` が空 | 成功 |
| `code === 207` | 成功。ただし `partial: true` |
| `result.ok === false` | **失敗** |
| `result.error` が空でない文字列 | **失敗** |
| `result` がオブジェクトでない（または存在しない） | code で判定する。推測しない |

この規則は**必須**だ：C++ の 14 ファイルに 55 箇所の `SetStringField(TEXT("error"), ...)` がある。言い換えれば「空でない error を伴う 200」は異常ではなく常態なのだ。

---

## 4. イベント

| イベント | 発生条件 | ペイロード |
|---|---|---|
| `project.info` | 接続直後。ハンドシェイクの代わり | プロジェクト名、パス、エンジンバージョン、プラグインバージョン、実行モード、現在のレベル、Python の有無など |
| `project.closed` | エディタがプロジェクトを閉じた | — |
| `system.heartbeat` | 10 秒ごと | `{}`（**常に存在する**。省略されない） |
| `log.entry` | UE のログ出力（cvar `ual.ForwardLogs 1` が必要） | `text` / `category` / `level` |
| `content.import_folder` | ユーザーがコンテンツブラウザのコンテキストメニューから「import to UnrealBox asset library」を選んだ | `paths` / `real_paths` / `asset_metadata` |
| `content.import_assets` | 上記と同じ。レベルビューポートから開始した場合 | `asset_paths` / `asset_real_paths` / `asset_metadata` |

### ハートビートとエディタの死亡判定

ハートビートは**独立した 10 秒周期のティッカー**（`Network/UAL_NetworkManager.cpp:173`）で、5 秒周期の再接続とは無関係だ。このプラグインはハートビートが **45 秒** 途絶えたエディタを `stale` とマークする —— フロントエンドと揃えた値だ（`Network/UAL_NetworkManager.cpp:172`）。

### 2 つのインポートイベントは送りっぱなし

これらは**`id` を持たず**、エディタも**返信を待たない**。エディタ側の `Handle_Response`（`Commands/UAL_CommandHandler.cpp:185-297`）は `type:"res"` を受け取ったときだけ Slate 通知をポップし、`ok` / `count` / `importedPath` / `error` を読む。

このプラグインはアセットをインポートする能力を持たない純粋なブリッジなので、イベントを**ログとエージェント通知**に変換し、**偽の `res` を作らない** —— `ok:false` で返してもユーザーには誤った「インポートに失敗しました」ダイアログが見えるだけで、沈黙より悪い。

---

## 5. シリアライズ規則

送信パラメータは通信に乗る前に `protocol/serialization.ts` の `toSerializable()` を通る。これは `JSON.stringify` よりも厳格だ。なぜなら **UE は読めないフィールドを「送られなかった」と扱う** —— 何もせず黙るほうが、エラーよりも診断しにくいからだ。

| 入力 | 扱い |
|---|---|
| `null` / boolean / string | そのまま |
| 有限の number | そのまま |
| **非有限の number**（`NaN` / `Infinity`） | **スローされる** —— UE は「フィールドが存在しない」と読む |
| `undefined`（トップレベル、または配列の中） | **スローされる** |
| `undefined`（オブジェクトのプロパティ値として） | **キーが削除される** |
| function / symbol / bigint | **スローされる** |
| 循環参照 | **スローされる** |
| `Uint8Array` | base64 文字列に変換 |
| `Date` | ISO 文字列に変換 |
| `Map`（キーは文字列でなければならない） | プレーンオブジェクトに変換 |
| `Set` | 配列に変換 |
| その他の非プレーンオブジェクト（クラスのインスタンスなど） | **スローされる** |

通れるのはプレーンオブジェクト、配列、JSON スカラーだけだ。

---

## 6. タイミングと並行性

**1 つのエディタに対するコマンドは直列だ。** このプラグインはエディタごとに 1 つの送信キューを保ち、各コマンドを直前のコマンドの `then` につないでいく。これはプロトコルを満たすためではなく —— エディタがどうせゲームスレッド上で同期的に完了まで実行するからだ。

**キューはエディタ間で独立している。** 複数のエディタが接続したとき、それぞれが自分のキューを持つ。

### タイムアウト

デフォルトは 180 秒で、ブロッキング系コマンドは各自で下限を引き上げる（`ual_schema` のタイムアウト列が "blocking" と印を付ける）。

**タイムアウトはコマンドが実行されなかったことを意味しない。** 意味するのは「このプラグインが待つことをやめた」ことだけだ。そうなったとき：

1. そのエディタは孤立コマンドを持つとマークされる（`ual_status` の `orphaned`）。
2. その後そのエディタへの**短いコマンドは即座に拒否される**（`queue-stalled`）。二度と返らないかもしれない処理の後ろに並ばせる代わりに。
3. `long: true` の呼び出しは依然として送れる —— これが「待つ用意がある」という意思表示だ。

**中断された呼び出しも同じだ**：`ual_task` のジョブを kill するのはアボート経由で行われ、アボートはこのプラグインの待機だけを止め、エンジンは動き続ける。だからアボートも孤立を記録する。

### 切断

エディタが切断したとき、そのエディタに対する実行中のすべてのリクエストは `editor-lost` で失敗し、そのエラーにはすべてのメソッド名が載る。

---

## 7. このプラグインが送らないもの

境界を明確にするために：

- **トークンなし** —— 認証機構は存在しない。
- **`GET /api/ual/action` なし** —— 古いドキュメントはこれを HTTP サービスだと説明していたが、それは誤り。
- **タスクのポーリングなし** —— `query_task` / `cancel_task` は存在しない。
- **偽の `res` なし** —— インポートイベントの節を参照。
- **エディタへの能動的な再接続なし** —— 向きが逆なので、エディタが自分で 5 秒ごとにリトライする。

---

## 8. 関連ファイル

| ファイル | 内容 |
|---|---|
| `src/protocol/types.ts` | メッセージ型、`UAL_CODES`、`UalError` |
| `src/protocol/bridge.ts` | WebSocket サーバー、キュー、タイムアウト、孤立コマンド、ログリング |
| `src/protocol/serialization.ts` | 上の表のシリアライズ規則のすべて |
| `src/service.ts` | `judge()`、ゲートチェーン、台帳 |
| `src/errors/translate.ts` | ステータスコード / クラス名 → 16 種類 |

C++ 側の対応物：`Utils/UAL_CommandUtils.cpp`（`SendResponse` / `SendError` / `SendEvent`）、`Commands/UAL_CommandHandler.cpp`（インバウンドのディスパッチ）、`Network/UAL_NetworkManager.cpp`（接続、ハートビート、再接続）。

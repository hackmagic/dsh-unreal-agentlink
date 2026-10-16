<div align="center">

[English](../INSTALL-ai.md) · [简体中文](../zh/INSTALL-ai.md) · [繁體中文](../zh-TW/INSTALL-ai.md) · **日本語** · [한국어](../ko/INSTALL-ai.md) · [Deutsch](../de/INSTALL-ai.md) · [Español](../es/INSTALL-ai.md) · [Français](../fr/INSTALL-ai.md) · [Русский](../ru/INSTALL-ai.md)

[README](../readme/README_ja.md) · [チュートリアル](01-tutorial.md) · [プロトコル](02-protocol.md) · [アーキテクチャ](03-architecture.md) · [コマンドリファレンス](command-reference.md) · **インストールガイド**

</div>

# インストール（AI 可読版）

このファイルは、ファイルを読んで手順を順番に実行する AI アシスタントのために書かれている。
手順を飛ばさないこと。すべてのステップには検証可能な結果がある。人間向けのインストールは
[README](../readme/README_ja.md) または [チュートリアル](01-tutorial.md) を参照。

> AI が実行しなければならないのは `scripts/install-dsh-plugin.mjs` だけだ。このスクリプトが
> すべてを行う：ミラー → profile manifest の編集 → 本当のインストーラの呼び出し →
> 合成結果の検証。以下の各ステップは**検証ポイント**だ：ステップが一致しなければ、
> 立ち止まって報告すること。続行してはならない。

---

## 0. まず確認する（読み取りのみ。何もインストールしない）

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

`installed copy:` と `bundle layer:` は `present` / `listed` と読めるはずだ。
`(absent)` / `(not listed)` と読める場合にだけ、インストールを実行する必要がある。

次に UnrealAgentLink 側を確認する：

- `Plugins/UnrealAgentLink/` がプロジェクト内に存在し、`Edit → Plugins` で有効になっている
  こと（エディタの再起動が必要）。
- ポート 17860 が空いていること（`uebox` デスクトップが同じポートを要求する。このプラグインは
  それを必要としない）。

---

## 1. インストール（1 つのコマンド）

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

スクリプトは 5 つの動作を行い、それぞれが痕跡を残す：

| ステップ | 痕跡 | 失敗したときの意味 |
| --- | --- | --- |
| ビルド | `lib/`、64 files | 先に `npm run check` を実行すること。壊れたビルドをインストールしてはならない |
| ミラー | `files` エントリだけを含む `<profile>/.vendor/` | ディスクまたは権限の問題 |
| manifest の編集 | `<profile>/package.json` に 1 行の dependency と 1 行の bundle が追加される | §4 を参照 |
| インストーラ | pnpm が `Done in Xs` と出力する | §2 を参照 |
| 検証 | `install: ... is now a bundle layer of profile "web"` | §3 を参照 |

**最後の行だけがインストールの成功を意味する。** 最初の 4 ステップが通り 5 番目が失敗した場合、
layer は合成されておらず、dsh はこのプラグインを読み込まない。

---

## 2. インストーラが拒否した場合（バージョンガード）

dsh には製品レベルのガードがある：プラグインの `peerDependencies` がランタイムの dsh バージョンと
非互換なとき、インストールは拒否される。このプロジェクトは `@deepseek-ai/*` を
`0.1.6-alpha.2` に固定しているが、同梱の dsh は `0.2.0-rc.2` なので、インストールはここで止まる。

**それは製品の決定であり、スクリプトは意図的にあなたの代わりにそれをしない。**
正確なコマンドが出力される：

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

それを実行するには人間の確認が必要だ。その後、§1 からインストールを再実行する。

> `--status` の `version guard:` 行を見れば、免除がすでに有効かどうかが分かる。

---

## 3. 検証ステップが失敗した場合（layer が合成されていない）

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

これは次を出力しなければならない：

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

出力されないときの、既知の原因は 3 つ：

1. `dsh.profile.bundles` がこのプラグインを列挙していない —— スクリプトが追加したはずだ。
   `<profile>/package.json` を確認すること。
2. パッケージは `node_modules` にあるが `dsh.bundle` を宣言していない —— これは読み込み時に
   **大声で失敗する**（`declares no dsh.bundle in its package.json`）。ミラーされた
   `package.json` を確認すること。
3. `--dump-config` 自体がエラーになる —— 出力を逐語的に報告すること。推測してはならない。

---

## 4. manifest の編集をロックで拒否された場合

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh は profile manifest を `wx` で作成された `.lock` 兄弟ファイルで保護しており、
**競合者は他の保持者のロックを決して削除しない**。保持者は動作中の dsh アプリケーション自体だ。

- `web` profile の場合：動作中の DeepSeek Harness デスクトップアプリを閉じるか、
  保持されていない profile を選ぶ。
- `desktop` profile の場合：CLI の*起動*コマンドは**禁止されている**
  （`bin.js:112` `rejectElectronProfile`）。だが `dsh plugin --profile desktop …` は
  意図的に除外されている（`bin.js:119`）—— アプリ自身が呼び出す Desktop 同梱の CLI が
  使う経路がこれだ。製品はアプリを先に完全に終了することを求める。動作中のアプリは
  自身のプラグイン一覧から manifest を書き戻すからだ。終了してからインストールを実行し、
  あとで Desktop を起動して layer をマウントする。
- スクリプトは拒否して保持者を名指しする。ロックとは戦わない。

---

## 5. プラグインが実際に動くことを検証する（インストールされただけでは不十分）

```bash
# a) エディタ側：プロジェクトを開く。UE のログに接続が表示されるはずだ。
#    （UnrealAgentLink は 5 秒ごとにリトライする。手動での接続は不要。）

# b) DSH 側：セッション内でエージェントに「ual_status でエディタを確認して」と依頼する。
```

`ual_status` の 3 つのフィールドが受け入れ基準だ：

| フィールド | 期待値 |
| --- | --- |
| `listening` | `true` |
| `editors` | `project` 名を持つものが少なくとも 1 つ |
| `orphanedMethods` | `[]` |

`listening: false` = 何も待ち受けていない（プラグインが読み込まれていないか、ポートが埋まっている）。
`editors: []` = UE が接続しなかった（プロジェクトが閉じている、プラグインが無効、またはポートの不一致）。
`orphanedMethods` が空でない = リクエストはタイムアウトしたがまだ実行中の可能性がある。
再試行する前に `ual_logs` を確認すること。

そして 1 つの最小コマンドで経路全体を確認する：

```bash
# セッション内で：ual_call { "method": "level.get_current" }
```

---

## 6. アンインストール

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

スクリプトは dependency と bundle エントリの両方を削除し、その後で本当のインストーラを実行して
pnpm に `node_modules` を同期させる。ミラーディレクトリ `<profile>/.vendor` は保持され、
次のインストールで再構築される。完全に消したい場合は手動で削除すること。

---

## AI のための硬い規則

1. インストールを通すためにこのプロジェクトの `peerDependencies` を編集**しないこと** ——
   それは実際のバージョン非互換を隠してしまう。
2. `<profile>/package.json` を手で編集**しないこと**。スクリプトがそれを扱い、ロックも確認する。
3. `--accept-risk` を自動的に実行できるものとして扱わ**ないこと**。人間の確認が必要だ。
4. いずれかのステップの出力が記述と異なる場合、**立ち止まって出力を逐語的に報告すること**。
   「修正してから再実行」はしないこと。
5. ここにあるすべてのステップは、読み取り専用コマンドで再検証できる
   （`--status`、`--dump-config`、`ual_status`）。

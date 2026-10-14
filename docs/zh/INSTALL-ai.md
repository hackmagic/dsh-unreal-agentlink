# 安装插件（AI 可读版）

本文件写给「会读文件并按步骤执行的 AI 助手」：按顺序执行，不要跳步，每一步都有可验证的结果。
人类安装请看 [README](../../README.md) 或 [教程](01-tutorial.md)。

> 本文件是「让 AI 装」的入口。AI 只需要执行 `scripts/install-dsh-plugin.mjs`，
> 该脚本会完成：镜像 → 改 profile manifest → 调真正的安装器 → 验证合成结果。
> 下面每一步都是**验证点**，任何一步不通过就停下报告，不要继续。

---

## 0. 先确认两件事（只读，不安装）

```bash
node scripts/install-dsh-plugin.mjs --profile web --status
```

期望输出里 `installed copy:` 与 `bundle layer:` 至少有一个是 `present` / `listed`；
若显示 `(absent)` / `(not listed)`，才需要执行安装。

再确认 UnrealAgentLink 侧：

- 工程里存在 `Plugins/UnrealAgentLink/`，且 `Edit → Plugins` 中已启用（需要重启编辑器）。
- 默认端口 17860 未被占用（`uebox` 桌面端会抢同一个端口；本插件不需要它）。

---

## 1. 安装（一条命令）

```bash
npm run build && node scripts/install-dsh-plugin.mjs --profile web --yes
```

脚本依次做五件事，每件都有产物可查：

| 步骤 | 产物 | 失败时的含义 |
| --- | --- | --- |
| 构建 | `lib/` 64 个文件 | 先跑 `npm run check`，不要带病安装 |
| 镜像 | `<profile>/.vendor/` 只含 `files` 字段声明的条目 | 磁盘/权限问题 |
| 改 manifest | `<profile>/package.json` 多出 1 行 dependency + 1 行 bundle | 见第 4 节 |
| 调安装器 | pnpm 输出 `Done in Xs` | 见第 2 节 |
| 验证 | `install: ... is now a bundle layer of profile "web"` | 见第 3 节 |

**只有最后一行出现，才算装好。** 前面四步都成功但第五步失败，说明 layer 没合成，
dsh 启动时不会加载本插件。

---

## 2. 如果安装器拒绝了（版本守卫）

dsh 有一个产品级守卫：插件的 peerDependencies 与运行时的 dsh 版本不兼容时拒绝安装。
本项目锁定 `@deepseek-ai/*` 的 `0.1.6-alpha.2`，而当前 dsh 是 `0.2.0-rc.2`，所以会在这里停。

**这是产品决策，不是脚本能替你决定的。** 命令会原样印出来：

```bash
dsh plugin --profile web allow-version dsh-unreal-agentlink@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

执行它需要人类确认（脚本故意不自动批准）。之后再跑一次第 1 节的安装命令。

> `--status` 的 `version guard:` 一行会告诉你豁免是否已生效。

---

## 3. 如果第五步失败（layer 没合成）

```bash
dsh --profile web --dump-config | grep unreal-agentlink
```

必须看到：

```
# == dsh-unreal-agentlink
- id: unreal-agentlink
  name: dsh-unreal-agentlink
```

看不到时的三种已知原因：

1. `dsh.profile.bundles` 里没有本插件名 → 脚本应该已经加上，检查 `<profile>/package.json`。
2. 包在 `node_modules` 里但 `package.json` 没有声明 `dsh.bundle` → 加载时会**大声失败**
   （`declares no dsh.bundle in its package.json`），检查镜像里的 `package.json`。
3. `--dump-config` 本身报错 → 把完整输出原样报告，不要猜。

---

## 4. 如果改 manifest 被锁拒绝

```
install: <path>/package.json.lock is held by pid 18344 (DeepSeek Harness)
```

dsh 用 `wx` 创建的 `.lock` 兄弟文件保护 profile manifest，**竞争者永不删除别人的锁**。
持有者就是正在运行的 dsh 应用本身。

- 装到 `web` profile：关闭正在跑的 DeepSeek Harness 桌面应用，或换一个没被占用的 profile。
- 装到 `desktop` profile：**CLI 禁止**（`bin.js:38 rejectElectronProfile`），
  只能由 Electron 应用自己管理，或者关掉应用后手动改。
- 脚本会原样拒绝并告诉你持锁进程，不会去抢锁。

---

## 5. 验证插件真的在工作（不是装上了就算）

```bash
# a) 编辑器侧：打开工程，UE 输出日志应出现连接成功
#    （UnrealAgentLink 每 5 秒重试一次，不需要手动连）

# b) DSH 侧：在会话里问 agent「用 ual_status 看一下编辑器状态」
```

`ual_status` 的三个字段就是验收标准：

| 字段 | 期望 |
| --- | --- |
| `listening` | `true` |
| `editors` | 至少一个，带 `project` 名 |
| `orphanedMethods` | `[]` |

`listening: false` = 端口没监听（插件没加载或端口被占）。
`editors: []` = UE 侧没连上（工程没开、插件没启用、或端口不一致）。
`orphanedMethods` 非空 = 有请求超时后仍在跑，先 `ual_logs` 看结果再重试。

然后跑一条最小命令确认全链路：

```bash
# 在会话里：ual_call { "method": "level.get_current" }
```

---

## 6. 卸载

```bash
node scripts/install-dsh-plugin.mjs --profile web --remove --yes
```

脚本移除 dependency 与 bundle 两处登记，再跑一次真正的安装器让 pnpm 同步 `node_modules`。
镜像目录 `<profile>/.vendor` 会保留（下次安装会重建），需要干净就手动删。

---

## 给 AI 的硬性规则

1. **不要**为了让安装通过而修改本项目的 `peerDependencies`——那会让真实的版本不兼容被掩盖。
2. **不要**手动编辑 `<profile>/package.json`；脚本会做，且它检查锁。
3. **不要**把 `--accept-risk` 当成可以自动执行的步骤，它需要人类确认。
4. 任何一步的输出和预期不符，**停下来原样报告输出**，不要尝试「修一下再跑」。
5. 本文件描述的每一步都可以用只读命令复核（`--status`、`--dump-config`、`ual_status`）。

# dsh-notify-long

简体中文 | [English](README.md)

[![npm](https://img.shields.io/npm/v/dsh-notify-long?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-notify-long)
[![release](https://img.shields.io/github/v/release/ddxl123/dsh-notify-long?label=release&color=blue)](https://github.com/ddxl123/dsh-notify-long/releases)
[![test](https://img.shields.io/badge/tests-186%20passing-brightgreen)](https://github.com/ddxl123/dsh-notify-long)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装上一双"耳朵"和一部"电话"：**任务做完、出错、需要你回答问题时，用系统提示音、桌面横幅和邮件提醒你**，不用一直盯着终端。

```
任务完成  →  🔔 系统提示音 + 桌面横幅 + 邮件「已完成：xxx」
需要选择  →  🔔 另一种提示音 + 邮件「需要你的输入：用哪个数据库？」
执行出错  →  🔔 警示音 + 邮件「错误：模型路由失败 …」
模型重试  →  🔔 提醒音 + 邮件「模型请求重试：xxx」
等待授权  →  🔔 提示音 + 邮件「需要授权：bash」
```

- **零运行时依赖**：只用 Node 内置模块，SMTP 客户端自己实现，不需要 `nodemailer`。
- **零构建步骤**：纯 JavaScript ESM，npm 直装，或者 `git clone` 后装进 profile。
- **不会丢提醒**：每次提醒先落盘（durable outbox）再发送，失败自动退避重试；进程重启后继续投递。
- **不吵人**：同类事件去重、报错按指纹冷却、提示音突发合并、可设置免打扰时段（免打扰时只发邮件）。
- **可控**：通道路由、邮箱和提醒语言都声明为 `.volatile()`，所以插件的页面可以在 harness 运行期间直接改，下一条提醒就用新值；不用重启，也不用重新挂载。
- **配置简单**：界面卡片只问「QQ 邮箱地址 + 授权码」，服务器、发件人、收件人都由它推出来。
- **看得见结果**：同一张卡片带日志面板，每次投递、抑制、重试和插件日志都在里面，还有「发送测试」按钮。

---

## 目录

- [安装](#安装)
- [配置](#配置)
  - [1. 在界面里配置（推荐）](#1-在界面里配置推荐)
  - [2. 手工配置：写入 profile patch](#2-手工配置写入-profile-patch)
  - [3. 密码放在哪里](#3-密码放在哪里)
  - [4. 生效与自检](#4-生效与自检)
  - [5. 免打扰与事件开关](#5-免打扰与事件开关)
- [卡片里的日志面板](#卡片里的日志面板)
- [提醒是怎么触发的](#提醒是怎么触发的)
- [模型可用的工具](#模型可用的工具)
- [完整配置参考](#完整配置参考)
- [常见问题](#常见问题)
- [开发](#开发)
- [设计取舍](#设计取舍)

---

## 安装

前提：Node.js ≥ 20.11，已经能运行 `dsh`（本插件用的是 web profile，也就是你现在的界面）。

> 已发布到 npm：[`dsh-notify-long`](https://www.npmjs.com/package/dsh-notify-long)，同时也在 GitHub 上以源码分发。

本包在 `package.json` 里声明了 `dsh.bundle.patch`，所以它和别的 profile 插件一样安装：

```bash
dsh plugin --profile web add dsh-notify-long
```

安装到此为止：没有构建步骤，也没有运行时依赖。插件 import 的两个包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）是 dsh 自带的，由启动器的 profile 解析从**正在运行的安装**里供给，所以不需要在仓库里额外链任何东西——理由见下方「harness peer 依赖」。

想直接改源码的话，改成克隆本仓库、再添加路径（`link:` 装法，安装命令完全一样）：

```bash
git clone https://github.com/ddxl123/dsh-notify-long.git
cd dsh-notify-long
dsh plugin --profile web add .
```

`dsh plugin` 会在 profile 目录里跑 pnpm，然后把这个包追加进 `dsh.profile.bundles`；
正是这一步让本仓库的 `cordis.patch.yml` 成为该 profile 的一层，从而插入插件条目。
全程不改任何 profile 文件，所以重复安装不会有任何变化。

然后**重启 profile**：

```bash
dsh --profile web
```

> 是重启，不是热加载：`cordis.patch.yml` 本身是热加载的，但新插件的**包**需要进程重新 import 才能注册工具，所以第一次安装要重启一次；之后改配置不用重启。

卸载就是把依赖去掉，这一层也随之消失：

```bash
dsh plugin --profile web remove dsh-notify-long
```

> **`add .` 指的是本仓库。** `dsh plugin` 把相对路径锚定在你执行命令的目录上，所以它解析到的是仓库而不是 profile；绝对路径效果完全相同：
> `dsh plugin --profile web add /path/to/dsh-notify-long`。
>
> 其它 profile（`headless` 等）：把 `--profile web` 换成对应名字即可。`node scripts/install.mjs` 就是这条命令的包装；加 `--dry-run` 先看要做什么，`--uninstall` 反向卸载。

### harness peer 依赖

`@deepseek-ai/schemastery`（组合条目的配置 schema）和 `@deepseek-ai/dsh-tools`（`defineTool`）是**随 dsh 一起发布的包**：它们属于运行中的 harness，不属于本包。插件对它们做**静态 import**，并在 `package.json` 的 `peerDependencies` 里声明——这正是官方契约，也是解析能成立的原因：

- 启动器在 profile 装载前算出一张**唯一的运行期解析表**（安装锚点 + 有序 bundle 的依赖图），并把 `@deepseek-ai/*` 这些名字登记在案；
- 一个被 `link:` 到 profile 的外部目录是 **linked root**，从它里面发出的导入走「peer 感知的祖先查找」：在每一级 `D/node_modules` 位置，只要 `D/package.json` 的 `peerDependencies` 里有这个名字，Node 的查找就被**路由到运行期那份拷贝**（D 就是本包根目录，所以本包声明的 peer 生效）；
- 因此**不需要**在本仓库里链软链，也不该链：物理副本的优先级高于 peer 声明，链进去反而会遮蔽运行期那份，并跟着 app 升级而失配；
- 应用自有的 profile（例如 Electron 桌面端的 `desktop`）用同一套解析，且解析不会改动你的 `node_modules`。

`peerDependencies` 同时也是 dsh 的兼容性检查入口：装载前它会拿 `@deepseek-ai/dsh-*` 的声明范围去比对运行版本，不匹配的 bundle 会被跳过。上游文档：`@deepseek-ai/dsh-app-boot` 的 README（"Linked directories"、"One runtime resolution"、"Application-owned profiles"）。

**唯一需要 `scripts/link-harness-deps.mjs` 的场合是跑本仓库的测试**：`node --test` 是普通 Node 进程，没有 profile 解析，所以需要把 peer 物化到源码旁边：

```bash
node scripts/link-harness-deps.mjs                        # 自动寻找你的 dsh 安装
node scripts/link-harness-deps.mjs --from /path/to/node_modules
```

反复执行是安全的，已经能解析时会直接告诉你无需处理。同一条命令还会链上只有测试会导入的 **devDependencies**：`@deepseek-ai/dsh-settings`（设置契约测试）、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-user-questions`（集成测试：把真实插件分别挂到真实 Connection 服务与真实提问服务上）、`@deepseek-ai/dsh-llm-retry`（重试契约测试）。运行时这些服务由 harness 注入，插件代码本身从不导入它们。

插件不声明对自带包的 `dependencies`，也没有任何降级分支：解析不到 peer 就是安装坏了，那一行会被明确报出来，而不是带着半个插件继续跑。

## 配置

配置有三层，越靠后优先级越高：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 组合条目 | 本包 `cordis.patch.yml` 里的那一行，可从 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖 | 装机时的默认值 |
| 实时配置条目 | `~/.dsh/profiles/web/cordis.patch.yml` 里 `dsh-notify-long` 那一行的 `config`，由设置页面写入 | 日常调整，保存即生效 |
| 环境变量 | `DSH_SMTP_PASSWORD` 等 | 只放密钥 |

### 1. 在界面里配置（推荐）

插件带浏览器端，所以它的页面直接出现在你正在使用的界面里：

**侧边栏的 Plugins 页面** → **QQ 邮箱通知**（这个页面每个可配置插件列一条；条目和表单都跟随界面语言）。

表单只问三件事 —— **QQ 邮箱地址**、**授权码**、（可选的）**收件人** —— 因为这已经是全部配置：

- 填了地址就等于选了 QQ 邮箱预设（`smtp.qq.com:465`，隐式 TLS），同时它就是发件人；
- 收件人留空表示「发给自己」，邮件就发到上面那个地址；
- 只填 QQ 号也可以，会自动补成 `<号码>@qq.com`。

点**保存**写入的是当前 profile 补丁里本插件自己那一行的 `config` —— 走的是配置编辑器带版本号的写入通道 —— 也就是说，它和下面 YAML 手写时改的是同一份文档，两种方式都不需要重启。其余字段（服务器、端口、加密方式、证书校验、抄送、主题前缀、密码环境变量/命令）都还在，收在表单底部折叠的**高级设置**里。

两点需要注意：

- 卡片是**先暂存、再保存**：输入过程中不会立即落盘；
- 授权码是**只写**字段：主机从不把 `role('secret')` 的值发给浏览器，所以这一栏永远显示为空，只有你输入了内容才会写入，并用旁路信息显示「已配置 / 未配置」；**清除授权码**会删掉已存的字面量。

授权码从哪来：QQ 邮箱 → **设置 → 账户 → IMAP/SMTP 服务** → 开启 → **生成授权码**。它是 16 位字符，**不是** QQ 密码。

决定"到底发不发"的开关（`enabled`、`alerts.channels`、`email.enabled`）就在这三个字段旁边；`quietHours`、按事件开关、提示音名、outbox 等仍写在下面的 YAML 里。

### 2. 手工配置：写入 profile patch

页面是最省事的方式；手写同一份配置时，要写进 bundle 补丁插入的那条条目里，放在 `config:` 下面。补丁会替换整条条目的 `config`，所以需要哪些键就都要重新写全：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-notify-long
  name: dsh-notify-long
  config:
    language: auto                   # 邮件语言：auto | zh | en（auto 跟随系统）
    email:
      user: 123456789@qq.com        # QQ 邮箱地址（或只写 QQ 号）会自动选中 qq 预设
      pass: "你的授权码"              # 也可以不写，改用 DSH_SMTP_PASSWORD 环境变量
      # to: [you@example.com]        # 可选：留空就是「发给自己」
```

profile patch 替换的是普通配置，替换不了热更新字段：上面这些里 `enabled`、`language`、`alerts.channels` 和 `email.*` 归设置页面管，交给页面就好（交给这段补丁也行 —— 两者写的是同一条条目）。

人读到的每一条提醒 —— 标题、正文、桌面横幅标题、测试通知 —— 都用这个语言渲染。`auto`（默认值）跟随操作系统：先看 `Intl`，再看 `LANG` / `LC_ALL`，不是中文环境就用英文。**不写** `language` 表示英文而不是"自动检测"，这样库调用方在任何机器上得到的结果都一样。

只要账号是 QQ 邮箱（或纯 QQ 号），且没有配置 `preset` 也没有配置 `host`，就会自动套用 qq 预设，`from` / `to` 也随之默认为该账号 —— 所以上面这段就是完整配置。想用别的服务商照旧，显式写出的值永远优先：

```yaml
- id: dsh-notify-long
  name: dsh-notify-long
  config:
    email:
      preset: gmail              # 见下表，会自动填 host / port / 传输方式
      user: you@gmail.com        # 登录账号
      from: "DSH <you@gmail.com>"   # 发件人（一般和 user 相同）
      to: [you@gmail.com]           # 收件人，可写多个
```

`preset` 可选：`qq`、`qq-exmail`、`163`、`163-enterprise`、`aliyun`、`gmail`、`outlook`、`office365`、`icloud`、`zoho`、`yahoo`、`sendgrid`、`mailgun`、`resend`、`brevo`。
也可以不用预设，直接写 `host` / `port` / `tls`（`implicit` = 465 端口直连 TLS，`starttls` = 587 端口升级 TLS，`plain` = 明文）。

常见坑：

- **QQ / 163 邮箱不能用登录密码**，要去邮箱设置里开启 SMTP 并生成「授权码」，把授权码当密码。
- Gmail 需要「应用专用密码」，普通密码会被拒。
- 465 端口超时会自动回退尝试 587 / 25（可用 `allowPortFallback: false` 关掉）。
- 默认 `requireTls: true`：绝不在明文连接上发送账号密码。

### 3. 密码放在哪里

三选一，按顺序查找（**不要把密码写进 git 仓库里的文件**）：

```bash
# ① 环境变量（推荐）：在 ~/.zshrc 里 export，或启动 dsh 前 export
export DSH_SMTP_PASSWORD='你的授权码'

# ② 组合/设置里的字面量（方便，但会明文落盘）
#    email: { pass: "..." }

# ③ 命令（从 Keychain / pass / 1Password CLI 取）
#    email: { passCommand: "security find-generic-password -s dsh-smtp -w" }
```

自带的自检脚本会读取同样的配置层，方便在重启前先验证：

```bash
node scripts/test-alert.mjs --channel email
node scripts/test-alert.mjs --channel sound --kind error   # 试听错误提示音
node scripts/test-alert.mjs --channel sound --kind retry   # 试听重试提示音
```

### 4. 生效与自检

在卡片里点**发送测试**：每个启用的通道各自报一行结果（`sound: played (afplay)`、`email: sent (250 queued as …)`），结果同时写进旁边的日志面板。

也可以直接问 agent：

> 用 notify_status 看看提醒配置对不对，然后 notify_test 全通道测一遍。

`notify_status` 会报告：启用了哪些通道、邮件是否可用（只显示主机/端口/发件人，**不显示密码**）、免打扰时段、队列里还有几条，以及最近 5 条活动记录。

### 5. 免打扰与事件开关

```yaml
# 下面每一项都写在 `dsh-notify-long` 条目的 `config:` 下（见「手工配置」）
quietHours:
  start: '23:00'
  end: '07:00'      # 免打扰期间：不出声、不弹横幅，但邮件照发
alerts:
  channels: [sound, desktop, email]   # 全局通道
  kinds:
    completed: { enabled: true }
    question:  { enabled: true, channels: [sound, desktop, email] }  # 可按事件覆盖
    error:     { enabled: true }
    retry:     { enabled: true }      # 模型请求被自动重试（网络抖动）
    plan:      { enabled: true, channels: [email] }  # 计划审批只发邮件
    stall:     { enabled: true }      # 轮次静默 10 分钟
    task:      { enabled: true }      # 任务清单每次变化
    job:       { enabled: true }      # 后台任务失败
    subagent:  { enabled: false }     # 子任务完成默认不提醒（噪音大）
sound:
  perKind:            # 给不同结果配不同提示音
    completed: Glass
    error: Basso
    question: Ping
desktop:
  titlePrefix: "[dsh]"   # 横幅标题前缀，多机时好区分
  sound: none            # 横幅自带音效；已经用 sound 通道就关掉，避免两声
```

## 卡片里的日志面板

光看配置回答不了「昨晚那条提醒到底发出去没有」，所以卡片在表单下面接了第二条（基本只读的）通道，把答案显示出来：

- 一行状态：邮件是否就绪、发到哪里、队列里还有几条、最近一次成功/失败是什么时候；
- 每个事件一条记录：`delivered`（成功）、`failed`（带每个通道的失败原因）、`queued`（已安排重试）、`skipped`（被去重、免打扰或关闭）和 `dropped`（放弃投递），外加插件自身的日志行；
- **发送测试** 会在所有启用通道上发一条测试提醒并逐条报告；**重试队列** 会把 durable outbox 里堆积的提醒全部重投一次；**清空日志** 清掉面板内容。

面板通过一条精确路由 `/api/dsh-notify-long` 读取主机端数据：host 端在组合提供 `connection` 时把它注册到 Connection 已挂载的、带鉴权的 `/api` 通道上；没有它的部署只会显示一行「日志不可用」，表单照常工作。历史是落盘的（`~/.dsh/dsh-notify-long/activity.json`，和 outbox 一样原子写入），上限是最近 300 条或一周，先到为准。里面永远不会有密钥：配置项只记录它的**来源**（`env:DSH_SMTP_PASSWORD`），不记录值。

## 提醒是怎么触发的

| 事件 | 触发时机 | 默认通道 | 通知内容 |
| --- | --- | --- | --- |
| `completed` | 做过事的一轮结束、会话回到空闲 | 全部 | 最后一段回复摘要 + 工具调用次数、失败次数、轮次 |
| `question` | agent 调用 `ask_user_question` | 全部 | 问题正文 + 可选项 |
| `plan` | agent 调 `exit_plan_mode` 请你批计划 | 全部 | 计划全文（进邮件正文）+ 批准/继续规划两个选项 |
| `approval` | 需要你批准某个操作 | 全部 | 工具名 + 原因 |
| `error` | 一轮/一步失败，或会话级错误 | 全部 | 失败原因（带错误码），按指纹 10 分钟冷却 |
| `stall` | 轮次仍在运行，但 `stallAfterMs`（默认 10 分钟）内没有任何流式输出、工具结果或会话事件 | 全部 | 静默时长 + 最后跑过的工具；同一段静默只报一次 |
| `retry` | 模型请求失败、harness 正在自动重试 | 全部 | 失败原因 + 重试延迟 + 第几次重试，同一失败按指纹冷却 |
| `account` | 需要重新登录 / 账号会话过期 / 凭据授权失败 | 全部 | 需要做什么；按原因指纹冷却 |
| `goal` | 目标被标记为阻塞（含轮次用尽） | 全部 | 目标 + 阻塞原因 + 已用轮次 |
| `workflow` | workflow 以 `error` 结束 | 全部 | 运行名 + 失败信息 + 启动的子 agent 数 |
| `task` | 模型每次改写任务清单（`todo/write`），含全部完成与清空 | 全部 | 进度 n/m + 进行中的条目 + 清单本身 |
| `job` | 后台任务（`run_in_background`）以 `failed` 结束 | 全部 | 任务名/类型 + 失败信息 |
| `subagent` | 子 agent 结束（默认关闭） | 关闭 | 子任务最终输出 |
| `manual` | 模型主动调用 `notify_user` | 全部 | 自定义标题/正文 |
| `test` | `notify_test` 自检 | 全部 | 通道逐项结果 |

判定细节（每一条都在 `test/triggers.test.js` 里被断言）：

- **提问一定会通知到你**：`user-questions/request` 是 Cordis 的 **waterfall** 事件——第一个返回答案的监听者"认领"请求，后面的监听者全部不再执行，而浏览器界面正是这样一个应答者。插件用 `prepend` 注册自己的观察者，所以"你有没有被告知"不取决于还有谁在听、谁先注册；它始终用 `next()` 放行，请求照常送到界面。即使 harness 没带 agent 身份，提问也照样提醒。
- **同一轮只提醒一次**：这一轮如果已经因为"提问/授权/报错/任务全部完成"提醒过，会话回到空闲时不会再补一条"完成"。
- **计划审批有自己的类型**：`exit_plan_mode` 走的是和提问同一条 waterfall（`user-questions/request`），只是带上了 `intent.kind: 'plan-review'`。提醒因此归入 `plan`，指纹取自 `intent.callId`——"继续规划 → 改计划 → 再提交"不会被 5 分钟去重吞掉；计划全文作为 `detail` 进邮件正文（横幅只放标题和选项，放不下正文）。
- **任务清单逐条播报**：模型每次 `todo_write` 都会往会话里追加一条 `todo/write` 快照（清单在 `turn/start` 重置），任何变化都提醒，包括清空；内容完全相同的重写不算变化。清单全部完成时会压掉这一轮稍后的 `completed`，但一旦又出现未完成条目，压制立即解除。
- **卡死不再静默**：轮次还在 running、却连续 `stallAfterMs`（默认 10 分钟）没有流式输出、工具结果或会话事件时提醒一次；有动静就重置，之后再卡住会再报一次。这是唯一一个"什么都没发生"也会响的提醒。
- **后台任务只报失败**：订阅 jobs 服务的 `settled` 事件，只有 `failed` 会报。`killed` 是你自己停的，正常完成由收尾的那一轮说明，`cause: 'teardown'` 表示 owner 正在被销毁、已经没有读者。
- **一次失败只发一封**：`agent/error` 观察者一看到失败就提醒，随后的空闲判定用的是同一个冷却键，所以同一次失败不会发两封邮件。
- **失败不会被说成"完成"**：如果某轮以失败结束、但没有观察到错误事件，空闲判定依然按"失败"提醒。
- **重试也要告诉你**：模型请求失败、harness 安排下一次尝试时会写入 `llm/retry`，这一刻正是聊天界面显示「等待重试模型请求」、并列出失败原因和重试延迟的时刻；提醒里就带这两项，外加它在重试链里的位置（`第 2/5 次重试 · 提供方：deepseek`）。触发点是**安排重试**的 `llm/retry`，而不是稍后那条 `llm/retry-started`，所以一次重试只提醒一次。重试成功也不会吞掉这一轮：先重试后完成的会话会收到两条提醒（重试一条、完成一条）。
- **网络反复抖动不会每试一次发一封**：同一个失败族的重试共用一个指纹，按和"重复失败"完全相同的冷却规则节流；换了一种失败（连接错误之后又被限流）则是另一个失败族，照常提醒。
- **重试不会盖掉它之后的真失败**：重试指纹和最终错误指纹是两个键，所以试了三次仍以失败告终的一轮，会先收到"重试"、再收到"出错"两条提醒。
- **没干活的轮次不提醒**：没有进入任何步骤、没有工具调用、也没有回复的轮次（空输入、刚开就被取消），以及只是状态翻转、背后没有任何轮次的会话（冷启动/恢复的会话），都不提醒。
- **取消但干过活的轮次会提醒**：干了活之后被取消是值得知道的，还没干活就取消则不是。
- **子会话不打扰**：subagent 子会话默认不算"任务完成"；要收就把 `subagent.enabled` 打开。
- **不打断执行**：所有投递都在后台进行，失败只记录日志，绝不抛回 agent 循环。

## 模型可用的工具

| 工具 | 作用 |
| --- | --- |
| `notify_user` | 主动提醒你（标题 + 正文 + `urgency`：`info` / `action` / `error`，可指定 `sound`）。适合长时间的无人值守任务。 |
| `notify_test` | 逐通道自检，返回每个通道的真实结果与失败原因。 |
| `notify_status` | 报告通道启用状态、邮件是否可用（脱敏）、免打扰、队列长度、本次运行成功/失败数，以及最近 5 条活动记录。 |
| `notify_flush` | 立刻重试队列里所有待发提醒（例如刚把邮件密码改对）。 |

工作目录：`~/.dsh/dsh-notify-long/`

- `outbox.json` — 待发提醒队列（原子写入；成功即删除，最多重试 5 次，超过 6 小时未送出则丢弃）；
- `activity.json` — 卡片日志面板的数据（最近 300 条）；
- 想看状态，卡片里有日志面板，也可以直接问 agent 要 `notify_status`。

## 完整配置参考

所有字段都可以省略（括号内为默认值）。

```yaml
# 下面每一项都写在 `dsh-notify-long` 条目的 `config:` 下（见「手工配置」）
enabled: true                # 总开关
language: auto               # 提醒语言：auto（跟随系统）| zh | en
stallAfterMs: 600000         # 轮次静默多久算卡住（毫秒）；有动静即重置

sound:
  enabled: true
  file:                      # 全局音频文件（留空按事件自动选；macOS 可写 Glass / Basso …）
  player:                    # 播放器（默认 afplay；Linux: paplay/pw-play/aplay/ffplay）
  perKind: {}                # 事件 → 音频文件/名称
  timeoutMs: 10000

desktop:
  enabled: true
  titlePrefix:               # 横幅标题前缀
  sound:                     # macOS 横幅音效名；填 none 关闭

email:
  enabled: true
  preset:                    # qq / gmail / outlook / sendgrid …（自动填 host/port/tls；
                             # 未设置且账号是 QQ 邮箱时自动按 qq 处理）
  host:                      # SMTP 服务器
  port: 465
  tls:                       # implicit | starttls | plain（默认按端口推断）
  user:                      # 登录账号
  pass:                      # 字面量密码（不推荐）
  passEnv: DSH_SMTP_PASSWORD # 密码所在的环境变量名
  passCommand:               # 取密码的命令（stdout 即密码）
  from:                      # 发件人，支持 "名字 <地址>"（默认取 user）
  to: []                     # 收件人（字符串或数组；默认取 from，即"发给自己"）
  cc: []
  subjectPrefix: "[DSH]"
  html: true                 # 是否附带 HTML 版本
  requireTls: true           # 明文连接上绝不发送凭据
  verifyCert: true           # 校验服务器证书
  preferPlain: true          # 优先 AUTH PLAIN（否则 LOGIN / CRAM-MD5）
  allowPortFallback: true    # 端口不通时尝试 465/587/25 中的其它端口
  heloName:                  # EHLO 名，默认本机主机名
  timeoutMs: 20000

quietHours:
  start:                     # 'HH:MM'
  end:                       # 'HH:MM'（跨零点自动识别，如 23:00 → 07:00）

alerts:
  channels: [sound, desktop, email]
  dedupeWindowMs: 300000     # 同一事件 5 分钟内只提醒一次
  errorCooldownMs: 600000    # 同指纹报错 10 分钟冷却
  channelCooldownMs: 15000   # 提示音突发合并窗口
  kinds: {}                  # { completed|question|plan|approval|error|stall|retry|account|goal|workflow|task|job|subagent|manual|test: { enabled, channels } }

outbox:
  path:                      # 默认 ~/.dsh/dsh-notify-long/outbox.json
  flushOnStart: true         # 启动时补发积压提醒

tools:
  enabled: true              # 是否注册 notify_* 工具

log:
  delivered: true            # 记录投递日志

debug: false                 # 输出调试信息（状态目录、队列恢复情况）
```

## 常见问题

**改了配置没反应？**
设置页面管的字段（`enabled`、`language`、`alerts.channels`、`email.*`）保存即生效；条目 `config` 里的其它内容属于普通组合配置，需要重启。用 `notify_status` 确认当前生效值。

**没有声音？**
`node scripts/test-alert.mjs --channel sound` 会打印实际执行的命令。macOS 需要 `/System/Library/Sounds/*.aiff`（系统自带）；Linux 需要 `paplay` / `pw-play` / `aplay` / `ffplay` 之一；容器/远程环境通常没有音频设备，此时请用邮件通道。

**邮件发不出去？**
先打开卡片里的日志面板：它会直接写出是哪个通道失败、服务器给的原因，如果是信封被拒还会写出**被拒的那条命令**（例如 `… for MAIL FROM:<you@qq.com>`）。点**发送测试**可以随时复现；想看完整会话就用命令行：

```bash
node scripts/test-alert.mjs --channel email --trace   # 打印 SMTP 会话，凭据已脱敏
```

`notify_status` / `notify_flush` 会把同样的信息报告给模型。常见原因：用了登录密码而不是授权码、465 被防火墙挡（试 `port: 587` + `tls: starttls`）、发件人和登录账号不是同一个域、服务器证书自签名（可临时 `verifyCert: false`）。

**提醒重复/太吵？**
调大 `alerts.dedupeWindowMs`；用 `alerts.kinds.subagent.enabled: false` 关掉子任务，用 `alerts.kinds.retry.enabled: false` 关掉模型重试（网络不稳时它是最吵的一类）；用 `quietHours` 设定免打扰时段。想留着重试提醒但不想出声，可以写 `retry: { enabled: true, channels: [email] }`。

**会不会拖慢 agent？**
所有通道都是异步子进程/网络调用，且有超时上限；任何一个通道挂掉都不会影响对话，失败会进队列重试。

## 开发

```bash
npm run link-deps          # 把 harness peer 链到源码旁边，boot 级测试才会真正跑
node --test test/          # 186 个测试：策略、渲染、SMTP（本地假服务器）、队列、引擎、
                           # 活动日志、卡片接口、消息文案表、boot 级挂载、浏览器端卡片、
                           # 触发规则规格，以及真实 Cordis/Connection 传输层与真实提问服务的集成测试
node scripts/test-alert.mjs --channel all --json
node scripts/test-alert.mjs --channel email --trace   # 打印 SMTP 会话，凭据已脱敏
```

目录结构：

```
src/index.js              Cordis 插件入口：读服务、订阅事件、注册工具（薄接线层）
client/index.js           浏览器端：Plugins 页面里的 SMTP 字段表单（含日志面板）
lib/core/                 与 harness 无关的决策层：策略、文本、多语言文案、事件折叠、队列、引擎、活动日志
lib/channels/             三个投递通道：系统提示音、桌面横幅、邮件
lib/email/                自研 SMTP 客户端 + RFC 5322/MIME 构造
lib/runtime/handlers.js   harness 事件 → 提醒决策（纯函数，便于测试）
lib/runtime/api.js        卡片用的路由：状态、活动日志、发送测试、重试队列、清空日志
lib/runtime/selftest.js   通道自检实现，`notify_test` 与卡片按钮共用同一份
cordis.patch.yml          `dsh plugin` 放进 profile 层栈的 bundle 补丁
scripts/install.mjs       包装脚本：`dsh plugin --profile add`
scripts/link-harness-deps.mjs  只为测试：把 harness peer 链到本包旁边（运行时不经过它）
scripts/test-alert.mjs    脱离 harness 的通道自检
test/                     单元测试 + 假 SMTP 服务器 + 假 harness 挂载测试 + 浏览器端卡片测试
                          + 触发规则规格 + 真实 harness 包集成测试（Connection 传输层、提问 waterfall、重试策略）
```

## 设计取舍

- **为什么不做成动态 Cordis 插件？** 动态插件活在单个会话/进程内存里，重启即消失，而且权限受限；"任务完成提醒"必须对所有会话、重启后依然有效，所以它是一个真正的 npm 插件包，装在 host 侧组合里。
- **为什么自己写 SMTP？** 本插件承诺零运行时依赖：不需要 `npm install`、不受传递依赖影响，SMTP 提交所需的子集（EHLO/STARTTLS/AUTH PLAIN/LOGIN/CRAM-MD5/MAIL/RCPT/DATA）只有几百行，且全部有测试覆盖。
- **为什么先落盘再发送？** 提醒的意义在于"一定会到达"。先写 `outbox.json`，成功才删除；断网、重启、关机都不会吞掉一条"任务完成了"。
- **为什么日志要另开一条线路，而不是塞进设置里？** 设置命名空间只承载配置，配置本身回答不了"提醒到底发出去没有"。所以日志走一条由 host 端注册在 Connection `/api` 通道上的精确路由；没有 `connection` 的部署只会显示"日志不可用"，而不会让卡片渲染失败。这里用的是 `connection.fetch.register` 而不是看起来更顺手的 `connection.rpc.handle`：后者的注册表会用**服务提供方**的 fiber 去 `webServer.register`，而那里看不到 `webServer`，任何消费方插件调用都会抛 `cannot get property "webServer" without inject`，通道根本挂不上。
- **为什么要自动推断 qq 预设？** 最常见的配置就是「QQ 邮箱 + 授权码」，再额外要求填 `smtp.qq.com`、`465`、`implicit` 是三个只有一个答案的问题。推断只在账号是 QQ 邮箱**且**用户没配 `preset`、没配 `host` 时生效，绝不会覆盖显式配置。
- **保存是怎么传到正在运行的插件里的？** Config schema 里标了 `.volatile()` 的字段，不会以「值」的形式出现在 `apply` 里：Loader 交过来的是一份**引用**（`get()`，保存时原地改写），订阅这份引用就是整套机制。它同时也是这条条目能被配置的前提 —— `@deepseek-ai/dsh-settings` 只为"至少有一个 volatile 字段"的条目提供表单 —— 而 `settings.configure({ auto: false }, ctx.fiber)` 则婉拒了 schema 自动生成的页面，因为这个插件自己画。订阅声明放在 `inject` 子作用域里，因为 settings 服务自己的异步初始化在本插件激活之后才完成；而无论有没有 settings 域，插件都照样读自己的组合条目，所以没有设置域的部署也照常提醒。
- **页面为什么放在 Plugins 页面里？** 因为在 0.2 里，插件自己的配置就归这里：卡片通过客户端 `configForms` 服务绑定自己那条条目，并注册进 `plugins.item` 插槽；host 不再提供该条目时它会自行撤下，而不是留下一张死页面。

---

如果你的 agent 在深夜跑长任务，这个插件就是替你在键盘前守着的那只耳朵。MIT License.

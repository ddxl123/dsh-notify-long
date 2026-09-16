# dsh-notify-long

简体中文 | [English](README.md)

[![release](https://img.shields.io/github/v/release/ddxl123/dsh-notify-long?label=release&color=blue)](https://github.com/ddxl123/dsh-notify-long/releases)
[![test](https://img.shields.io/badge/tests-173%20passing-brightgreen)](https://github.com/ddxl123/dsh-notify-long)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装上一双"耳朵"和一部"电话"：**任务做完、出错、需要你回答问题时，用系统提示音、桌面横幅和邮件提醒你**，不用一直盯着终端。

```
任务完成  →  🔔 系统提示音 + 桌面横幅 + 邮件「已完成：xxx」
需要选择  →  🔔 另一种提示音 + 邮件「需要你的输入：用哪个数据库？」
执行出错  →  🔔 警示音 + 邮件「错误：模型路由失败 …」
等待授权  →  🔔 提示音 + 邮件「需要授权：bash」
```

- **零运行时依赖**：只用 Node 内置模块，SMTP 客户端自己实现，不需要 `nodemailer`。
- **零构建步骤**：纯 JavaScript ESM，`git clone` 后直接装进 profile 就能用。
- **不会丢提醒**：每次提醒先落盘（durable outbox）再发送，失败自动退避重试；进程重启后继续投递。
- **不吵人**：同类事件去重、报错按指纹冷却、提示音突发合并、可设置免打扰时段（免打扰时只发邮件）。
- **可控**：可以在 `settings.yaml` 里热改路由（哪些事件走哪些通道），不用重启。
- **配置简单**：界面卡片只问「QQ 邮箱地址 + 授权码」，服务器、发件人、收件人都由它推出来。
- **看得见结果**：同一张卡片带日志面板，每次投递、抑制、重试和插件日志都在里面，还有「发送测试」按钮。

---

## 目录

- [安装](#安装)
- [配置](#配置)
  - [1. 在界面里配置（推荐）](#1-在界面里配置推荐)
  - [2. 在 settings.yaml 里配置邮件](#2-在-settingsyaml-里配置邮件)
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

> 当前版本通过 **GitHub 源码**分发（`v0.1.0`）；插件还没有发布到 npm，所以用下面的克隆方式安装。

本包在 `package.json` 里声明了 `dsh.bundle.patch`，所以它和别的 profile 插件一样安装：

```bash
git clone https://github.com/ddxl123/dsh-notify-long.git
cd dsh-notify-long
dsh plugin --profile web add .
node scripts/link-harness-deps.mjs     # 见下方「harness peer 依赖」
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
> 其它 profile（`headless` 等）：把 `--profile web` 换成对应名字即可。`node scripts/install.mjs` 把上面两条命令合成一步；加 `--dry-run` 先看要做什么，`--uninstall` 反向卸载。

### harness peer 依赖

`@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools` 是 **peer 依赖**：它们属于你的 harness 安装，不属于本包。Node 解析裸导入时走的是包的**真实路径**（会跟随软链），所以被软链的插件看不到 profile 自己的 `node_modules`。本地安装后执行一次即可：

```bash
node scripts/link-harness-deps.mjs                        # 自动寻找你的 harness
node scripts/link-harness-deps.mjs --from /path/to/node_modules
```

重复执行是安全的；已经能解析时会直接告诉你无需处理。git / npm 安装会通过本包的 `prepare` 脚本自动完成；只有 `link:` 安装（`add .` 或绝对路径）需要手动这一步，因为 pnpm 对本地软链不跑生命周期脚本。同一步也会链上 `@deepseek-ai/dsh-settings`，它只被设置契约测试用到（运行时的 `dsh-settings` 由 harness 自己注入）。

即使没有这两个包，插件依然能加载，只有两点变化：组合条目不做过校验（文档里的默认值照常生效），以及 `notify_*` 工具改用普通定义而不是 `defineTool`。同一条命令还会链上只有测试会导入的几个 peer：`@deepseek-ai/dsh-settings`（设置契约测试）、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-user-questions`（集成测试：把真实插件分别挂到真实 Connection 服务与真实提问服务上）。运行时这些服务由 harness 注入，插件代码本身从不导入它们。

## 配置

配置有三层，越靠后优先级越高：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 组合条目 | 本包 `cordis.patch.yml` 里的那一行，可从 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖 | 装机时的默认值 |
| 设置文档（热更新） | `~/.dsh/settings.yaml` 的 `dsh-notify-long:` 段 | 日常调整，保存即生效 |
| 环境变量 | `DSH_SMTP_PASSWORD` 等 | 只放密钥 |

### 1. 在界面里配置（推荐）

插件带浏览器端，所以配置卡片直接出现在你正在使用的界面里：

**设置 → 插件 → QQ 邮箱通知**

卡片只问三件事 —— **QQ 邮箱地址**、**授权码**、（可选的）**收件人** —— 因为这已经是全部配置：

- 填了地址就等于选了 QQ 邮箱预设（`smtp.qq.com:465`，隐式 TLS），同时它就是发件人；
- 收件人留空表示「发给自己」，邮件就发到上面那个地址；
- 只填 QQ 号也可以，会自动补成 `<号码>@qq.com`。

点**保存**写入的就是下面 YAML 手写的那段 `~/.dsh/settings.yaml`（`dsh-notify-long:` 段），走的是设置文档带版本号的写入通道；两种方式完全等价，都不需要重启。其余字段（服务器、端口、加密方式、证书校验、抄送、主题前缀、密码环境变量/命令）都还在，收在卡片底部折叠的**高级设置**里。

两点需要注意：

- 卡片是**先暂存、再保存**：输入过程中不会立即落盘；
- 授权码是**只写**字段：主机从不把 `role('secret')` 的值发给浏览器，所以这一栏永远显示为空，只有你输入了内容才会写入，并用旁路信息显示「已配置 / 未配置」；**清除授权码**会删掉已存的字面量。

授权码从哪来：QQ 邮箱 → **设置 → 账户 → IMAP/SMTP 服务** → 开启 → **生成授权码**。它是 16 位字符，**不是** QQ 密码。

决定"到底发不发"的开关（`enabled`、`alerts.channels`、`email.enabled`）就在这三个字段旁边；`quietHours`、按事件开关、提示音名、outbox 等仍写在下面的 YAML 里。

### 2. 在 settings.yaml 里配置邮件

界面卡片是最省事的方式；手写同一段配置同样不需要写服务器字段：

```yaml
dsh-notify-long:
  language: auto                   # 邮件语言：auto | zh | en（auto 跟随系统）
  email:
    user: 123456789@qq.com        # QQ 邮箱地址（或只写 QQ 号）会自动选中 qq 预设
    pass: "你的授权码"              # 也可以不写，改用 DSH_SMTP_PASSWORD 环境变量
    # to: [you@example.com]        # 可选：留空就是「发给自己」
```

人读到的每一条提醒 —— 标题、正文、桌面横幅标题、测试通知 —— 都用这个语言渲染。`auto`（默认值）跟随操作系统：先看 `Intl`，再看 `LANG` / `LC_ALL`，不是中文环境就用英文。**不写** `language` 表示英文而不是"自动检测"，这样库调用方在任何机器上得到的结果都一样。

只要账号是 QQ 邮箱（或纯 QQ 号），且没有配置 `preset` 也没有配置 `host`，就会自动套用 qq 预设，`from` / `to` 也随之默认为该账号 —— 所以上面这段就是完整配置。想用别的服务商照旧，显式写出的值永远优先：

```yaml
dsh-notify-long:
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
```

### 4. 生效与自检

在卡片里点**发送测试**：每个启用的通道各自报一行结果（`sound: played (afplay)`、`email: sent (250 queued as …)`），结果同时写进旁边的日志面板。

也可以直接问 agent：

> 用 notify_status 看看提醒配置对不对，然后 notify_test 全通道测一遍。

`notify_status` 会报告：启用了哪些通道、邮件是否可用（只显示主机/端口/发件人，**不显示密码**）、免打扰时段、队列里还有几条，以及最近 5 条活动记录。

### 5. 免打扰与事件开关

```yaml
dsh-notify-long:
  quietHours:
    start: '23:00'
    end: '07:00'      # 免打扰期间：不出声、不弹横幅，但邮件照发
  alerts:
    channels: [sound, desktop, email]   # 全局通道
    kinds:
      completed: { enabled: true }
      question:  { enabled: true, channels: [sound, desktop, email] }  # 可按事件覆盖
      error:     { enabled: true }
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
| `question` | agent 调用 `ask_user_question`（含 plan 审批） | 全部 | 问题正文 + 可选项 |
| `approval` | 需要你批准某个操作 | 全部 | 工具名 + 原因 |
| `error` | 一轮/一步失败，或会话级错误 | 全部 | 失败原因（带错误码），按指纹 10 分钟冷却 |
| `subagent` | 子 agent 结束（默认关闭） | 关闭 | 子任务最终输出 |
| `manual` | 模型主动调用 `notify_user` | 全部 | 自定义标题/正文 |
| `test` | `notify_test` 自检 | 全部 | 通道逐项结果 |

判定细节（每一条都在 `test/triggers.test.js` 里被断言）：

- **提问一定会通知到你**：`user-questions/request` 是 Cordis 的 **waterfall** 事件——第一个返回答案的监听者"认领"请求，后面的监听者全部不再执行，而浏览器界面正是这样一个应答者。插件用 `prepend` 注册自己的观察者，所以"你有没有被告知"不取决于还有谁在听、谁先注册；它始终用 `next()` 放行，请求照常送到界面。即使 harness 没带 agent 身份，提问也照样提醒。
- **同一轮只提醒一次**：这一轮如果已经因为"提问/授权/报错"提醒过，会话回到空闲时不会再补一条"完成"。
- **一次失败只发一封**：`agent/error` 观察者一看到失败就提醒，随后的空闲判定用的是同一个冷却键，所以同一次失败不会发两封邮件。
- **失败不会被说成"完成"**：如果某轮以失败结束、但没有观察到错误事件，空闲判定依然按"失败"提醒。
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
dsh-notify-long:
  enabled: true                # 总开关
  language: auto               # 提醒语言：auto（跟随系统）| zh | en

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
    kinds: {}                  # { completed|question|approval|error|subagent|manual|test: { enabled, channels } }

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
`settings.yaml` 是热生效的；`cordis.patch.yml` 里的 `config` 改动需要重启。用 `notify_status` 确认当前生效值。

**没有声音？**
`node scripts/test-alert.mjs --channel sound` 会打印实际执行的命令。macOS 需要 `/System/Library/Sounds/*.aiff`（系统自带）；Linux 需要 `paplay` / `pw-play` / `aplay` / `ffplay` 之一；容器/远程环境通常没有音频设备，此时请用邮件通道。

**邮件发不出去？**
先打开卡片里的日志面板：它会直接写出是哪个通道失败、服务器给的原因，如果是信封被拒还会写出**被拒的那条命令**（例如 `… for MAIL FROM:<you@qq.com>`）。点**发送测试**可以随时复现；想看完整会话就用命令行：

```bash
node scripts/test-alert.mjs --channel email --trace   # 打印 SMTP 会话，凭据已脱敏
```

`notify_status` / `notify_flush` 会把同样的信息报告给模型。常见原因：用了登录密码而不是授权码、465 被防火墙挡（试 `port: 587` + `tls: starttls`）、发件人和登录账号不是同一个域、服务器证书自签名（可临时 `verifyCert: false`）。

**提醒重复/太吵？**
调大 `alerts.dedupeWindowMs`；用 `alerts.kinds.subagent.enabled: false` 关掉子任务；用 `quietHours` 设定免打扰时段。

**会不会拖慢 agent？**
所有通道都是异步子进程/网络调用，且有超时上限；任何一个通道挂掉都不会影响对话，失败会进队列重试。

## 开发

```bash
npm run link-deps          # 链好 harness peer 依赖，boot 级测试才会真正跑
node --test test/          # 173 个测试：策略、渲染、SMTP（本地假服务器）、队列、引擎、
                           # 活动日志、卡片接口、消息文案表、boot 级挂载、浏览器端卡片、
                           # 触发规则规格，以及真实 Cordis/Connection 传输层与真实提问服务的集成测试
node scripts/test-alert.mjs --channel all --json
node scripts/test-alert.mjs --channel email --trace   # 打印 SMTP 会话，凭据已脱敏
```

目录结构：

```
src/index.js              Cordis 插件入口：读服务、订阅事件、注册工具（薄接线层）
client/index.js           浏览器端：设置 → 插件里那张 QQ 邮箱卡片（含日志面板）
lib/core/                 与 harness 无关的决策层：策略、文本、多语言文案、事件折叠、队列、引擎、活动日志
lib/channels/             三个投递通道：系统提示音、桌面横幅、邮件
lib/email/                自研 SMTP 客户端 + RFC 5322/MIME 构造
lib/runtime/handlers.js   harness 事件 → 提醒决策（纯函数，便于测试）
lib/runtime/api.js        卡片用的路由：状态、活动日志、发送测试、重试队列、清空日志
lib/runtime/selftest.js   通道自检实现，`notify_test` 与卡片按钮共用同一份
cordis.patch.yml          `dsh plugin` 放进 profile 层栈的 bundle 补丁
scripts/install.mjs       包装脚本：`dsh plugin --profile add` 加 harness peer 链
scripts/link-harness-deps.mjs  让本包能解析到 harness peer 依赖
scripts/test-alert.mjs    脱离 harness 的通道自检
test/                     单元测试 + 假 SMTP 服务器 + 假 harness 挂载测试 + 浏览器端卡片测试
                          + 触发规则规格 + 真实 Cordis 运行时集成测试（Connection 传输层、提问 waterfall）
```

## 设计取舍

- **为什么不做成动态 Cordis 插件？** 动态插件活在单个会话/进程内存里，重启即消失，而且权限受限；"任务完成提醒"必须对所有会话、重启后依然有效，所以它是一个真正的 npm 插件包，装在 host 侧组合里。
- **为什么自己写 SMTP？** 本插件承诺零运行时依赖：不需要 `npm install`、不受传递依赖影响，SMTP 提交所需的子集（EHLO/STARTTLS/AUTH PLAIN/LOGIN/CRAM-MD5/MAIL/RCPT/DATA）只有几百行，且全部有测试覆盖。
- **为什么先落盘再发送？** 提醒的意义在于"一定会到达"。先写 `outbox.json`，成功才删除；断网、重启、关机都不会吞掉一条"任务完成了"。
- **为什么日志要另开一条线路，而不是塞进设置里？** 设置命名空间只承载配置，配置本身回答不了"提醒到底发出去没有"。所以日志走一条由 host 端注册在 Connection `/api` 通道上的精确路由；没有 `connection` 的部署只会显示"日志不可用"，而不会让卡片渲染失败。这里用的是 `connection.fetch.register` 而不是看起来更顺手的 `connection.rpc.handle`：后者的注册表会用**服务提供方**的 fiber 去 `webServer.register`，而那里看不到 `webServer`，任何消费方插件调用都会抛 `cannot get property "webServer" without inject`，通道根本挂不上。
- **为什么要自动推断 qq 预设？** 最常见的配置就是「QQ 邮箱 + 授权码」，再额外要求填 `smtp.qq.com`、`465`、`implicit` 是三个只有一个答案的问题。推断只在账号是 QQ 邮箱**且**用户没配 `preset`、没配 `host` 时生效，绝不会覆盖显式配置。
- **为什么要等待 settings 服务？** `dsh-settings-file` 的异步初始化在本插件激活**之后**才完成，所以 apply 时用 `ctx.get('settings')` 一次性读取只会拿到 undefined；设置段没挂上就不会对外提供命名空间，设置页里的卡片于是什么都不渲染。改成 `ctx.inject(['settings'], …)` 后，服务一出现就挂载；没有设置域的部署也照旧只靠组合条目运行。

---

如果你的 agent 在深夜跑长任务，这个插件就是替你在键盘前守着的那只耳朵。MIT License.

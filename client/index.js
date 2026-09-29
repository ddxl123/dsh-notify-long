/**
 * dsh-notify-long — browser half: the plugin's page on the Plugins screen.
 *
 * ## Why this file is shaped the way it is
 *
 * A DSH profile plugin has two faces. The host half (`src/index.js`) declares
 * the Config fields that may change while the harness runs; the browser half
 * draws the page that edits them. Since 0.2 the two halves meet on one string —
 * this package's name, which is the profile entry id — and neither needs to
 * know about the other:
 *
 *   - host: the fields marked `.volatile()` in the Config schema make the entry
 *           *served*, and `settings.configure({ auto: false }, ctx.fiber)`
 *           declines the schema-generated page;
 *   - browser: `ctx.configForms.get('dsh-notify-long')` binds that entry, and
 *              `ctx.configForms.whileServed([…])` registers the page only while
 *              the host still serves it.
 *
 * A served entry no page claims renders nothing but the harness's own generated
 * form, which is why the host half alone puts no custom page on screen.
 *
 * (0.1.5 had a different shape of the same idea: `settings.installSection` on
 * the host and a `settingsScope`-backed card keyed into `settings.plugin.item`.
 * Both APIs were removed in 0.2; this file carries the migration notes inline
 * where the old call used to be.)
 *
 * ## Why it is a hand-written bundle
 *
 * Client halves are loaded by the web module loader (`window.__ModuleLoader__`)
 * as prebuilt CJS-table bundles rather than through Node resolution, so this
 * file registers one factory instead of exporting ESM. Everything — CSS
 * injection included — lives inside the factory closure, because executing the
 * bundle only *registers* it; the body runs when the module is first
 * materialized. `react` and `@deepseek-ai/dsh-client-store` are platform seed
 * words the shell always installs, so requiring them needs no build step and
 * no dependency of our own. Keeping the bundle hand-written is what lets a
 * source-only checkout install with `dsh plugin --profile web add .` and no
 * toolchain.
 *
 * ## What the card edits
 *
 * Two answers, not twenty fields. The card opens with the switches that decide
 * whether anything is sent, then the QQ mailbox the operator actually has —
 * address, authorization code, recipient — because a QQ address plus its
 * authorization code is the whole configuration: the host half infers the
 * `qq` preset (smtp.qq.com:465, implicit TLS), uses the account as the sender,
 * and mails the account when no recipient is typed. Everything else (host,
 * port, transport, certificate policy, Cc, subject prefix, password
 * environment/keychain) still exists, folded into a collapsed *Advanced*
 * disclosure for the deployments that need it.
 *
 * Writes go through the settings scope's `mutate` with path-addressed
 * operations (`['email', 'host']`), so the card never rewrites the whole
 * section and never touches a key it does not show. Edits are staged and
 * written on Save, matching every other card in that tab: one settings write is
 * a durable, revision-fenced document mutation, so a control that committed as
 * it settled would turn one edit into a write the user never asked for.
 *
 * The SMTP password is a write-only control. The host strips `role('secret')`
 * fields from everything it sends the browser, so the card cannot read the
 * stored password back; it renders blank, writes only when something is typed,
 * and reports "configured" from the schema's secret sidecar instead.
 *
 * ## What the log panel shows
 *
 * Configuration cannot answer "did last night's alert arrive?", so the card
 * carries a second, read-mostly wire: the host half registers the exact route
 * `/api/dsh-notify-long` on Connection's `/api` channel, and the log panel posts
 * to it for the activity log — every delivery, suppression, retry and plugin log
 * line, with the per-channel failure text — plus the buttons that fire a test
 * alert and retry the outbox. The panel is a convenience: a deployment without
 * the host half still gets a fully working configuration form, and says in one
 * line why the log is empty.
 *
 * @module dsh-notify-long/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify-long',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    /** This package's name: the settings namespace and the card's slot key. */
    const NS = 'dsh-notify-long'
    /** Locale dictionary namespace owned by this plugin (same string by convention). */
    const LOCALE_NS = NS
    /** The secret field's path, spelled once for the sidecar lookup. */
    const SECRET_PATH = 'email.pass'
    /** The exact Fetch route the host half publishes for this card. */
    const API_PATH = `/api/${NS}`
    /** How many activity entries one snapshot asks for. */
    const LOG_LIMIT = 100
    /** How often the open log panel re-reads the host while it is on screen. */
    const LOG_REFRESH_MS = 5000

    const css = `
.dshNotifyLongCard{margin:0;display:grid;gap:2px}
.dshNotifyLongBadge{border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;padding:1px 8px}
.dshNotifyLongBadgeWarn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshNotifyLongBody{padding:2px 0 4px}
.dshNotifyLongGroup{border:0;margin:12px 0 0;padding:0;display:grid;gap:10px}
.dshNotifyLongGroup>legend{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;padding:0;letter-spacing:.02em}
.dshNotifyLongRow{display:grid;gap:4px}
.dshNotifyLongLabel{color:var(--dsw-alias-label-primary);font-size:13px;display:flex;align-items:center;gap:8px}
.dshNotifyLongControl{background:var(--dsw-alias-bg-layer-4);border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px;width:100%;box-sizing:border-box}
.dshNotifyLongControl:disabled{opacity:.6}
.dshNotifyLongCheck{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px}
.dshNotifyLongChecks{display:flex;gap:16px;flex-wrap:wrap}
.dshNotifyLongHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshNotifyLongReset{background:0 0;border:0;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:11px;padding:0}
.dshNotifyLongInvalid{color:var(--dsw-alias-label-error)}
.dshNotifyLongAdvanced{border:0;margin:12px 0 0;padding:0}
.dshNotifyLongAdvanced>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em}
.dshNotifyLongAdvancedBody{padding-top:2px}
.dshNotifyLongFooter{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px}
.dshNotifyLongFailed{margin:0 auto 0 0;color:var(--dsw-alias-label-error);font-size:12px}
.dshNotifyLongReadOnly{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshNotifyLongButton{border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;cursor:pointer;font:inherit;font-size:12px;padding:5px 12px}
.dshNotifyLongButton:disabled{cursor:default;opacity:.5}
.dshNotifyLongDiscard{background:0 0;color:var(--dsw-alias-label-secondary)}
.dshNotifyLongSave{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dshNotifyLongLog{border:0;margin:12px 0 0;padding:0}
.dshNotifyLongLog>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.02em}
.dshNotifyLongLogBody{display:grid;gap:8px;padding-top:2px}
.dshNotifyLongLogBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshNotifyLongLogBar .dshNotifyLongButton{padding:3px 10px}
.dshNotifyLongStatus{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dshNotifyLongResult{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.dshNotifyLongEntries{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto;display:grid;gap:6px;border-top:.5px solid var(--dsw-alias-border-l3);padding-top:8px}
.dshNotifyLongEntry{display:grid;grid-template-columns:auto auto 1fr;gap:4px 8px;align-items:baseline;font-size:12px}
.dshNotifyLongTime{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshNotifyLongLevel{border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);font-size:10px;padding:0 6px}
.dshNotifyLongLevel-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshNotifyLongLevel-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshNotifyLongMessage{color:var(--dsw-alias-label-primary);line-height:1.5;word-break:break-word}
.dshNotifyLongFailure{grid-column:3;color:var(--dsw-alias-label-error);font-size:11px;line-height:1.5;word-break:break-word}
`

    /** The locale dictionary, registered for the active language's fallback chain. */
    const DICTIONARY = {
      zh: {
        cardTitle: 'QQ 邮箱通知',
        cardDescription: 'Agent 结束、失败或提问时，用系统提示音、桌面横幅和 QQ 邮件提醒你。',
        unsaved: '未保存',
        save: '保存',
        saving: '保存中…',
        discard: '放弃',
        saveFailed: '保存未生效，主机拒绝了这次写入。请检查后重试。',
        readOnly: '该部署的设置文档为只读，下面的字段仅供查看。',
        reset: '重置',
        overridden: '已覆盖',
        invalid: '这个值无效，保存被阻止。',
        configured: '已配置（留空表示保持不变）',
        notConfigured: '未配置',
        secretClear: '清除授权码',
        groupGeneral: '总开关',
        groupMailbox: 'QQ 邮箱',
        groupAdvanced: '高级设置（一般不用改）',
        fieldLanguage: '邮件语言',
        hintLanguage: '邮件标题和正文使用的语言。auto 跟随系统语言（本机为中文），也可以固定为中文或英文。',
        optionLanguageInherit: '跟随默认（自动）',
        fieldEnabled: '启用通知插件',
        hintEnabled: '关闭后所有渠道都静默。',
        fieldChannels: '启用的渠道',
        hintChannels: '邮件只有在 email 这一项勾选时才会发送。',
        channelSound: '系统提示音',
        channelDesktop: '桌面通知',
        channelEmail: '邮件',
        fieldEmailEnabled: '启用邮件渠道',
        hintEmailEnabled: '关闭后即使邮箱配置完整也不会发信。',
        fieldUser: 'QQ 邮箱地址',
        hintUser: '例如 123456789@qq.com，也可以只填 QQ 号。',
        fieldPass: '授权码',
        hintPass: '在 QQ 邮箱「设置 → 账户」开启 IMAP/SMTP 服务后生成的 16 位授权码，不是 QQ 密码。只保存在本机设置文档中，不会回显。',
        fieldTo: '收件人',
        hintTo: '留空表示发给自己（上面的邮箱地址）。多个地址用逗号分隔。',
        autoPreset: '保存时会自动使用 QQ 邮箱服务器 smtp.qq.com:465（隐式 TLS）。',
        fieldPreset: '服务商预设',
        hintPreset: '只提供 QQ 邮箱：个人邮箱用 qq，企业邮箱用 qq-exmail。留空则按邮箱地址自动判断。',
        optionAuto: '按邮箱地址自动判断',
        fieldHost: 'SMTP 服务器',
        hintHost: '例如 smtp.qq.com。',
        fieldPort: '端口',
        hintPort: '465 为隐式 TLS，587 通常为 STARTTLS。',
        fieldTls: '加密方式',
        hintTls: 'implicit 从第一个字节就是 TLS；starttls 先明文再升级；plain 不加密。',
        optionTlsAuto: '按端口自动',
        fieldRequireTls: '强制加密',
        hintRequireTls: '开启后拒绝在明文连接上发送凭据。',
        fieldVerifyCert: '校验服务器证书',
        hintVerifyCert: '除非使用自签名证书的测试服务器，否则请保持开启。',
        fieldFrom: '发件人',
        hintFrom: '留空时使用邮箱地址。',
        fieldCc: '抄送',
        hintCc: '可留空。',
        fieldSubjectPrefix: '主题前缀',
        hintSubjectPrefix: '默认 [DSH]。',
        fieldPassEnv: '授权码环境变量',
        hintPassEnv: '默认 DSH_SMTP_PASSWORD；host 进程的环境变量优先于设置文档里的授权码。',
        fieldPassCommand: '授权码命令',
        hintPassCommand: '本地命令，stdout 作为授权码，例如 macOS 的 security find-generic-password。',
        logTitle: '日志',
        hintLog: '记录每次通知的投递结果和插件日志，只保留最近 300 条。',
        logDelivered: '成功',
        logFailed: '失败',
        logRefresh: '刷新',
        logTest: '发送测试',
        logTesting: '发送中…',
        logFlush: '重试队列',
        logFlushing: '重试中…',
        logClear: '清空日志',
        logClearing: '清空中…',
        logEmpty: '还没有记录。点「发送测试」可以立刻验证配置。',
        logUnavailable: '日志需要主机端接口：重启 dsh web 后可用；上面的配置不受影响。',
        logLoading: '读取中…',
        logEmail: '邮件',
        logReady: '就绪',
        logNotReady: '未就绪',
        logQueued: '待发队列',
        logLastSuccess: '最近成功',
        logLastFailure: '最近失败',
        logNever: '暂无',
        logTestResult: '测试结果',
        logActionFailed: '操作失败',
        logFlushResult: '队列重试',
        logClearResult: '日志已清空',
        logEntries: '条记录',
        levelInfo: '信息',
        levelWarn: '警告',
        levelError: '错误',
      },
      en: {
        cardTitle: 'QQ mailbox notifications',
        cardDescription: 'Alert you over the system sound, a desktop banner and QQ mail when an agent finishes, fails, or asks a question.',
        unsaved: 'Unsaved',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        saveFailed: 'The save did not take effect — the host refused the write. Check the values and retry.',
        readOnly: 'This deployment keeps its settings document read-only; the fields below are informational.',
        reset: 'Reset',
        overridden: 'Overridden',
        invalid: 'This value is not accepted, so saving is blocked.',
        configured: 'Configured (leave blank to keep it)',
        notConfigured: 'Not configured',
        secretClear: 'Clear authorization code',
        groupGeneral: 'Switches',
        groupMailbox: 'QQ mailbox',
        groupAdvanced: 'Advanced (rarely needed)',
        fieldLanguage: 'Alert language',
        hintLanguage: 'The language of every alert subject and body. auto follows the operating system; zh and en pin it.',
        optionLanguageInherit: 'Follow the default (auto)',
        fieldEnabled: 'Enable the plugin',
        hintEnabled: 'Turning this off silences every channel.',
        fieldChannels: 'Enabled channels',
        hintChannels: 'Email is only attempted while the email channel is checked here.',
        channelSound: 'System sound',
        channelDesktop: 'Desktop notification',
        channelEmail: 'Email',
        fieldEmailEnabled: 'Enable the email channel',
        hintEmailEnabled: 'Off means no mail is sent even when the mailbox below is complete.',
        fieldUser: 'QQ mailbox address',
        hintUser: 'For example 123456789@qq.com — a bare QQ number works too.',
        fieldPass: 'Authorization code',
        hintPass: 'The 16-character code QQ Mail generates under Settings → Account once IMAP/SMTP is enabled — not your QQ password. Kept in this machine\'s settings document and never read back.',
        fieldTo: 'Recipients',
        hintTo: 'Leave empty to mail yourself (the address above). Separate several addresses with commas.',
        autoPreset: 'Saving also selects the QQ provider preset: smtp.qq.com:465 with implicit TLS.',
        fieldPreset: 'Provider preset',
        hintPreset: 'Only QQ mail is offered: qq for a personal mailbox, qq-exmail for a corporate one. Empty derives it from the address.',
        optionAuto: 'Derive from the address',
        fieldHost: 'SMTP host',
        hintHost: 'For example smtp.qq.com.',
        fieldPort: 'Port',
        hintPort: '465 is implicit TLS, 587 is usually STARTTLS.',
        fieldTls: 'Transport security',
        hintTls: 'implicit is TLS from the first byte; starttls upgrades a plain connection; plain never encrypts.',
        optionTlsAuto: 'Derive from the port',
        fieldRequireTls: 'Require encryption',
        hintRequireTls: 'Refuses to send credentials over a cleartext link.',
        fieldVerifyCert: 'Verify the server certificate',
        hintVerifyCert: 'Keep this on unless a test server uses a self-signed certificate.',
        fieldFrom: 'From',
        hintFrom: 'Falls back to the mailbox address when empty.',
        fieldCc: 'Cc',
        hintCc: 'Optional.',
        fieldSubjectPrefix: 'Subject prefix',
        hintSubjectPrefix: 'Defaults to [DSH].',
        fieldPassEnv: 'Authorization-code environment variable',
        hintPassEnv: 'Defaults to DSH_SMTP_PASSWORD. A variable in the host process outranks the code in this document.',
        fieldPassCommand: 'Authorization-code command',
        hintPassCommand: 'A local command whose stdout is the code, e.g. macOS `security find-generic-password`.',
        logTitle: 'Activity log',
        hintLog: 'Every delivery result and plugin log line, newest first; the last 300 entries are kept.',
        logDelivered: 'delivered',
        logFailed: 'failed',
        logRefresh: 'Refresh',
        logTest: 'Send test',
        logTesting: 'Sending…',
        logFlush: 'Retry queue',
        logFlushing: 'Retrying…',
        logClear: 'Clear log',
        logClearing: 'Clearing…',
        logEmpty: 'Nothing recorded yet. "Send test" verifies the configuration right now.',
        logUnavailable: 'The log needs the host half: restart dsh web to publish it. The configuration above is unaffected.',
        logLoading: 'Reading…',
        logEmail: 'Email',
        logReady: 'ready',
        logNotReady: 'not configured',
        logQueued: 'queued',
        logLastSuccess: 'last success',
        logLastFailure: 'last failure',
        logNever: 'none yet',
        logTestResult: 'Test result',
        logActionFailed: 'Action failed',
        logFlushResult: 'Queue retry',
        logClearResult: 'Log cleared',
        logEntries: 'entries',
        levelInfo: 'info',
        levelWarn: 'warn',
        levelError: 'error',
      },
    }

    /**
     * Provider presets the card offers. The host half knows more of them — a
     * deployment that configures another provider in its composition or its
     * settings document keeps working — but this card configures QQ mail, and a
     * select of fifteen providers is the complexity it exists to remove.
     */
    const PRESETS = ['qq', 'qq-exmail']
    /** Alert languages the host understands. */
    const LANGUAGES = ['auto', 'zh', 'en']
    /** Transport modes the host understands. */
    const TLS_MODES = ['implicit', 'starttls', 'plain']
    /** Alert channels, in the order the host documents them. */
    const CHANNELS = ['sound', 'desktop', 'email']
    /** Severities the activity log renders, in dictionary order. */
    const LEVELS = ['info', 'warn', 'error']

    /**
     * Read a value at a path inside a settings section.
     *
     * @param {any} value - section root
     * @param {string[]} path - path from the root
     * @returns {any} the value, or undefined when any segment is missing
     */
    function readPath(value, path) {
      let current = value
      for (const key of path) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined
        current = current[key]
      }
      return current
    }

    /**
     * Convert a stored value to draft text.
     *
     * @param {any} value - stored value
     * @returns {string} the draft text
     */
    function asText(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    /**
     * Convert a stored list value to draft text.
     *
     * @param {any} value - stored value
     * @returns {string} the comma-separated draft text
     */
    function asListText(value) {
      if (Array.isArray(value)) return value.join(', ')
      return asText(value)
    }

    /**
     * Split a draft into a trimmed, de-duplicated list.
     *
     * @param {string} text - draft text
     * @returns {string[]} the entries
     */
    function asList(text) {
      const seen = new Set()
      for (const part of text.split(/[,\n;]+/)) {
        const entry = part.trim()
        if (entry !== '') seen.add(entry)
      }
      return [...seen]
    }

    /**
     * Whether an account is a QQ mailbox, and therefore implies the QQ preset.
     * Mirrors `inferPreset` in the host half: a bare QQ number, or a qq.com /
     * foxmail.com address.
     *
     * @param {string} text - the account draft
     * @returns {boolean} true when the host would resolve the QQ preset
     */
    function isQqAccount(text) {
      const value = text.trim()
      if (/^\d{5,12}$/.test(value)) return true
      return /@(qq\.com|foxmail\.com)$/i.test(value)
    }

    /**
     * Compare two JSON-shaped values structurally.
     *
     * @param {any} left - one value
     * @param {any} right - the other value
     * @returns {boolean} true when they are the same value
     */
    function sameJson(left, right) {
      if (left === right) return true
      if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]))
      }
      if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      return leftKeys.length === rightKeys.length && leftKeys.every((key) => sameJson(left[key], right[key]))
    }

    /**
     * Render one epoch millisecond value the way a log line wants it: a time for
     * today, a date and a time for anything older.
     *
     * @param {number} at - epoch milliseconds
     * @returns {string} the display form, or an empty string when unusable
     */
    function formatTime(at) {
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return ''
      const time = date.toLocaleTimeString()
      const today = new Date()
      const sameDay = date.getFullYear() === today.getFullYear()
        && date.getMonth() === today.getMonth()
        && date.getDate() === today.getDate()
      return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
    }

    /**
     * Draft converters. Each returns `{ kind: 'set', value }`, `{ kind: 'clear' }`
     * for "remove the override", or `undefined` when the draft is not a value the
     * field accepts — which blocks the save instead of silently dropping it.
     */
    const parse = {
      text: (value) => (value.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: value.trim() }),
      port: (value) => {
        const text = value.trim()
        if (text === '') return { kind: 'clear' }
        const port = Number(text)
        return Number.isInteger(port) && port >= 1 && port <= 65535 ? { kind: 'set', value: port } : undefined
      },
      bool: (value) => (value === 'true' ? { kind: 'set', value: true } : value === 'false' ? { kind: 'set', value: false } : undefined),
      list: (value) => {
        const entries = asList(value)
        return entries.length === 0 ? { kind: 'clear' } : { kind: 'set', value: entries }
      },
      channels: (value) => {
        const selected = new Set(asList(value).filter((entry) => CHANNELS.includes(entry)))
        const ordered = CHANNELS.filter((entry) => selected.has(entry))
        return ordered.length === 0 ? { kind: 'clear' } : { kind: 'set', value: ordered }
      },
    }

    /**
     * One editable row: where it writes, how it renders, and how its draft
     * converts.
     *
     * `group` names the fieldset it renders in, `kind` picks the control, and
     * `options` supplies a select's values (`emptyKey` is the localized label of
     * the empty choice, so "custom" and "derive from the port" read naturally).
     * Every row is normalized with the text defaults first, so a field only
     * names the converters it changes.
     *
     * The order is the card's reading order: what is on, which mailbox, and only
     * then the server details most operators never touch.
     */
    const FIELDS = [
      { field: 'enabled', path: ['enabled'], group: 'groupGeneral', kind: 'switch', label: 'fieldEnabled', hint: 'hintEnabled' },
      { field: 'channels', path: ['alerts', 'channels'], group: 'groupGeneral', kind: 'channels', label: 'fieldChannels', hint: 'hintChannels' },
      { field: 'emailEnabled', path: ['email', 'enabled'], group: 'groupGeneral', kind: 'switch', label: 'fieldEmailEnabled', hint: 'hintEmailEnabled' },
      { field: 'user', path: ['email', 'user'], group: 'groupMailbox', kind: 'text', label: 'fieldUser', hint: 'hintUser' },
      { field: 'pass', path: ['email', 'pass'], group: 'groupMailbox', kind: 'secret', label: 'fieldPass', hint: 'hintPass' },
      { field: 'to', path: ['email', 'to'], group: 'groupMailbox', kind: 'list', label: 'fieldTo', hint: 'hintTo' },
      {
        field: 'language',
        path: ['language'],
        group: 'groupAdvanced',
        kind: 'select',
        label: 'fieldLanguage',
        hint: 'hintLanguage',
        options: LANGUAGES,
        emptyKey: 'optionLanguageInherit',
      },
      {
        field: 'preset',
        path: ['email', 'preset'],
        group: 'groupAdvanced',
        kind: 'select',
        label: 'fieldPreset',
        hint: 'hintPreset',
        options: PRESETS,
        emptyKey: 'optionAuto',
      },
      { field: 'host', path: ['email', 'host'], group: 'groupAdvanced', kind: 'text', label: 'fieldHost', hint: 'hintHost' },
      { field: 'port', path: ['email', 'port'], group: 'groupAdvanced', kind: 'number', label: 'fieldPort', hint: 'hintPort', parse: parse.port },
      {
        field: 'tls',
        path: ['email', 'tls'],
        group: 'groupAdvanced',
        kind: 'select',
        label: 'fieldTls',
        hint: 'hintTls',
        options: TLS_MODES,
        emptyKey: 'optionTlsAuto',
      },
      { field: 'from', path: ['email', 'from'], group: 'groupAdvanced', kind: 'text', label: 'fieldFrom', hint: 'hintFrom' },
      { field: 'cc', path: ['email', 'cc'], group: 'groupAdvanced', kind: 'list', label: 'fieldCc', hint: 'hintCc' },
      { field: 'subjectPrefix', path: ['email', 'subjectPrefix'], group: 'groupAdvanced', kind: 'text', label: 'fieldSubjectPrefix', hint: 'hintSubjectPrefix' },
      { field: 'requireTls', path: ['email', 'requireTls'], group: 'groupAdvanced', kind: 'switch', label: 'fieldRequireTls', hint: 'hintRequireTls' },
      { field: 'verifyCert', path: ['email', 'verifyCert'], group: 'groupAdvanced', kind: 'switch', label: 'fieldVerifyCert', hint: 'hintVerifyCert' },
      { field: 'passEnv', path: ['email', 'passEnv'], group: 'groupAdvanced', kind: 'text', label: 'fieldPassEnv', hint: 'hintPassEnv' },
      { field: 'passCommand', path: ['email', 'passCommand'], group: 'groupAdvanced', kind: 'text', label: 'fieldPassCommand', hint: 'hintPassCommand' },
    ].map((spec) => ({
      format: spec.kind === 'list' || spec.kind === 'channels' ? asListText : asText,
      parse: spec.kind === 'list' ? parse.list : spec.kind === 'channels' ? parse.channels : spec.parse ?? parse.text,
      ...spec,
    }))

    /** The fieldset order the card renders. */
    const GROUPS = ['groupGeneral', 'groupMailbox', 'groupAdvanced']
    /** Groups rendered inside the collapsed advanced disclosure. */
    const ADVANCED_GROUPS = ['groupAdvanced']

    /** Field lookup. */
    const BY_FIELD = new Map(FIELDS.map((spec) => [spec.field, spec]))

    /**
     * Build the card's form model over one settings namespace.
     *
     * The model owns staged drafts, publishes one snapshot per change, and is
     * the only place a draft becomes a document mutation. Snapshot fields are
     * flat (`snapshot.host.text`), because the card reads whole snapshots
     * through its injected hook and a nested projection would mint a fresh
     * object per render — the classic `useSyncExternalStore` loop.
     *
     * @param {any} scope - the bound settings scope for this namespace
     * @param {any} describeFace - the shared describe mirror (for the secret sidecar)
     * @returns {any} the form model
     */
    function createForm(scope, describeFace) {
      /** @type {Map<string, { text: string, clear: boolean }>} */
      const staged = new Map()
      let saving = false
      let failed = false

      const store = createSnapshotStore(project())
      scope.subscribe(() => { publish() })
      describeFace.subscribe(() => { publish() })

      /** @returns {any} the namespace's wire view, when the mirror holds one */
      function namespaceView() {
        const view = describeFace.getSnapshot().view
        if (view === undefined) return undefined
        return view.namespaces.find((row) => row.ns === NS)
      }

      /**
       * Whether the host reports a stored value at one secret path.
       *
       * @param {string} path - dotted path from the section root
       * @returns {boolean} true when a value is stored
       */
      function secretSet(path) {
        const secret = namespaceView()?.secrets?.find((row) => row.path.join('.') === path)
        return secret?.set === true
      }

      /** @param {any} spec - the field's spec @returns {boolean} whether the user layer carries it */
      function stored(spec) {
        return readPath(scope.getSnapshot().user, spec.path) !== undefined
      }

      /** @param {any} spec - the field's spec @returns {any} the effective value */
      function effective(spec) {
        return readPath(scope.getSnapshot().value, spec.path)
      }

      /** @param {any} spec - the field's spec @returns {any} the value a reset returns to */
      function baseValue(spec) {
        const snapshot = scope.getSnapshot()
        const base = readPath(snapshot.base, spec.path)
        return base === undefined ? readPath(snapshot.value, spec.path) : base
      }

      /**
       * The account the form currently means: the staged draft when the user is
       * editing one, the effective value otherwise.
       *
       * @returns {string} the account draft
       */
      function accountDraft() {
        const edit = staged.get('user')
        if (edit !== undefined) return edit.clear === true ? '' : edit.text
        return asText(effective(BY_FIELD.get('user')))
      }

      /**
       * The provider preset a save writes on the user's behalf.
       *
       * A QQ address is the whole configuration the card asks for, and the host
       * half would infer the same preset anyway; writing it makes the settings
       * document say what it means. It is only written when the user configured
       * no preset and no host of their own, so an explicit choice is never
       * overwritten.
       *
       * @returns {{ op: 'set', path: string[], value: string } | undefined} the extra write, when one applies
       */
      function autoPresetOp() {
        const spec = BY_FIELD.get('preset')
        if (staged.has('preset') || stored(spec)) return undefined
        const host = readPath(scope.getSnapshot().value, ['email', 'host'])
        if (typeof host === 'string' && host.trim() !== '') return undefined
        if (!isQqAccount(accountDraft())) return undefined
        return { op: 'set', path: ['email', 'preset'], value: 'qq' }
      }

      /**
       * Every staged edit, and the operation a save would send for it. An entry
       * with no operation is either a no-op or an unparsable draft; the caller
       * distinguishes them by `invalid`.
       *
       * @returns {Array<{ field: string, spec: any, ops?: any[], invalid: boolean }>} the plan
       */
      function plan() {
        const items = []
        for (const [field, edit] of staged) {
          const spec = BY_FIELD.get(field)
          if (spec === undefined) continue
          if (spec.kind === 'secret') {
            const value = edit.text.trim()
            if (value !== '') items.push({ field, spec, ops: [{ op: 'set', path: spec.path, value }], invalid: false })
            else if (edit.clear === true && secretSet(SECRET_PATH)) items.push({ field, spec, ops: [{ op: 'unset', path: spec.path }], invalid: false })
            else items.push({ field, spec, invalid: false })
            continue
          }
          if (edit.clear === true) {
            if (stored(spec)) items.push({ field, spec, ops: [{ op: 'unset', path: spec.path }], invalid: false })
            else items.push({ field, spec, invalid: false })
            continue
          }
          if (edit.text === spec.format(effective(spec))) continue
          const write = spec.parse(edit.text)
          if (write === undefined) items.push({ field, spec, invalid: true })
          else if (write.kind === 'clear') items.push({ field, spec, ops: [{ op: 'unset', path: spec.path }], invalid: false })
          else items.push({ field, spec, ops: [{ op: 'set', path: spec.path, value: write.value }], invalid: false })
        }
        return items
      }

      /**
       * Whether a plan item landed, read back from what the host now serves.
       * The host is the only authority on whether a write was accepted, so a
       * save never predicts the outcome.
       *
       * @param {any} item - one plan item with operations
       * @returns {boolean} true when the section carries the intended state
       */
      function landed(item) {
        const operation = item.ops[item.ops.length - 1]
        if (operation.op === 'unset') {
          return item.spec.kind === 'secret' ? !secretSet(SECRET_PATH) : !stored(item.spec)
        }
        if (item.spec.kind === 'secret') return secretSet(SECRET_PATH)
        return sameJson(readPath(scope.getSnapshot().user, item.spec.path), operation.value)
      }

      /** @param {any} spec - the field's spec @returns {any} one row's rendered state */
      function rowState(spec) {
        const edit = staged.get(spec.field)
        if (spec.kind === 'secret') {
          return { text: edit?.text ?? '', overridden: false, invalid: false }
        }
        if (edit === undefined) {
          return { text: spec.format(effective(spec)), overridden: stored(spec), invalid: false }
        }
        const write = edit.clear === true ? { kind: 'clear' } : spec.parse(edit.text)
        return {
          text: edit.text,
          overridden: write !== undefined && write.kind === 'set',
          invalid: write === undefined,
        }
      }

      /** @returns {any} the published snapshot */
      function project() {
        const snapshot = scope.getSnapshot()
        const items = plan()
        const state = {
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          dirty: items.some((item) => item.ops !== undefined || item.invalid),
          invalid: items.some((item) => item.invalid),
          saving,
          failed,
          secretSet: secretSet(SECRET_PATH),
          autoPreset: autoPresetOp() !== undefined,
        }
        for (const spec of FIELDS) state[spec.field] = rowState(spec)
        return state
      }

      function publish() {
        store.set(project())
      }

      return {
        /** The store a card hook binds to. */
        store,
        /** @returns {any} the current snapshot */
        getSnapshot: () => store.getSnapshot(),
        /**
         * Stage one control's draft.
         *
         * @param {string} field - field name
         * @param {string} text - draft text
         * @returns {void}
         */
        edit(field, text) {
          staged.set(field, { text, clear: false })
          failed = false
          publish()
        },
        /**
         * Stage a clear, so the field re-inherits the layer below.
         *
         * @param {string} field - field name
         * @returns {void}
         */
        resetField(field) {
          const spec = BY_FIELD.get(field)
          if (spec === undefined) return
          staged.set(field, { text: spec.kind === 'secret' ? '' : spec.format(baseValue(spec)), clear: true })
          failed = false
          publish()
        },
        /** Drop every draft. */
        discard() {
          if (staged.size === 0 && !failed) return
          staged.clear()
          failed = false
          publish()
        },
        /**
         * Write every staged edit as one atomic mutation, then read the outcome
         * back. Drafts survive a save the host did not accept, so the user
         * corrects them instead of retyping.
         *
         * @returns {Promise<boolean>} whether every write landed
         */
        async save() {
          const items = plan()
          if (saving || items.length === 0 || items.some((item) => item.invalid || item.ops === undefined)) return false
          const auto = autoPresetOp()
          saving = true
          failed = false
          publish()
          await scope.mutate([...items.flatMap((item) => item.ops), ...auto === undefined ? [] : [auto]])
          const accepted = items.every((item) => landed(item))
            && (auto === undefined || sameJson(readPath(scope.getSnapshot().user, ['email', 'preset']), 'qq'))
          if (accepted) staged.clear()
          saving = false
          failed = !accepted
          publish()
          return accepted
        },
      }
    }

    /**
     * Post one endpoint to the host half and unwrap the envelope it answers with.
     *
     * The transport is an ordinary same-origin `fetch`: the route sits on
     * Connection's authenticated `/api` channel, so the browser's own cookie
     * carries the session and no client service has to be resolved first.
     *
     * @param {string} endpoint - the endpoint name
     * @param {any} payload - the JSON payload
     * @returns {Promise<any>} the endpoint's value
     */
    async function callHost(endpoint, payload) {
      const doFetch = globalThis.fetch
      if (typeof doFetch !== 'function') throw new Error('this page cannot reach the host')
      const response = await doFetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload: payload ?? {} }),
        credentials: 'same-origin',
      })
      if (!response.ok) {
        throw new Error(response.status === 404
          ? 'the host half is not published on this page (HTTP 404)'
          : `HTTP ${response.status}`)
      }
      const result = await response.json()
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new Error(result?.error?.message ?? 'the host refused the request')
      }
      return result.value
    }

    /**
     * Build the activity-log model behind the card's log panel.
     *
     * The model owns one snapshot, calls the host through {@link callHost}, and
     * never throws at its caller: a page whose host half is missing, a route
     * that is not published yet, or a request that fails all land in
     * `snapshot.error` so the panel can say so in one line instead of breaking
     * the settings tab.
     *
     * @param {(endpoint: string, payload: any) => Promise<any>} call - the host transport
     * @returns {any} the feed model
     */
    function createFeed(call) {
      let state = {
        available: false,
        loading: false,
        busy: undefined,
        error: undefined,
        entries: [],
        stats: undefined,
        status: undefined,
        queued: [],
        result: undefined,
        updatedAt: undefined,
      }
      const store = createSnapshotStore(state)
      let timer
      let cardOpen = false
      let logOpen = false

      /** @param {any} patch - the fields to merge @returns {void} */
      function publish(patch) {
        state = { ...state, ...patch }
        store.set(state)
      }

      /** Re-read the status and the newest entries. */
      async function refresh() {
        publish({ loading: true })
        try {
          const value = await call('snapshot', { limit: LOG_LIMIT })
          publish({
            available: true,
            loading: false,
            error: undefined,
            entries: Array.isArray(value.entries) ? value.entries : [],
            stats: value.stats,
            status: value.status,
            queued: Array.isArray(value.queued) ? value.queued : [],
            updatedAt: Date.now(),
          })
        } catch (error) {
          publish({ loading: false, error: describe(error) })
        }
      }

      /**
       * Run one action endpoint and refresh afterwards, whatever it returned.
       *
       * @param {string} name - the action name the panel renders
       * @param {string} endpoint - the endpoint to call
       * @param {any} [payload] - the JSON payload
       * @returns {Promise<void>} resolves once the panel has been updated
       */
      async function act(name, endpoint, payload) {
        if (state.busy !== undefined) return
        publish({ busy: name })
        try {
          const value = await call(endpoint, payload)
          publish({ busy: undefined, result: { kind: name, value } })
        } catch (error) {
          publish({ busy: undefined, result: { kind: name, error: describe(error) } })
        }
        await refresh()
      }

      /** Stop the polling timer, when one is running. */
      function stopTimer() {
        if (timer === undefined) return
        clearInterval(timer)
        timer = undefined
      }

      /**
       * Poll only while the panel is actually on screen: an open log inside an
       * open card. A closed card costs nothing.
       *
       * @returns {void}
       */
      function reconcileTimer() {
        if (!cardOpen || !logOpen) {
          stopTimer()
          return
        }
        if (timer !== undefined) return
        timer = setInterval(() => { void refresh() }, LOG_REFRESH_MS)
        if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
      }

      return {
        /** The store the card hook binds to. */
        store,
        /** @returns {any} the current snapshot */
        getSnapshot: () => store.getSnapshot(),
        /** Re-read the host on demand. */
        refresh,
        /**
         * @param {boolean} open - whether the card is expanded
         * @returns {Promise<void>} resolves once the read that follows has landed
         */
        setCardOpen(open) {
          cardOpen = open === true
          reconcileTimer()
          return cardOpen ? refresh() : Promise.resolve()
        },
        /**
         * @param {boolean} open - whether the log disclosure is expanded
         * @returns {Promise<void>} resolves once the read that follows has landed
         */
        setLogOpen(open) {
          logOpen = open === true
          reconcileTimer()
          return logOpen ? refresh() : Promise.resolve()
        },
        /** Fire a test alert over every configured channel. */
        test: () => act('test', 'test', { channel: 'all' }),
        /** Retry everything the durable outbox is holding. */
        flush: () => act('flush', 'flush'),
        /** Drop the retained activity entries. */
        clear: () => act('clear', 'clear'),
        /** Stop polling; called when the plugin unloads. */
        dispose: () => { stopTimer() },
      }
    }

    /**
     * Describe one thrown value for the panel.
     *
     * @param {unknown} error - the thrown value
     * @returns {string} a printable line
     */
    function describe(error) {
      if (error instanceof Error) return error.message
      if (typeof error === 'string') return error
      return 'the request failed'
    }

    /**
     * Render one row: label, control, hint, and the reset that stages a clear.
     *
     * @param {any} spec - the field's spec
     * @param {any} state - the published snapshot
     * @param {any} props - the card's props (actions and copy)
     * @returns {any} the row element
     */
    function renderRow(spec, state, props) {
      const { t } = props
      const row = state[spec.field]
      const disabled = !state.writable
      const id = `${NS}-${spec.field}`
      const control = () => {
        const shared = {
          id,
          className: 'dshNotifyLongControl',
          disabled,
          value: row.text,
          onChange: (event) => { props.edit(spec.field, event.target.value) },
        }
        if (spec.kind === 'select') {
          const options = [React.createElement('option', { key: '', value: '' }, t(spec.emptyKey))]
          for (const option of spec.options) options.push(React.createElement('option', { key: option, value: option }, option))
          return React.createElement('select', shared, options)
        }
        if (spec.kind === 'number') return React.createElement('input', { ...shared, type: 'number', inputMode: 'numeric', min: 1, max: 65535 })
        if (spec.kind === 'secret') return React.createElement('input', { ...shared, type: 'password', autoComplete: 'new-password' })
        return React.createElement('input', { ...shared, type: 'text' })
      }
      const channels = () => {
        const selected = new Set(asList(row.text))
        return React.createElement('div', { className: 'dshNotifyLongChecks', id }, CHANNELS.map((channel) => {
          const channelId = `${id}-${channel}`
          return React.createElement('label', {
            key: channel,
            className: 'dshNotifyLongCheck',
            htmlFor: channelId,
          }, React.createElement('input', {
            id: channelId,
            type: 'checkbox',
            checked: selected.has(channel),
            disabled,
            onChange: (event) => {
              const next = new Set(selected)
              if (event.target.checked) next.add(channel)
              else next.delete(channel)
              props.edit(spec.field, CHANNELS.filter((entry) => next.has(entry)).join(','))
            },
          }), t(`channel${channel[0].toUpperCase()}${channel.slice(1)}`))
        }))
      }
      const toggle = () => React.createElement('label', { className: 'dshNotifyLongCheck', htmlFor: id },
        React.createElement('input', {
          id,
          type: 'checkbox',
          checked: row.text === 'true',
          disabled,
          onChange: (event) => { props.edit(spec.field, event.target.checked ? 'true' : 'false') },
        }),
        t(spec.label))
      const hint = row.invalid ? t('invalid') : spec.kind === 'secret' && row.text.trim() === ''
        ? `${t(state.secretSet ? 'configured' : 'notConfigured')} — ${t(spec.hint)}`
        : t(spec.hint)
      return React.createElement('div', { className: 'dshNotifyLongRow', key: spec.field },
        spec.kind === 'switch' ? null : React.createElement('label', { className: 'dshNotifyLongLabel', htmlFor: id },
          t(spec.label),
          row.overridden ? React.createElement('span', { className: 'dshNotifyLongBadge' }, t('overridden')) : null,
          row.overridden || (spec.kind === 'secret' && state.secretSet)
            ? React.createElement('button', {
              type: 'button',
              className: 'dshNotifyLongReset',
              disabled,
              onClick: () => { props.resetField(spec.field) },
            }, spec.kind === 'secret' ? t('secretClear') : t('reset'))
            : null),
        spec.kind === 'switch' ? toggle() : spec.kind === 'channels' ? channels() : control(),
        React.createElement('p', { className: row.invalid ? 'dshNotifyLongHint dshNotifyLongInvalid' : 'dshNotifyLongHint' }, hint))
    }

    /**
     * Render one fieldset of the form.
     *
     * @param {string} group - the group key (also its dictionary key)
     * @param {any} state - the form snapshot
     * @param {any} props - the card's props
     * @returns {any} the fieldset element
     */
    function renderGroup(group, state, props) {
      return React.createElement('fieldset', { key: group, className: 'dshNotifyLongGroup' },
        React.createElement('legend', null, props.t(group)),
        FIELDS.filter((spec) => spec.group === group).map((spec) => renderRow(spec, state, props)))
    }

    /**
     * The status line above the log: what is on, where mail goes, what is queued.
     *
     * @param {any} status - the host's status projection
     * @param {any} stats - the activity-log summary
     * @param {any} t - locale-bound copy
     * @returns {string} one line
     */
    function statusLine(status, stats, t) {
      const email = status.email ?? {}
      const route = email.ready
        ? `${t('logReady')} ${email.host}:${email.port} → ${(email.to ?? []).join(', ') || '—'}`
        : t('logNotReady')
      const summary = stats ?? {}
      const parts = [`${t('logEmail')}: ${route}`, `${t('logQueued')}: ${status.queued ?? 0}`]
      parts.push(`${t('logLastSuccess')}: ${summary.lastSuccess === undefined ? t('logNever') : formatTime(summary.lastSuccess.at)}`)
      if (summary.lastFailure !== undefined) parts.push(`${t('logLastFailure')}: ${formatTime(summary.lastFailure.at)}`)
      return parts.join(' · ')
    }

    /**
     * Render the outcome of the last panel action: a test alert's per-channel
     * lines, a queue retry summary, or a cleared count.
     *
     * @param {any} result - the recorded action result
     * @param {any} t - locale-bound copy
     * @returns {any} the paragraph element, or null
     */
    function renderResult(result, t) {
      if (result === undefined) return null
      if (result.error !== undefined) {
        return React.createElement('p', { className: 'dshNotifyLongResult dshNotifyLongInvalid' }, `${t('logActionFailed')}: ${result.error}`)
      }
      const value = result.value ?? {}
      if (result.kind === 'test') {
        const lines = ['sound', 'desktop', 'email']
          .filter((channel) => typeof value[channel] === 'string' && value[channel] !== 'not requested')
          .map((channel) => `${channel}: ${value[channel]}`)
        return React.createElement('p', { className: 'dshNotifyLongResult' }, `${t('logTestResult')} — ${lines.join('\n')}`)
      }
      if (result.kind === 'flush') {
        return React.createElement('p', { className: 'dshNotifyLongResult' }, `${t('logFlushResult')}: ${value.delivered} / ${value.failed} / ${value.dropped}`)
      }
      return React.createElement('p', { className: 'dshNotifyLongResult' }, `${t('logClearResult')} (${value.cleared ?? 0})`)
    }

    /**
     * Render the activity-log panel: status, actions, last result, and entries.
     *
     * @param {any} log - the feed snapshot
     * @param {any} props - the card's props
     * @returns {any} the disclosure element
     */
    function renderLog(log, props) {
      const { t } = props
      const stats = log.stats
      const summary = stats === undefined
        ? t('logTitle')
        : `${t('logTitle')} · ${t('logDelivered')} ${stats.delivered} · ${t('logFailed')} ${stats.failed}`
      const body = []
      if (log.available && log.status !== undefined) {
        body.push(React.createElement('p', { key: 'status', className: 'dshNotifyLongStatus' }, statusLine(log.status, log.stats, t)))
      }
      // What is still waiting, by name: a count alone does not tell the operator
      // which alert never arrived.
      if (log.queued.length > 0) {
        body.push(React.createElement('p', { key: 'queued', className: 'dshNotifyLongStatus' },
          `${t('logQueued')}: ${log.queued.map((record) => `${record.kind} “${record.title}” (${record.attempts})`).join(' · ')}`))
      }
      if (!log.available) {
        body.push(React.createElement('p', { key: 'unavailable', className: 'dshNotifyLongHint' },
          log.loading ? t('logLoading') : `${t('logUnavailable')}${log.error === undefined ? '' : ` (${log.error})`}`))
      }
      body.push(React.createElement('div', { key: 'bar', className: 'dshNotifyLongLogBar' },
        React.createElement('button', {
          type: 'button',
          className: 'dshNotifyLongButton dshNotifyLongDiscard',
          disabled: log.busy !== undefined,
          onClick: () => { props.refreshLog() },
        }, t('logRefresh')),
        React.createElement('button', {
          type: 'button',
          className: 'dshNotifyLongButton dshNotifyLongDiscard',
          disabled: log.busy !== undefined,
          onClick: () => { props.testLog() },
        }, t(log.busy === 'test' ? 'logTesting' : 'logTest')),
        React.createElement('button', {
          type: 'button',
          className: 'dshNotifyLongButton dshNotifyLongDiscard',
          disabled: log.busy !== undefined,
          onClick: () => { props.flushQueue() },
        }, t(log.busy === 'flush' ? 'logFlushing' : 'logFlush')),
        React.createElement('button', {
          type: 'button',
          className: 'dshNotifyLongButton dshNotifyLongDiscard',
          disabled: log.busy !== undefined,
          onClick: () => { props.clearLog() },
        }, t(log.busy === 'clear' ? 'logClearing' : 'logClear'))))
      const result = renderResult(log.result, t)
      if (result !== null) body.push(React.createElement('div', { key: 'result' }, result))
      body.push(React.createElement('p', { key: 'hint', className: 'dshNotifyLongHint' }, t('hintLog')))
      if (log.entries.length === 0) {
        body.push(React.createElement('p', { key: 'empty', className: 'dshNotifyLongHint' }, t('logEmpty')))
      } else {
        body.push(React.createElement('ul', { key: 'entries', className: 'dshNotifyLongEntries' }, log.entries.map((entry, index) => {
          const level = LEVELS.includes(entry.level) ? entry.level : 'info'
          const children = [
            React.createElement('span', { key: 'time', className: 'dshNotifyLongTime' }, formatTime(entry.at)),
            React.createElement('span', { key: 'level', className: `dshNotifyLongLevel dshNotifyLongLevel-${level}` }, t(`level${level[0].toUpperCase()}${level.slice(1)}`)),
            React.createElement('span', { key: 'message', className: 'dshNotifyLongMessage' }, entry.message),
          ]
          for (const [failureIndex, failure] of (entry.failures ?? []).entries()) {
            children.push(React.createElement('span', { key: `failure-${failureIndex}`, className: 'dshNotifyLongFailure' }, failure))
          }
          return React.createElement('li', { key: `${entry.at}-${index}`, className: 'dshNotifyLongEntry' }, children)
        })))
      }
      return React.createElement('details', {
        className: 'dshNotifyLongLog',
        onToggle: (event) => { props.setLogOpen(event.currentTarget.open === true) },
      },
      React.createElement('summary', null, summary),
      React.createElement('div', { className: 'dshNotifyLongLogBody' }, body))
    }

    /**
     * Render the plugin's entry on the Plugins page.
     *
     * The page asks twice for the same registration: `view: 'summary'` for the
     * one-liner in the list, and `view: 'page'` for the body it mounts once the
     * entry is opened. The hooks run before the branch so the summary render
     * keeps the same hook order as the page render.
     *
     * @param {any} props - injected hooks, staged actions, and locale copy
     * @returns {any} the one-liner, the page body, or null while unserved
     */
    function Card(props) {
      const state = props.useNotifySettings((snapshot) => snapshot)
      const log = props.useNotifyLog((snapshot) => snapshot)
      const { t } = props
      // The page, not a disclosure, decides when the card is on screen now, so
      // the log polling window is tied to the page view's lifetime.
      React.useEffect(() => {
        if (props.view !== 'page') return undefined
        void props.setCardOpen(true)
        return () => { void props.setCardOpen(false) }
      }, [props.view])
      if (props.view === 'summary') return t('cardDescription')
      if (!state.available) return null
      return React.createElement('div', { className: 'dshNotifyLongCard' },
        React.createElement('div', { className: 'dshNotifyLongBody' },
          state.writable ? null : React.createElement('p', { className: 'dshNotifyLongReadOnly' }, t('readOnly')),
          GROUPS.filter((group) => !ADVANCED_GROUPS.includes(group)).map((group) => renderGroup(group, state, props)),
          state.autoPreset
            ? React.createElement('p', { className: 'dshNotifyLongHint' }, t('autoPreset'))
            : null,
          React.createElement('details', { className: 'dshNotifyLongAdvanced' },
            React.createElement('summary', null, t('groupAdvanced')),
            React.createElement('div', { className: 'dshNotifyLongAdvancedBody' },
              React.createElement('fieldset', { className: 'dshNotifyLongGroup' },
                FIELDS.filter((spec) => spec.group === 'groupAdvanced').map((spec) => renderRow(spec, state, props))))),
          renderLog(log, props),
          React.createElement('div', { className: 'dshNotifyLongFooter' },
            state.failed ? React.createElement('p', { className: 'dshNotifyLongFailed' }, t('saveFailed')) : null,
            state.dirty ? React.createElement('span', { className: 'dshNotifyLongBadge' }, t('unsaved')) : null,
            log.available && log.stats !== undefined && log.stats.failed > 0
              ? React.createElement('span', { className: 'dshNotifyLongBadge dshNotifyLongBadgeWarn' }, `${t('logFailed')} ${log.stats.failed}`)
              : null,
            React.createElement('button', {
              type: 'button',
              className: 'dshNotifyLongButton dshNotifyLongDiscard',
              disabled: !state.dirty || state.saving,
              onClick: () => { props.discard() },
            }, t('discard')),
            React.createElement('button', {
              type: 'button',
              className: 'dshNotifyLongButton dshNotifyLongSave',
              disabled: !state.dirty || state.invalid || state.saving,
              onClick: () => { props.save() },
            }, t(state.saving ? 'saving' : 'save')))))
    }

    /** Install this plugin's stylesheet once. */
    function installStyles() {
      if (typeof document === 'undefined') return
      const id = `${NS}/settings-card.css`
      const selector = `style[data-plugin-css=${JSON.stringify(id)}]`
      if (document.querySelector(selector) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = id
      tag.textContent = css
      document.head.append(tag)
    }

    /** Cordis plugin name, matching the host half and the config namespace. */
    exports.name = NS

    /**
     * Services this browser plugin consumes. `configForms` and `connection` are
     * deliberately absent: they are requested through `ctx.inject` (or read
     * lazily, for the RPC caller) so a deployment that composes this plugin
     * without the settings domain still activates — a strict dependency here
     * would leave the entry pending, and the web boot fails loud on pending
     * entries.
     */
    exports.inject = ['slots', 'locale']

    /**
     * Register the entry on the Plugins page.
     *
     * @param {any} ctx - the browser plugin context
     * @returns {void}
     */
    exports.apply = (ctx) => {
      installStyles()
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTIONARY), 'dsh-notify-long: settings dictionary')
      const feed = createFeed(callHost)
      ctx.effect(() => () => feed.dispose(), 'dsh-notify-long: activity log polling')
      // 0.2 replaced the `settingsScope` service with `configForms`, and the
      // `settings.plugin.item` seat with `plugins.item` on the sidebar's Plugins
      // page. `get(namespace)` still hands back the same read/subscribe/mutate
      // face the form was written against — the namespace is now the *host
      // profile entry id*, which is this package's name because its own bundle
      // patch inserts the row under that id.
      ctx.inject(['configForms'], (settingsCtx) => {
        const configForms = settingsCtx.configForms
        const scope = configForms.get(NS)
        const describeFace = configForms.describe()
        describeFace.ensure()
        const form = createForm(scope, describeFace)
        // `whileServed` is what keeps the entry honest: the page is registered
        // only while the host actually serves this namespace, so a deployment
        // whose host half is absent (or whose Config declares no volatile field)
        // shows no entry rather than a dead one.
        ctx.effect(() => configForms.whileServed([NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          // A list slot is addressed by `id`; `key` belongs to keyed slots.
          id: NS,
          // After the official settings pages, which sit at 10–40.
          order: 60,
          label: () => t('cardTitle'),
          locale: LOCALE_NS,
          inject: () => ({
            hooks: { notifySettings: form.store, notifyLog: feed.store },
            edit: form.edit,
            resetField: form.resetField,
            discard: form.discard,
            save: form.save,
            refreshLog: feed.refresh,
            setCardOpen: feed.setCardOpen,
            setLogOpen: feed.setLogOpen,
            testLog: feed.test,
            flushQueue: feed.flush,
            clearLog: feed.clear,
          }),
        }, Card))), 'dsh-notify-long: plugins page entry')
      })
    }

    return module.exports
  },
})

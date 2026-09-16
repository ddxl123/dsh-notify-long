/**
 * Message catalogue for outbound alerts.
 *
 * The email a human reads at 3 a.m. should be in the language that human reads,
 * and the machine composing it already knows which one that is: the harness has
 * no host-side locale service, but the operating system does — `Intl` reports
 * the same locale macOS or Linux is set to, and `LANG` says so on a headless
 * box. So `language: auto` (the shipped default) resolves from the system, and
 * `en` / `zh` pin it.
 *
 * Two rules keep this honest:
 *
 * - **An unset language means English**, not "detect". Detection is opt-in via
 *   the literal `auto`, which is what the composition default sets. Library
 *   callers and tests therefore get deterministic output on any machine.
 * - **Every key exists in every language.** `test/i18n.test.js` asserts it, so a
 *   message added to one catalogue cannot silently fall back to English in the
 *   other.
 *
 * The values are functions where a sentence needs a value interpolated; a
 * template language would be more machinery than this plugin needs.
 *
 * @module dsh-notify-long/lib/core/i18n
 */

/** Languages a deployment can ask for. */
export const LANGUAGES = Object.freeze(['auto', 'en', 'zh'])

/**
 * @typedef {object} Messages
 * @property {string} language - the resolved language code
 * @property {string} kindCompleted - subject label per notification kind
 * @property {Function} finishedTitle - `Finished: <session>` and friends
 */

/** @type {Record<'en' | 'zh', any>} */
export const MESSAGES = {
  en: {
    language: 'en',

    // Subject labels, one per notification kind.
    kindCompleted: 'task finished',
    kindQuestion: 'your input is needed',
    kindApproval: 'approval needed',
    kindError: 'error',
    kindSubagent: 'subagent finished',
    kindTest: 'test alert',
    kindManual: 'notice',

    // Titles.
    taskFinished: 'Task finished',
    finishedTitle: (title) => `Finished: ${title}`,
    failedTitle: (title) => `Failed: ${title}`,
    errorTitle: (title) => `Error: ${title}`,
    questionTitle: (title) => `Needs your input: ${title}`,
    approvalTitle: (title) => `Approval needed: ${title}`,
    subagentTitle: (title) => `Subagent finished: ${title}`,

    // Bodies.
    questionOptions: (list) => `   options: ${list}`,
    approvalWaiting: (what) => `The agent is waiting for permission to run ${what}.`,
    subagentStopReason: (reason) => `stop reason: ${reason}`,
    completionStats: (stats) => `(${stats.join(', ')})`,
    toolCalls: (count) => `${count} tool call(s)`,
    toolErrors: (count) => `${count} failed tool call(s)`,
    turn: (turn) => `turn ${turn}`,
    digestTitle: (count) => `${count} notifications while you were away`,
    digestHint: 'These were queued by dsh-notify-long because they could not be delivered when they happened.',
    squashTitle: (count, reason) => `${count} notifications (${reason})`,
    testTitle: 'dsh-notify-long test alert',
    testBody: (time) => `Verification requested at ${time}.`,

    // Hints.
    hintRetryStep: 'Open the session to see the failure and retry the step.',
    hintSessionLog: 'The session failed outside a turn; inspect the session log.',
    hintAnswer: 'Answer in the DeepSeek Harness so the agent can continue.',
    hintApprove: 'Approve or reject the request in the DeepSeek Harness.',

    // Fact labels in the message body.
    labelEvent: 'Event',
    labelSession: 'Session',
    labelSessionId: 'Session id',
    labelDirectory: 'Directory',
    labelTime: 'Time',
    labelUrgency: 'Urgency',
    labelDetail: 'Detail',
    labelNext: 'Next',
    footer: 'Sent by dsh-notify-long (DeepSeek Harness).',
    footerShort: 'Sent by dsh-notify-long',

    // Urgency words.
    urgencyInfo: 'info',
    urgencyAction: 'action',
    urgencyError: 'error',

    // Fallback nouns.
    agentRun: 'agent run',
    agentTurn: 'agent turn',
    anAction: 'an action',
  },
  zh: {
    language: 'zh',

    kindCompleted: '任务完成',
    kindQuestion: '需要你回答',
    kindApproval: '需要授权',
    kindError: '执行出错',
    kindSubagent: '子任务完成',
    kindTest: '测试通知',
    kindManual: '通知',

    taskFinished: '任务完成',
    finishedTitle: (title) => `已完成：${title}`,
    failedTitle: (title) => `执行失败：${title}`,
    errorTitle: (title) => `出错：${title}`,
    questionTitle: (title) => `需要你的输入：${title}`,
    approvalTitle: (title) => `需要授权：${title}`,
    subagentTitle: (title) => `子任务完成：${title}`,

    questionOptions: (list) => `   可选项：${list}`,
    approvalWaiting: (what) => `agent 正在等待你允许它执行 ${what}。`,
    subagentStopReason: (reason) => `停止原因：${reason}`,
    completionStats: (stats) => `（${stats.join('，')}）`,
    toolCalls: (count) => `${count} 次工具调用`,
    toolErrors: (count) => `${count} 次工具调用失败`,
    turn: (turn) => `第 ${turn} 轮`,
    digestTitle: (count) => `你不在时有 ${count} 条通知`,
    digestHint: '这些通知是 dsh-notify-long 在你离开期间无法投递、排队积攒下来的。',
    squashTitle: (count, reason) => `${count} 条通知（${reason}）`,
    testTitle: 'dsh-notify-long 测试通知',
    testBody: (time) => `验证请求时间：${time}。`,

    hintRetryStep: '打开会话可以看到失败详情，并重试这一步。',
    hintSessionLog: '会话在轮次之外失败，请查看会话日志。',
    hintAnswer: '在 DeepSeek Harness 里回答后，agent 才能继续。',
    hintApprove: '在 DeepSeek Harness 里批准或拒绝这个请求。',

    labelEvent: '事件',
    labelSession: '会话',
    labelSessionId: '会话 ID',
    labelDirectory: '工作目录',
    labelTime: '时间',
    labelUrgency: '紧急程度',
    labelDetail: '详情',
    labelNext: '下一步',
    footer: '由 dsh-notify-long（DeepSeek Harness）发送。',
    footerShort: '由 dsh-notify-long 发送',

    urgencyInfo: '提示',
    urgencyAction: '需要处理',
    urgencyError: '错误',

    agentRun: 'agent 运行',
    agentTurn: 'agent 轮次',
    anAction: '某个操作',
  },
}

/**
 * Read the language the operating system is set to.
 *
 * `Intl` is consulted first because it reflects the user's actual locale (on
 * macOS it is the AppleLocale, not `LANG`), then the environment variables a
 * headless machine sets. Anything not recognisably Chinese resolves to English:
 * the catalogue is deliberately small, and guessing wrong in English is better
 * than emitting a language nobody configured.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read, defaults to the process
 * @param {string} [locale] - an already-known locale, for callers and tests that must not depend on the machine
 * @returns {'en' | 'zh'} the system language
 */
export function systemLanguage(env = globalThis.process?.env ?? {}, locale = undefined) {
  const candidates = [
    locale ?? (typeof Intl === 'object' && Intl !== null ? Intl.DateTimeFormat().resolvedOptions().locale : ''),
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
  ]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').toLowerCase()
    if (value.startsWith('zh')) return 'zh'
    if (/^[a-z]{2}/.test(value)) return 'en'
  }
  return 'en'
}

/**
 * Resolve the configured language to a catalogue key.
 *
 * @param {unknown} configured - the `language` setting
 * @param {NodeJS.ProcessEnv} [env] - environment used when the setting is `auto`
 * @returns {'en' | 'zh'} the language to render in
 */
export function resolveLanguage(configured, env) {
  const value = String(configured ?? '').trim().toLowerCase()
  if (value === 'zh' || value.startsWith('zh-')) return 'zh'
  if (value === 'auto') return systemLanguage(env)
  return 'en'
}

/**
 * The message catalogue for one language.
 *
 * @param {unknown} configured - the `language` setting (`auto`, `en`, `zh`, or unset)
 * @param {NodeJS.ProcessEnv} [env] - environment used when the setting is `auto`
 * @returns {Messages} the catalogue
 */
export function messagesFor(configured, env) {
  return MESSAGES[resolveLanguage(configured, env)]
}

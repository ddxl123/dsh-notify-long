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
    kindRetry: 'model retry',
    kindSubagent: 'subagent finished',
    kindTest: 'test alert',
    kindManual: 'notice',
    kindPlan: 'plan ready',
    kindTask: 'task progress',
    kindStall: 'run stalled',
    kindAccount: 'sign-in needed',
    kindGoal: 'goal stopped',
    kindWorkflow: 'workflow failed',
    kindJob: 'background job failed',

    // Titles.
    taskFinished: 'Task finished',
    finishedTitle: (title) => `Finished: ${title}`,
    failedTitle: (title) => `Failed: ${title}`,
    errorTitle: (title) => `Error: ${title}`,
    retryTitle: (title) => `Retrying model request: ${title}`,
    questionTitle: (title) => `Needs your input: ${title}`,
    approvalTitle: (title) => `Approval needed: ${title}`,
    subagentTitle: (title) => `Subagent finished: ${title}`,
    planTitle: (title) => `Plan ready for review: ${title}`,
    taskTitle: (done, total) => `Task progress ${done}/${total}`,
    taskDoneTitle: (total) => `All tasks completed (${total})`,
    taskClearedTitle: 'Task list cleared',
    stallTitle: (minutes, title) => `No progress for ${minutes} min: ${title}`,
    accountTitle: (what) => `Sign-in required: ${what}`,
    goalTitle: (title) => `Goal stopped: ${title}`,
    workflowTitle: (name) => `Workflow failed: ${name}`,
    jobTitle: (label) => `Background job failed: ${label}`,

    // Bodies.
    questionOptions: (list) => `   options: ${list}`,
    approvalWaiting: (what) => `The agent is waiting for permission to run ${what}.`,
    subagentStopReason: (reason) => `stop reason: ${reason}`,
    retryFailure: (reason) => `Failure reason: ${reason}`,
    retryNoFailure: 'the provider returned no failure message',
    retryDelay: (milliseconds) => `Retry delay: ${milliseconds >= 1_000 ? `${Math.round(milliseconds / 100) / 10} s` : `${Math.round(milliseconds)} ms`}`,
    retryAttempt: (retry, maximum) => (maximum === undefined ? `attempt ${retry} (no limit)` : `attempt ${retry} of ${maximum}`),
    retryProvider: (provider) => `provider: ${provider}`,
    completionStats: (stats) => `(${stats.join(', ')})`,
    toolCalls: (count) => `${count} tool call(s)`,
    toolErrors: (count) => `${count} failed tool call(s)`,
    turn: (turn) => `turn ${turn}`,
    digestTitle: (count) => `${count} notifications while you were away`,
    digestHint: 'These were queued by dsh-notify-long because they could not be delivered when they happened.',
    squashTitle: (count, reason) => `${count} notifications (${reason})`,
    testTitle: 'dsh-notify-long test alert',
    testBody: (time) => `Verification requested at ${time}.`,
    planWaiting: 'The agent presented a plan and is waiting for your review.',
    planDetailNote: 'The plan follows.',
    taskCounts: (done, total) => `${done} of ${total} completed`,
    taskNow: (list) => `in progress: ${list}`,
    taskNothingNow: 'nothing in progress',
    taskCleared: 'the model replaced its task list with an empty one',
    stallBody: (minutes) => `No stream output, tool result or session event for ${minutes} minute(s) while the turn is still running.`,
    stallLastTool: (tool) => `last tool seen: ${tool}`,
    stallNoTool: 'no tool has run yet in this turn',
    accountSignIn: 'A model request needs you to sign in to the DeepSeek account.',
    accountExpired: 'The DeepSeek account session expired; the stored credential was removed.',
    accountAuthFailed: (key) => `Authorization for ${key} failed.`,
    goalBlocked: (reason) => `The goal was marked blocked: ${reason}`,
    goalRounds: (rounds, maximum) => `rounds started: ${rounds}/${maximum}`,
    workflowStopped: (reason) => `stop reason: ${reason}`,
    workflowAgents: (count) => `${count} agent(s) started`,
    jobFailed: (kind) => `A background ${kind} job failed.`,

    // Hints.
    hintRetryStep: 'Open the session to see the failure and retry the step.',
    hintSessionLog: 'The session failed outside a turn; inspect the session log.',
    hintAnswer: 'Answer in the DeepSeek Harness so the agent can continue.',
    hintApprove: 'Approve or reject the request in the DeepSeek Harness.',
    hintRetryAuto: 'The harness retries by itself, so there is nothing to do — unless the retries keep failing, which points at your network or the provider.',
    hintPlan: 'Approve the plan, or keep planning with feedback, in the DeepSeek Harness.',
    hintTask: 'Progress report only — nothing to do.',
    hintStall: 'The run may be hung. Check the session and stop it if nothing is happening.',
    hintAccount: 'Sign in again (or refresh the credential), then retry.',
    hintGoal: 'Reopen the goal or adjust its objective to continue.',
    hintWorkflow: 'Inspect the workflow run before starting it again.',
    hintJob: 'Read the job output in its session.',

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
    kindRetry: '模型请求重试',
    kindSubagent: '子任务完成',
    kindTest: '测试通知',
    kindManual: '通知',
    kindPlan: '计划待批准',
    kindTask: '任务进度',
    kindStall: '任务卡住',
    kindAccount: '登录失效',
    kindGoal: '目标停摆',
    kindWorkflow: '工作流出错',
    kindJob: '后台任务失败',

    taskFinished: '任务完成',
    finishedTitle: (title) => `已完成：${title}`,
    failedTitle: (title) => `执行失败：${title}`,
    errorTitle: (title) => `出错：${title}`,
    retryTitle: (title) => `模型请求重试：${title}`,
    questionTitle: (title) => `需要你的输入：${title}`,
    approvalTitle: (title) => `需要授权：${title}`,
    subagentTitle: (title) => `子任务完成：${title}`,
    planTitle: (title) => `计划待批准：${title}`,
    taskTitle: (done, total) => `任务进度 ${done}/${total}`,
    taskDoneTitle: (total) => `任务全部完成（${total} 项）`,
    taskClearedTitle: '任务清单已清空',
    stallTitle: (minutes, title) => `已 ${minutes} 分钟没有进展：${title}`,
    accountTitle: (what) => `需要重新登录：${what}`,
    goalTitle: (title) => `目标停摆：${title}`,
    workflowTitle: (name) => `工作流出错：${name}`,
    jobTitle: (label) => `后台任务失败：${label}`,

    questionOptions: (list) => `   可选项：${list}`,
    approvalWaiting: (what) => `agent 正在等待你允许它执行 ${what}。`,
    subagentStopReason: (reason) => `停止原因：${reason}`,
    retryFailure: (reason) => `失败原因：${reason}`,
    retryNoFailure: '提供方没有返回失败信息',
    retryDelay: (milliseconds) => `重试延迟：${milliseconds >= 1_000 ? `${Math.round(milliseconds / 100) / 10} 秒` : `${Math.round(milliseconds)} 毫秒`}`,
    retryAttempt: (retry, maximum) => (maximum === undefined ? `第 ${retry} 次重试（不限次数）` : `第 ${retry}/${maximum} 次重试`),
    retryProvider: (provider) => `提供方：${provider}`,
    completionStats: (stats) => `（${stats.join('，')}）`,
    toolCalls: (count) => `${count} 次工具调用`,
    toolErrors: (count) => `${count} 次工具调用失败`,
    turn: (turn) => `第 ${turn} 轮`,
    digestTitle: (count) => `你不在时有 ${count} 条通知`,
    digestHint: '这些通知是 dsh-notify-long 在你离开期间无法投递、排队积攒下来的。',
    squashTitle: (count, reason) => `${count} 条通知（${reason}）`,
    testTitle: 'dsh-notify-long 测试通知',
    testBody: (time) => `验证请求时间：${time}。`,
    planWaiting: 'agent 提交了计划，正在等你审阅。',
    planDetailNote: '计划正文如下。',
    taskCounts: (done, total) => `已完成 ${done}/${total}`,
    taskNow: (list) => `进行中：${list}`,
    taskNothingNow: '当前没有进行中的条目',
    taskCleared: '模型把任务清单改成了空清单',
    stallBody: (minutes) => `轮次仍在运行，但已经 ${minutes} 分钟没有流式输出、工具结果或会话事件。`,
    stallLastTool: (tool) => `最后看到的工具：${tool}`,
    stallNoTool: '这一轮还没有工具跑过',
    accountSignIn: '模型请求需要你重新登录 DeepSeek 账号。',
    accountExpired: 'DeepSeek 账号会话已过期，本地凭据已被移除。',
    accountAuthFailed: (key) => `${key} 的授权失败了。`,
    goalBlocked: (reason) => `目标被标记为阻塞：${reason}`,
    goalRounds: (rounds, maximum) => `已开始轮次：${rounds}/${maximum}`,
    workflowStopped: (reason) => `停止原因：${reason}`,
    workflowAgents: (count) => `已启动 ${count} 个子 agent`,
    jobFailed: (kind) => `一个后台 ${kind} 任务失败了。`,

    hintRetryStep: '打开会话可以看到失败详情，并重试这一步。',
    hintSessionLog: '会话在轮次之外失败，请查看会话日志。',
    hintAnswer: '在 DeepSeek Harness 里回答后，agent 才能继续。',
    hintApprove: '在 DeepSeek Harness 里批准或拒绝这个请求。',
    hintRetryAuto: '这是 harness 的自动重试，通常无需操作；如果一直重试失败，请检查网络或模型服务。',
    hintPlan: '在 DeepSeek Harness 里批准这个计划，或带着反馈继续规划。',
    hintTask: '只是进度播报，无需操作。',
    hintStall: '这一轮可能卡住了：先看会话，确认没有动静就停掉它。',
    hintAccount: '重新登录（或更新凭据）后重试。',
    hintGoal: '重新激活目标，或调整目标内容后继续。',
    hintWorkflow: '先看这次 workflow 运行的结果，再决定是否重跑。',
    hintJob: '到它所属的会话里看任务输出。',

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

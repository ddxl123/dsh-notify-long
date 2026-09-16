/**
 * Harness-facing runtime: folds Cordis events into alert decisions.
 *
 * The Cordis plugin in `src/index.js` only subscribes and forwards; every rule
 * lives here so it can be unit-tested with synthetic payloads and a fake engine.
 *
 * @module dsh-notify-long/lib/runtime/handlers
 */

import { hostname, userInfo } from 'node:os'

import { describeError, sanitizeLine } from '../util.js'
import { completionBody, completionTitle, contentToString, previewToolResult } from '../core/detect.js'
import { errorFingerprint } from '../core/engine.js'
import { messagesFor } from '../core/i18n.js'

/** Delay before a status transition is acted on, so listeners that raise pending flags settle first. */
export const IDLE_DELAY_MS = 250

/**
 * Default timer implementation: plain timers, tracked by the caller.
 *
 * @param {number} delayMs - delay before the callback runs
 * @param {() => void} callback - the work
 * @returns {() => void} a cancel function
 */
export function defaultTimer(delayMs, callback) {
  const handle = setTimeout(callback, delayMs)
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearTimeout(handle)
}

/**
 * @typedef {object} RuntimeDeps
 * @property {import('../core/detect.js').Tracker} tracker - per-session fact fold
 * @property {import('../core/engine.js').Engine} engine - alert engine
 * @property {() => any} settings - effective configuration accessor
 * @property {(delayMs: number, callback: () => void) => () => void} [timer] - cancellable delayed callback
 * @property {(message: string) => void} [log] - diagnostic sink
 * @property {() => string} [machine] - machine name used in alert bodies
 * @property {() => string} [operator] - operator name used in alert bodies
 */

/**
 * Build the runtime object the Cordis layer drives.
 *
 * @param {RuntimeDeps} deps - runtime dependencies
 * @returns {object} the runtime, with one method per handled event
 */
export function createRuntime(deps) {
  const { tracker, engine } = deps
  const settings = deps.settings
  const timer = typeof deps.timer === 'function' ? deps.timer : defaultTimer
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const machine = typeof deps.machine === 'function' ? deps.machine : () => safeHostname()
  const operator = typeof deps.operator === 'function' ? deps.operator : () => safeUser()
  /** @type {Set<() => void>} */
  const cancels = new Set()
  /** @type {Map<string, string>} pending question text by session */
  const questionText = new Map()

  /**
   * Schedule work that is cancelled when the plugin unloads.
   *
   * @param {number} delayMs - delay before the callback runs
   * @param {() => void} callback - the work
   * @returns {void}
   */
  const schedule = (delayMs, callback) => {
    const cancel = timer(delayMs, () => {
      cancels.delete(cancel)
      try {
        callback()
      } catch (error) {
        log(`dsh-notify-long: scheduled handler failed (${describeError(error)})`)
      }
    })
    cancels.add(cancel)
  }

  /** @param {string} sessionId - owning session @returns {string | undefined} the best known title */
  const titleOf = (sessionId) => tracker.factsOf(sessionId)?.title

  /** @param {string} sessionId - owning session @returns {string | undefined} the session working directory */
  const cwdOf = (sessionId) => tracker.factsOf(sessionId)?.cwd

  /** @returns {string} `host (user)` identifying this machine and operator */
  const context = () => `${machine()} (${operator()})`

  /**
   * The message catalogue for the configured language.
   *
   * Resolved per event rather than captured, so switching `language` in the
   * settings card changes the next alert's language without a restart.
   *
   * @returns {import('../core/i18n.js').Messages} the catalogue
   */
  const messages = () => messagesFor(settings()?.language)

  /**
   * Raise one alert without ever letting a failure escape into the harness.
   *
   * @param {import('../core/policy.js').NotificationEvent} event - the alert
   * @param {number} [delayMs] - defer dispatch, for events whose details arrive slightly later
   * @returns {void}
   */
  const fire = (event, delayMs = 0) => {
    const dispatch = () => {
      engine.raise(event).catch((error) => {
        log(`dsh-notify-long: alert dispatch failed (${describeError(error)})`)
      })
    }
    if (delayMs > 0) schedule(delayMs, dispatch)
    else dispatch()
  }

  /**
   * Raise the failure alert for one session, unless its failure family is still
   * cooling down.
   *
   * The cooldown is what keeps one failure from mailing twice: the `agent/error`
   * observer alerts the moment it sees the failure, and the idle assessment that
   * follows reads the *same* cooldown key, so the second dispatch is suppressed.
   * Both paths derive the key through {@link errorFingerprint} from the stored
   * failure, so they cannot drift apart.
   *
   * @param {string} sessionId - owning session
   * @param {any} facts - folded session facts
   * @param {string} title - the alert title
   * @returns {void}
   */
  const raiseFailure = (sessionId, facts, title) => {
    const failure = facts.lastError ?? { message: 'the turn failed', stage: 'turn' }
    const fingerprint = errorFingerprint(sessionId, failure.message, failure.stage ?? 'turn')
    if (engine.guard.isCoolingDown(fingerprint)) return
    fire({
      kind: 'error',
      title,
      body: failure.message,
      ...facts.reply === undefined ? {} : { detail: truncate(facts.reply, 400) },
      hint: messages().hintRetryStep,
      sessionId,
      sessionTitle: titleOf(sessionId),
      cwd: cwdOf(sessionId),
      turn: facts.lastTurn,
      urgency: 'error',
      fingerprint,
    })
  }

  /**
   * Decide and raise the alert for a session that just stopped running.
   *
   * The tracker already judged the turn — whether it ran any work, whether it
   * failed, whether it was cancelled — and this dispatch has to honour that
   * verdict rather than announcing every idle transition. It is deferred by a
   * moment so a question or approval whose payload arrives just after the
   * transition is still seen.
   *
   * @param {string} sessionId - session id
   * @param {object} transition - the transition returned by the tracker
   * @param {'question' | 'approval' | 'error'} [transition.pending] - the pending flag raised this turn
   * @param {any} transition.facts - folded session facts
   * @returns {void}
   */
  const finish = (sessionId, transition) => {
    const config = settings()
    const facts = tracker.factsOf(sessionId) ?? transition.facts ?? { id: sessionId, sawPrompt: false }
    const subagent = tracker.isSubagent(sessionId)
    if (subagent && config?.alerts?.kinds?.subagent?.enabled !== true) return
    const pending = transition.pending
    if (pending === 'error') {
      if (config?.alerts?.kinds?.error?.enabled === false) return
      raiseFailure(sessionId, facts, messages().failedTitle(truncate(titleOf(sessionId) ?? messages().agentTurn)))
      return
    }
    if (pending === 'question' || pending === 'approval') {
      return // the question/approval listener already alerted for this turn
    }
    const assessment = facts.turnEnd
    if (assessment !== undefined && assessment.notify !== true) return
    if (assessment === undefined && (facts.steps ?? 0) === 0 && (facts.toolCalls ?? 0) === 0 && (facts.reply ?? '') === '') {
      // No turn was ever folded for this session (a cold or resumed one that
      // merely toggled status), so there is nothing to announce.
      return
    }
    if (assessment?.failed === true) {
      // The turn failed without an observed `agent/error` event; it still must
      // not be announced as a finished task.
      if (config?.alerts?.kinds?.error?.enabled === false) return
      raiseFailure(sessionId, facts, messages().failedTitle(truncate(titleOf(sessionId) ?? messages().agentTurn)))
      return
    }
    if (config?.alerts?.kinds?.completed?.enabled === false) return
    const turn = facts.lastTurn
    fire({
      kind: subagent ? 'subagent' : 'completed',
      title: subagent
        ? messages().subagentTitle(truncate(titleOf(sessionId) ?? sessionId))
        : completionTitle(facts, titleOf(sessionId), messages()),
      body: completionBody(facts, turn, messages()),
      sessionId,
      sessionTitle: titleOf(sessionId),
      cwd: cwdOf(sessionId),
      turn,
      urgency: 'action',
      fingerprint: `turn:${turn ?? 'unknown'}`,
    })
  }

  const runtime = {
    /** Cancel every scheduled callback. */
    dispose() {
      for (const cancel of cancels) cancel()
      cancels.clear()
    },

    /**
     * `agent/created` / `session/created`: remember identity facts.
     *
     * @param {object} input - identity input
     * @param {string} input.sessionId - session id
     * @param {string} [input.cwd] - working directory
     * @param {string} [input.parentSession] - parent session id, marking a subagent
     * @param {string} [input.title] - session title
     * @returns {void}
     */
    noteSession(input) {
      tracker.noteSession(input.sessionId, {
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        ...input.parentSession === undefined ? {} : { parent: input.parentSession },
        ...input.title === undefined ? {} : { title: input.title },
      })
      tracker.seedStatus(input.sessionId, 'idle')
    },

    /**
     * `api-session/status` and `agent/status`: act on a running ⇄ idle transition.
     *
     * @param {object} input - status input
     * @param {string} input.sessionId - session id
     * @param {boolean} [input.running] - whether the session is running
     * @param {string} [input.status] - `idle` | `running`, when the caller has it
     * @returns {void}
     */
    status(input) {
      const running = input.running ?? input.status === 'running'
      const transition = tracker.noteStatus(input.sessionId, running ? 'running' : 'idle')
      if (running || !transition.becameIdle) return
      // A question or approval usually arrives just before the idle transition,
      // but its payload can follow it; let those listeners settle first, then
      // read the pending flag as it stands at dispatch time.
      schedule(IDLE_DELAY_MS, () => finish(input.sessionId, { ...transition, pending: tracker.consumePending(input.sessionId) }))
    },

    /**
     * Decide and raise the alert for a session that just stopped running.
     * Exposed for tests and for callers that already know the transition.
     *
     * @param {string} sessionId - session id
     * @param {object} transition - the tracker transition
     * @returns {void}
     */
    finish,

    /**
     * One `session/event` append.
     *
     * @param {string} sessionId - owning session
     * @param {string} type - session event type
     * @param {any} data - session event payload
     * @returns {void}
     */
    sessionEvent(sessionId, type, data) {
      if (type === 'user/message') {
        tracker.noteUserMessage(sessionId, data)
        return
      }
      if (type === 'turn/start') {
        tracker.noteTurnStart(sessionId)
        return
      }
      if (type === 'turn/end') {
        const assessment = tracker.noteTurnEnd(sessionId, Number(data?.turn ?? 0), data?.reason)
        if (!assessment.failed && !assessment.aborted && assessment.notify && assessment.message !== undefined) {
          tracker.noteSession(sessionId).reply = assessment.message
        }
        return
      }
      tracker.noteSessionEvent(sessionId, type, data)
    },

    /**
     * `tools/result`: clear a pending question once the operator answered, and
     * fold tool outcomes into the session facts.
     *
     * @param {object} input - tool result input
     * @param {string} [input.sessionId] - owning session
     * @param {string} input.toolName - the tool that ran
     * @param {any} input.result - the tool result
     * @returns {void}
     */
    toolResult(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      if (input.toolName === 'ask_user_question' || input.toolName === 'exit_plan_mode') {
        questionText.delete(sessionId)
        return
      }
      tracker.noteSessionEvent(sessionId, 'tool/result', normalizeToolResult(input.result))
    },

    /**
     * `tools/execute`: observe tool calls and, for a question tool, remember its
     * text so a later alert can quote it.
     *
     * @param {object} input - execution input
     * @param {string} [input.sessionId] - owning session
     * @param {string} input.toolName - tool name
     * @param {any} input.args - parsed arguments
     * @returns {void}
     */
    toolCall(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      tracker.noteSessionEvent(sessionId, 'tool/call', {})
      if (input.toolName !== 'ask_user_question') return
      const questions = Array.isArray(input.args?.questions) ? input.args.questions : []
      const first = questions[0]
      if (first === undefined) return
      questionText.set(sessionId, truncate([first.header, first.question].filter(Boolean).join(' — '), 300))
    },

    /**
     * `user-questions/request`: the agent is blocked on the operator.
     *
     * A question is the one alert the operator has to act on to unblock the
     * agent, so it is raised even when the request carries no agent identity —
     * the harness declares `agent` optional, and a question nobody is told about
     * stalls the turn until someone happens to look at the window.
     *
     * @param {object} input - question input
     * @param {string} [input.sessionId] - owning session, when the request named one
     * @param {any} input.request - the question request
     * @returns {void}
     */
    question(input) {
      const sessionId = input.sessionId
      if (sessionId !== undefined) tracker.notePending(sessionId, 'question')
      const questions = Array.isArray(input.request?.questions) ? input.request.questions : []
      const first = questions[0]
      const body = questions
        .slice(0, 5)
        .map((entry, index) => {
          const options = Array.isArray(entry?.options)
            ? entry.options.map((option) => sanitizeLine(option?.label)).filter(Boolean)
            : []
          const head = `${index + 1}. ${sanitizeLine(entry?.question ?? entry?.header ?? '')}`
          return options.length === 0 ? head : `${head}\n${messages().questionOptions(options.join(' | '))}`
        })
        .join('\n')
      fire({
        kind: 'question',
        title: messages().questionTitle(truncate(sanitizeLine(first?.header ?? first?.question ?? titleOf(sessionId) ?? 'question'))),
        body: [body, '', context()].filter((line) => line !== '').join('\n'),
        hint: messages().hintAnswer,
        ...sessionId === undefined ? {} : { sessionId },
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        fingerprint: `question:${truncate(sanitizeLine(first?.question ?? ''), 120)}`,
      })
    },

    /**
     * `approval/request`: an action needs the operator's permission.
     *
     * Like a question, this is a request the turn cannot proceed without, so it
     * alerts even when no agent identity came with it.
     *
     * @param {object} input - approval input
     * @param {string} [input.sessionId] - owning session, when the request named one
     * @param {any} input.request - the approval request
     * @returns {void}
     */
    approval(input) {
      const sessionId = input.sessionId
      if (sessionId !== undefined) tracker.notePending(sessionId, 'approval')
      const request = input.request ?? {}
      const what = sanitizeLine(request.toolName ?? request.tool ?? request.kind ?? messages().anAction)
      const reason = sanitizeLine(request.reason ?? request.description ?? '')
      fire({
        kind: 'approval',
        title: messages().approvalTitle(truncate(what)),
        body: [reason === '' ? messages().approvalWaiting(what) : reason, '', context()].join('\n'),
        hint: messages().hintApprove,
        ...sessionId === undefined ? {} : { sessionId },
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        fingerprint: `approval:${truncate(what, 80)}`,
      })
    },

    /**
     * `agent/error` and `api-session/error`: a step, turn, or session failed.
     *
     * @param {object} input - error input
     * @param {string} [input.sessionId] - owning session
     * @param {any} input.error - the thrown value
     * @param {string} [input.stage] - `turn` | `step` | `session`
     * @param {number} [input.turn] - turn number
     * @param {number} [input.step] - step number
     * @returns {void}
     */
    error(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      if (settings()?.alerts?.kinds?.error?.enabled === false) return
      const failure = tracker.noteError(sessionId, { error: input.error, stage: input.stage })
      const facts = tracker.factsOf(sessionId)
      if (facts !== undefined) facts.lastError = failure
      const fingerprint = errorFingerprint(sessionId, failure.message, failure.stage)
      if (engine.guard.isCoolingDown(fingerprint)) return
      fire({
        kind: 'error',
        title: messages().errorTitle(truncate(titleOf(sessionId) ?? messages().agentRun)),
        body: failure.message,
        hint: input.stage === 'session' ? messages().hintSessionLog : messages().hintRetryStep,
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        turn: input.turn,
        urgency: 'error',
        fingerprint,
      })
    },

    /**
     * `subagent/end`: a published child settled.
     *
     * @param {object} input - subagent input
     * @param {string} input.sessionId - the child session id
     * @param {any} input.info - the run-end info
     * @returns {void}
     */
    subagentEnd(input) {
      const config = settings()
      if (config?.alerts?.kinds?.subagent?.enabled !== true) return
      const child = input.sessionId
      const output = contentToString(input.info?.lastAssistantMessage)
      fire({
        kind: 'subagent',
        title: messages().subagentTitle(truncate(titleOf(child) ?? child)),
        body: [truncate(output, 400) || messages().subagentStopReason(sanitizeLine(input.info?.stopReason ?? 'unknown')), '', context()].join('\n'),
        sessionId: child,
        sessionTitle: titleOf(child),
        urgency: 'info',
        fingerprint: `subagent:${sanitizeLine(input.info?.runId ?? child)}`,
      })
    },

    /**
     * The question text remembered at `tools/execute` time, when a caller needs it.
     *
     * @param {string} sessionId - owning session
     * @returns {string | undefined} the remembered question
     */
    lastQuestion(sessionId) {
      return questionText.get(sessionId)
    },
  }

  return runtime
}

/**
 * Normalize the runtime shape a tool result can take into the `tool/result`
 * event shape the tracker folds.
 *
 * @param {any} result - a normalized tool execution result
 * @returns {{ message: { content: any }, error?: { name: string } }} the folded shape
 */
function normalizeToolResult(result) {
  const content = result?.content
  const failed = result?.isError === true || result?.ok === false
  return {
    message: { content: content ?? (typeof result?.value === 'string' ? result.value : '') },
    ...failed ? { error: { name: 'tool' } } : {},
  }
}

/**
 * @param {unknown} value - candidate text
 * @param {number} [max] - maximum length
 * @returns {string} a capped single-line string
 */
function truncate(value, max = 90) {
  const text = sanitizeLine(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** @returns {string} the host name, never throwing */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return 'unknown-host'
  }
}

/** @returns {string} the operator name, never throwing */
function safeUser() {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? 'unknown'
  }
}

/**
 * Count how many alerts are waiting in the outbox.
 *
 * @param {import('../core/queue.js').Outbox} outbox - the outbox
 * @returns {number} the pending count
 */
export function pendingCount(outbox) {
  return outbox.size
}

/**
 * Render one failure preview for a failed tool call.
 *
 * @param {any} content - tool result content
 * @returns {string} the preview
 */
export function toolFailurePreview(content) {
  return previewToolResult(content, 300)
}

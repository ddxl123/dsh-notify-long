/**
 * Harness-facing runtime: folds Cordis events into alert decisions.
 *
 * The Cordis plugin in `src/index.js` only subscribes and forwards; every rule
 * lives here so it can be unit-tested with synthetic payloads and a fake engine.
 *
 * @module dsh-notify-long/lib/runtime/handlers
 */

import { hostname, userInfo } from 'node:os'

import { describeError, hashKey, positiveNumber, sanitizeLine } from '../util.js'
import { completionBody, completionTitle, contentToString, normalizeTodos, previewToolResult } from '../core/detect.js'
import { errorFingerprint, retryFingerprint } from '../core/engine.js'
import { messagesFor } from '../core/i18n.js'

/** Delay before a status transition is acted on, so listeners that raise pending flags settle first. */
export const IDLE_DELAY_MS = 250

/** How long a running turn may stay silent before the stall alert fires. */
export const STALL_AFTER_MS = 600_000

/** How often the stall watchdog looks at the sessions it tracks. */
export const STALL_CHECK_MS = 30_000

/** Longest plan excerpt carried into the alert (the banner clips it; the email keeps it). */
export const PLAN_DETAIL_LIMIT = 4_000

/** Task lines rendered in one task alert before the rest are summarized. */
export const TODO_LINE_LIMIT = 12

/** Marks for the three todo states, in the harness's own vocabulary. */
const TODO_MARKS = { completed: '[x]', in_progress: '[>]', pending: '[ ]' }

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
 * Identity for one plan review.
 *
 * The plan-review flow asks the very same question text every time the model
 * presents a revised plan, so the text cannot identify it: without the call id,
 * "keep planning → revise → present again" inside the duplicate window would be
 * swallowed. `intent.callId` is unique per `exit_plan_mode` call; the plan text
 * is the fallback for a request that carries no intent, and the prompt text is
 * the last resort.
 *
 * Ordinary questions deliberately keep their text-only identity: the same
 * question asked twice inside the window is one alert, not two.
 *
 * @param {any} question - one question from the request
 * @returns {string} the identity fragment
 */
function planIdentity(question) {
  const callId = sanitizeLine(question?.intent?.callId ?? '')
  if (callId !== '') return `call:${callId}`
  const detail = sanitizeLine(question?.detail ?? '')
  if (detail !== '') return `detail:${hashKey(detail)}`
  return `text:${hashKey(sanitizeLine(question?.question ?? ''))}`
}

/**
 * Whether two folded task lists describe the same list.
 *
 * @param {Array<{ content: string, status: string }> | undefined} before - the previous list
 * @param {Array<{ content: string, status: string }>} after - the list just written
 * @returns {boolean} true when nothing changed
 */
function sameTodos(before, after) {
  if (!Array.isArray(before) || before.length !== after.length) return false
  return before.every((item, index) => item.content === after[index].content && item.status === after[index].status)
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
  /** @type {Map<string, { at: number, stalled: boolean, episodes: number }>} silence per running session */
  const watch = new Map()
  /** Whether the stall watchdog already has a tick scheduled. */
  let watchdogArmed = false

  /**
   * Arm the stall watchdog, once, for as long as it has sessions to watch.
   *
   * The timer is scheduled through the same cancellable `timer` seam as every
   * other deferred callback, so unloading the plugin clears it, and a test can
   * drive it without waiting for wall-clock time.
   *
   * @returns {void}
   */
  const armWatchdog = () => {
    if (watchdogArmed) return
    watchdogArmed = true
    schedule(STALL_CHECK_MS, () => {
      watchdogArmed = false
      if (watch.size === 0) return
      try {
        runtime.stallCheck()
      } catch (error) {
        log(`dsh-notify-long: stall check failed (${describeError(error)})`)
      }
    })
  }

  /**
   * Record progress inside a running turn and re-arm the watchdog.
   *
   * @param {string} [sessionId] - owning session
   * @param {number} [at] - observation time, defaults to now
   * @returns {void}
   */
  const noteActivity = (sessionId, at = Date.now()) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const entry = watch.get(sessionId) ?? { at, stalled: false, episodes: 0 }
    entry.at = at
    entry.stalled = false
    watch.set(sessionId, entry)
    armWatchdog()
  }

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
      if (running) noteActivity(input.sessionId)
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
      noteActivity(sessionId)
      if (type === 'todo/write') {
        runtime.todoWrite({ sessionId, todos: data?.todos })
        return
      }
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
      if (type === 'llm/retry') {
        // The instant the harness schedules another attempt, which is the moment
        // the browser card shows "waiting to retry" with the failure and delay.
        runtime.modelRetry({
          sessionId,
          provider: data?.provider,
          failure: data?.failure,
          delayMs: data?.delayMs,
          retry: data?.retry,
          maxRetries: data?.maxRetries,
          turn: data?.turn,
        })
        return
      }
      tracker.noteSessionEvent(sessionId, type, data)
    },

    /**
     * `tools/result`: record the tool that just ran and fold its outcome into the
     * session facts.
     *
     * Tool *calls* are counted from the durable `tool/call` session event, which
     * the agent loop appends before dispatching (see the tracker's fold) — not
     * from a dispatch-time observer, which would count the same call twice.
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
      noteActivity(sessionId)
      tracker.noteToolName(sessionId, input.toolName)
      // A question tool reports through the question path; its own result is not
      // a failed tool call, which is what the completion alert's stat counts.
      if (input.toolName === 'ask_user_question' || input.toolName === 'exit_plan_mode') return
      tracker.noteSessionEvent(sessionId, 'tool/result', normalizeToolResult(input.result))
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
      // `exit_plan_mode` reviews a plan through this same waterfall — the only
      // difference is the `intent` it stamps on the question. Routing it to its
      // own kind lets an operator route or quiet plan reviews separately, and
      // lets the alert carry the plan itself instead of just the prompt.
      const planReview = first?.intent?.kind === 'plan-review'
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
      const plan = planReview ? truncate(sanitizeLine(first?.detail ?? ''), PLAN_DETAIL_LIMIT) : ''
      const heading = sanitizeLine(first?.header ?? first?.question ?? titleOf(sessionId) ?? 'question')
      fire({
        kind: planReview ? 'plan' : 'question',
        title: planReview
          ? messages().planTitle(truncate(heading))
          : messages().questionTitle(truncate(heading)),
        body: [
          ...planReview ? [messages().planWaiting] : [],
          body,
          ...plan === '' ? [] : ['', messages().planDetailNote, plan],
          '',
          context(),
        ].filter((line) => line !== '').join('\n'),
        hint: planReview ? messages().hintPlan : messages().hintAnswer,
        // The plan itself travels as `detail`, which the email renders in full
        // and the banner does not: the operator reads it in the mail, then
        // decides in the window.
        ...plan === '' ? {} : { detail: plan },
        ...sessionId === undefined ? {} : { sessionId },
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        // A plan review repeats the same prompt every time the model presents a
        // revised plan, so identity comes from the call that asked, not from the
        // text: without it the duplicate window would swallow the second review.
        fingerprint: planReview
          ? `plan:${planIdentity(first)}`
          : `question:${truncate(sanitizeLine(first?.question ?? ''), 120)}`,
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
     * `llm/retry`: a model request failed and the harness is about to try again.
     *
     * A retry is the harness recovering on its own, which is exactly why it is
     * worth a line: the turn usually finishes anyway, so a flapping model
     * connection leaves no trace in the completion alert that follows. Raised on
     * the *scheduled* retry (`llm/retry`) — the event the browser renders as
     * "waiting to retry" with the failure and the delay — because
     * `llm/retry-started` is the same retry a moment later and would only
     * duplicate it.
     *
     * Subagent sessions are not filtered out here for the same reason they are
     * not filtered out of failures: a degraded model route is a fact about the
     * operator's network, not chatter from a child agent.
     *
     * @param {object} input - retry input
     * @param {string} input.sessionId - owning session
     * @param {string} [input.provider] - the model route that failed
     * @param {any} [input.failure] - the `LlmFailure` behind the retry
     * @param {number} [input.delayMs] - how long the harness waits before retrying
     * @param {number} [input.retry] - this retry's position in its chain
     * @param {number} [input.maxRetries] - how many retries the policy allows, when finite
     * @param {number} [input.turn] - the turn the failed request belonged to
     * @returns {void}
     */
    modelRetry(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined || sessionId === '') return
      if (settings()?.alerts?.kinds?.retry?.enabled === false) return
      tracker.noteSession(sessionId)
      const m = messages()
      const failure = typeof input.failure === 'object' && input.failure !== null ? input.failure : {}
      const provider = sanitizeLine(input.provider ?? '')
      const reason = describeFailure(failure) || m.retryNoFailure
      const fingerprint = retryFingerprint(sessionId, provider, reason)
      // A connection that flaps must not mail once per attempt: the same failure
      // family alerts once per cooldown window, and the engine's duplicate window
      // still applies on top of that, per turn.
      if (engine.guard.isCoolingDown(fingerprint)) return
      const retry = Number.isFinite(input.retry) ? Math.trunc(input.retry) : undefined
      const maximum = Number.isFinite(input.maxRetries) ? Math.trunc(input.maxRetries) : undefined
      fire({
        kind: 'retry',
        title: m.retryTitle(truncate(titleOf(sessionId) ?? m.agentRun)),
        body: [
          m.retryFailure(reason),
          ...Number.isFinite(input.delayMs) ? [m.retryDelay(input.delayMs)] : [],
          [
            retry === undefined ? '' : m.retryAttempt(retry, maximum),
            provider === '' ? '' : m.retryProvider(provider),
          ].filter((line) => line !== '').join(' · '),
        ].filter((line) => line !== '').join('\n'),
        hint: m.hintRetryAuto,
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        turn: input.turn,
        urgency: 'info',
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
     * `todo/write`: the model replaced its whole task list.
     *
     * The harness's `todos` projection resets on `turn/start` and is otherwise
     * last-write-wins, so the change this reports is the difference between the
     * list this session held and the snapshot just written. An identical rewrite
     * is not a change and stays silent.
     *
     * A completed list does not suppress the turn's own completion alert: the two
     * carry different news (the list versus the reply and its tool-call, failure
     * and turn counts), and "every finished turn reports" is the configured
     * behaviour.
     *
     * @param {object} input - todo input
     * @param {string} [input.sessionId] - owning session
     * @param {unknown} input.todos - the list as written
     * @returns {void}
     */
    todoWrite(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined || sessionId === '') return
      const before = tracker.factsOf(sessionId)?.todos
      tracker.noteSessionEvent(sessionId, 'todo/write', { todos: input.todos })
      const after = tracker.factsOf(sessionId)?.todos ?? []
      if (sameTodos(before, after)) return
      const m = messages()
      const total = after.length
      if (total === 0) {
        fire({
          kind: 'task',
          title: m.taskClearedTitle,
          body: [m.taskCleared, '', context()].join('\n'),
          hint: m.hintTask,
          sessionId,
          sessionTitle: titleOf(sessionId),
          cwd: cwdOf(sessionId),
          urgency: 'info',
          fingerprint: 'task:cleared',
        })
        return
      }
      const done = after.filter((item) => item.status === 'completed').length
      const active = after.filter((item) => item.status === 'in_progress').map((item) => item.content)
      const allDone = done === total
      const lines = after.slice(0, TODO_LINE_LIMIT).map((item) => `${TODO_MARKS[item.status] ?? TODO_MARKS.pending} ${item.content}`)
      if (after.length > TODO_LINE_LIMIT) lines.push(`… +${after.length - TODO_LINE_LIMIT}`)
      fire({
        kind: 'task',
        title: allDone ? m.taskDoneTitle(total) : m.taskTitle(done, total),
        body: [
          m.taskCounts(done, total),
          active.length === 0 ? m.taskNothingNow : m.taskNow(active.join(' | ')),
          '',
          lines.join('\n'),
          '',
          context(),
        ].filter((line) => line !== '').join('\n'),
        hint: m.hintTask,
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: allDone ? 'action' : 'info',
        fingerprint: `task:${hashKey(after.map((item) => `${item.status}:${item.content}`).join('\n'))}`,
      })
    },

    /**
     * `goal/changed`: a goal was blocked (rounds exhausted included).
     *
     * A blocked goal is the driver admitting it cannot continue on its own, which
     * is exactly the moment an unattended run needs a human. Other operations
     * (`create`, `edit`, `pause`, `resume`, `complete`, `clear`) are the
     * operator's own actions or are covered by the turn-end alert.
     *
     * @param {object} input - goal input
     * @param {string} [input.sessionId] - owning session
     * @param {any} input.change - the `GoalChanged` payload
     * @returns {void}
     */
    goalChanged(input) {
      const change = input.change
      const goal = change?.goal
      if (change?.operation !== 'block' && goal?.phase !== 'blocked') return
      const sessionId = input.sessionId
      const m = messages()
      const reason = sanitizeLine(goal?.blockedReason?.message ?? goal?.blockedReason?.code ?? '')
      const rounds = Number.isFinite(goal?.roundsStarted) ? Math.trunc(goal.roundsStarted) : undefined
      const maximum = Number.isFinite(goal?.maxGoalRounds) ? Math.trunc(goal.maxGoalRounds) : undefined
      fire({
        kind: 'goal',
        title: m.goalTitle(truncate(sanitizeLine(goal?.objective ?? '') || (titleOf(sessionId) ?? m.agentRun))),
        body: [
          ...reason === '' ? [] : [m.goalBlocked(reason)],
          ...rounds === undefined || maximum === undefined ? [] : [m.goalRounds(rounds, maximum)],
          '',
          context(),
        ].filter((line) => line !== '').join('\n'),
        hint: m.hintGoal,
        ...sessionId === undefined ? {} : { sessionId },
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        fingerprint: `goal:${sanitizeLine(String(goal?.id ?? ''))}:${Number.isFinite(goal?.revision) ? goal.revision : ''}`,
      })
    },

    /**
     * `workflow/end`: a workflow run settled.
     *
     * Only an `error` stop reason alerts. A `completed` run is followed by the
     * turn that started it, whose completion alert carries the result, and a
     * `cancelled` run is the operator's own stop — both would be duplicates.
     *
     * @param {object} input - workflow input
     * @param {any} input.info - the run's identity snapshot
     * @param {any} input.result - the run's outcome
     * @returns {void}
     */
    workflowEnd(input) {
      const result = input.result
      if (result?.stopReason !== 'error') return
      const m = messages()
      const name = sanitizeLine(input.info?.meta?.name ?? '') || 'workflow'
      const started = Number.isFinite(result?.agentsStarted) ? Math.trunc(result.agentsStarted) : 0
      const failure = sanitizeLine(result?.error ?? '')
      fire({
        kind: 'workflow',
        title: m.workflowTitle(truncate(name)),
        body: [
          ...failure === '' ? [] : [m.workflowStopped(failure)],
          m.workflowAgents(started),
          '',
          context(),
        ].filter((line) => line !== '').join('\n'),
        hint: m.hintWorkflow,
        urgency: 'error',
        fingerprint: `workflow:${sanitizeLine(String(input.info?.id ?? name))}`,
      })
    },

    /**
     * `deepseek-account/model-sign-in-required` and `session-expired`.
     *
     * Both mean the model route is dead until a human acts, which is the one
     * failure an unattended run cannot work around.
     *
     * @param {object} input - account input
     * @param {'sign-in-required' | 'session-expired'} input.reason - what happened
     * @returns {void}
     */
    account(input) {
      const m = messages()
      const what = input.reason === 'session-expired' ? m.accountExpired : m.accountSignIn
      fire({
        kind: 'account',
        title: m.accountTitle(truncate(what)),
        body: [what, '', context()].join('\n'),
        hint: m.hintAccount,
        urgency: 'error',
        fingerprint: `account:${input.reason}`,
      })
    },

    /**
     * `authorization/settled`: one credential authorization finished.
     *
     * Only the `failed` settlement alerts; `authorized` and `cancelled` are the
     * normal ends of an interactive flow the operator just watched.
     *
     * @param {object} input - settlement input
     * @param {unknown} input.key - the credential record that was being authorized
     * @param {unknown} input.settlement - `authorized` | `cancelled` | `failed`
     * @returns {void}
     */
    authorizationSettled(input) {
      if (input.settlement !== 'failed') return
      const m = messages()
      const key = sanitizeLine(String(input.key ?? '')) || 'credential'
      const what = m.accountAuthFailed(key)
      fire({
        kind: 'account',
        title: m.accountTitle(truncate(what)),
        body: [what, '', context()].join('\n'),
        hint: m.hintAccount,
        urgency: 'error',
        fingerprint: `account:auth:${key}`,
      })
    },

    /**
     * The jobs service's `settled` event: one background job ended.
     *
     * Only failures alert. A `completed` job is reported by the tool call that
     * collected it (or by the turn that ends afterwards), a `killed` one is the
     * operator's own stop, and a settlement with `cause: 'teardown'` has no
     * reader left — its owner is being destroyed.
     *
     * @param {any} event - a `JobEvent` from `ctx.jobs.events`
     * @returns {void}
     */
    jobSettled(event) {
      if (event?.type !== 'settled') return
      const job = event.job
      if (job?.status !== 'failed') return
      if (event.cause === 'teardown') return
      const m = messages()
      const label = sanitizeLine(job.label ?? '') || sanitizeLine(String(job.id ?? '')) || 'job'
      const kind = sanitizeLine(job.kind ?? '') || 'background'
      const owner = job.owner === undefined || job.owner === null ? undefined : String(job.owner)
      const detail = truncate(sanitizeLine(job.detail ?? ''), 300)
      fire({
        kind: 'job',
        title: m.jobTitle(truncate(label)),
        body: [
          m.jobFailed(kind),
          ...detail === '' ? [] : [detail],
          '',
          context(),
        ].filter((line) => line !== '').join('\n'),
        hint: m.hintJob,
        ...owner === undefined ? {} : { sessionId: owner },
        sessionTitle: owner === undefined ? undefined : titleOf(owner),
        urgency: 'error',
        fingerprint: `job:${sanitizeLine(String(job.id ?? label))}`,
      })
    },

    /**
     * Any sign of progress inside a running turn, for the stall watchdog.
     *
     * Stream frames, tool results, session appends and status transitions all
     * land here; the watchdog only cares that *something* moved.
     *
     * @param {object} input - activity input
     * @param {string} [input.sessionId] - owning session
     * @param {number} [input.at] - observation time, defaults to now
     * @returns {void}
     */
    activity(input) {
      noteActivity(input.sessionId, input.at)
    },

    /**
     * Raise one alert for every running turn that has gone silent.
     *
     * Called by the watchdog on its own interval, and directly by tests. One
     * alert per silent episode: activity clears the flag, so a turn that stalls
     * again later alerts again.
     *
     * @param {number} [at] - observation time, defaults to now
     * @returns {void}
     */
    stallCheck(at = Date.now()) {
      const threshold = positiveNumber(settings()?.stallAfterMs, STALL_AFTER_MS)
      const m = messages()
      for (const [sessionId, entry] of [...watch]) {
        if (!tracker.isTurnOpen(sessionId)) {
          watch.delete(sessionId)
          continue
        }
        if (entry.stalled) continue
        const silentMs = at - entry.at
        if (silentMs < threshold) continue
        entry.stalled = true
        entry.episodes += 1
        const minutes = Math.max(1, Math.round(silentMs / 60_000))
        const lastTool = tracker.factsOf(sessionId)?.lastTool
        fire({
          kind: 'stall',
          title: m.stallTitle(minutes, truncate(titleOf(sessionId) ?? m.agentRun)),
          body: [
            m.stallBody(minutes),
            lastTool === undefined ? m.stallNoTool : m.stallLastTool(lastTool),
            '',
            context(),
          ].join('\n'),
          hint: m.hintStall,
          sessionId,
          sessionTitle: titleOf(sessionId),
          cwd: cwdOf(sessionId),
          urgency: 'action',
          fingerprint: `stall:${entry.episodes}`,
        })
      }
      if (watch.size > 0) armWatchdog()
    },
  }

  return runtime
}

/**
 * Render an `LlmFailure` as one line: the provider's own message plus the machine
 * code and HTTP status that make it diagnosable, in the shape the failure alert
 * already uses.
 *
 * @param {any} failure - the `LlmFailure` behind a retry
 * @returns {string} the printable reason, or an empty string when it carried nothing
 */
function describeFailure(failure) {
  const message = sanitizeLine(failure?.message ?? '')
  const code = sanitizeLine(failure?.code ?? '')
  const status = Number.isFinite(failure?.status) ? `HTTP ${Math.trunc(failure.status)}` : ''
  const suffix = [code, status].filter((part) => part !== '').join(' ')
  if (suffix === '') return message
  return message === '' ? suffix : `${message} (${suffix})`
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

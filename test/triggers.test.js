/**
 * "When does it notify?" as an executable spec.
 *
 * The README describes the trigger rules in prose; this file drives the real
 * runtime and the real engine through every scenario that has ever been
 * ambiguous, and asserts exactly which alerts come out — including the ones that
 * must produce *nothing*. It exists because two of these rules were documented
 * but not implemented: an empty or cancelled turn was announced as "Task
 * finished" (the tracker's verdict was computed and then ignored by the deferred
 * idle dispatch), and a failing turn mailed twice (the immediate `agent/error`
 * observer and the idle assessment used different cooldown keys for one
 * failure).
 *
 * A scenario is expressed the way the harness reports it: session events in
 * order, a status flip to running, and a status flip back to idle.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Tracker } from '../lib/core/detect.js'
import { Engine } from '../lib/core/engine.js'
import { Guard } from '../lib/core/policy.js'
import { Outbox } from '../lib/core/queue.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/**
 * Build a runtime wired to a real engine whose only channel is a recording email
 * channel, so "did it notify?" is answered by counting deliveries.
 *
 * @param {object} [options] - harness options
 * @param {any} [options.settings] - effective configuration for the engine
 * @param {any} [options.runtimeSettings] - effective configuration for the runtime
 * @returns {any} the driver
 */
function createDriver(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-long-triggers-'))
  const sent = []
  const engine = new Engine({
    outbox: new Outbox({ path: join(dir, 'outbox.json') }),
    guard: new Guard(options.guard),
    settings: () => options.settings ?? { enabled: true, alerts: { channels: ['email'], kinds: {} }, quietHours: {}, email: {} },
    emailReady: () => true,
    playSound: async () => ({ ok: false, detail: 'sound is off in this test' }),
    showDesktop: async () => ({ ok: false, detail: 'desktop is off in this test' }),
    sendEmail: async (input) => {
      sent.push({ kind: input.event.kind, title: input.event.title, body: input.event.body })
      return { ok: true, detail: 'sent' }
    },
  })
  const tracker = new Tracker()
  const scheduled = []
  const runtime = createRuntime({
    tracker,
    engine,
    settings: () => options.runtimeSettings ?? { alerts: { kinds: {} } },
    timer: (_delay, callback) => {
      scheduled.push(callback)
      return () => undefined
    },
  })

  /** Run every deferred callback the runtime scheduled, then let delivery settle. */
  const settle = async () => {
    for (const callback of scheduled.splice(0)) callback()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }

  return {
    sent,
    runtime,
    tracker,
    settle,
    /**
     * Drive one session through a full turn.
     *
     * @param {string} id - session id
     * @param {any[]} events - `[type, data]` pairs delivered while running
     * @param {object} [extra] - `parentSession` and other identity facts
     * @returns {Promise<any[]>} what was delivered
     */
    async turn(id, events, extra = {}) {
      sent.length = 0
      runtime.noteSession({ sessionId: id, cwd: '/tmp/project', ...extra })
      runtime.status({ sessionId: id, running: true })
      for (const [type, data] of events) runtime.sessionEvent(id, type, data)
      runtime.status({ sessionId: id, running: false })
      await settle()
      return sent.slice()
    },
  }
}

/**
 * A turn that did real work: a step, a tool call, and a reply. `step/start` and
 * `tool/call` are what the tracker counts — `tool/result` only records failures —
 * so a fixture that omits them describes a turn that ran nothing.
 *
 * @param {number} turn - the turn number
 * @returns {any[]} the event pairs
 */
function workedTurn(turn = 1) {
  return [
    ['turn/start', { turn }],
    ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'build the release' }] }],
    ['step/start', { turn, step: 1 }],
    ['tool/call', { turn, step: 1, name: 'bash' }],
    ['tool/result', { turn, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }],
    ['assistant/message', { message: { content: [{ type: 'text', text: 'the release is built' }] } }],
    ['turn/end', { turn, reason: { kind: 'completed' } }],
  ]
}

test('a turn that did work and finished notifies once, with its reply', async () => {
  const driver = createDriver()
  const sent = await driver.turn('s1', workedTurn())
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'completed')
  assert.match(sent[0].title, /Finished:/)
  assert.match(sent[0].body, /the release is built/)
  assert.match(sent[0].body, /1 tool call\(s\)/)
})

test('an empty turn notifies nobody', async () => {
  const driver = createDriver()
  const sent = await driver.turn('s2', [
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
  ])
  assert.deepEqual(sent, [], 'a turn that entered no step and produced no reply ran no work')
})

test('a cancelled turn notifies nobody until it has actually done something', async () => {
  const driver = createDriver()
  const cancelled = await driver.turn('s3', [
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'aborted' } }],
  ])
  assert.deepEqual(cancelled, [], 'an immediately cancelled turn is not news')

  const withWork = await driver.turn('s4', [
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['tool/call', { turn: 1, step: 1, name: 'bash' }],
    ['turn/end', { turn: 1, reason: { kind: 'aborted' } }],
  ])
  assert.equal(withWork.length, 1, 'a cancelled turn that ran steps is still worth a line')
  assert.equal(withWork[0].kind, 'completed')
})

test('a status flip with no turn behind it notifies nobody', async () => {
  const driver = createDriver()
  driver.runtime.noteSession({ sessionId: 's5' })
  driver.runtime.status({ sessionId: 's5', running: true })
  driver.runtime.status({ sessionId: 's5', running: false })
  await driver.settle()
  assert.deepEqual(driver.sent, [], 'a cold or resumed session merely toggling status is not a finished task')
})

test('a failing turn notifies exactly once, and never as a finished task', async () => {
  const driver = createDriver()
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's6', cwd: '/tmp/project' })
  driver.runtime.status({ sessionId: 's6', running: true })
  driver.runtime.sessionEvent('s6', 'turn/start', { turn: 1 })
  driver.runtime.error({ sessionId: 's6', error: new Error('model route exploded'), stage: 'turn', turn: 1 })
  driver.runtime.sessionEvent('s6', 'turn/end', { turn: 1, reason: { kind: 'error' } })
  driver.runtime.status({ sessionId: 's6', running: false })
  await driver.settle()

  assert.equal(driver.sent.length, 1, 'the immediate observer and the idle assessment must not both mail')
  assert.equal(driver.sent[0].kind, 'error')
  assert.match(driver.sent[0].body, /model route exploded/)
})

test('a turn that ended in failure without an observed error still alerts as a failure', async () => {
  // The error observers (`agent/error`, `api-session/error`) are the normal path.
  // This is the fallback: a turn that ran work, ended in failure, and whose
  // failure event never arrived — it must not be announced as a finished task.
  const driver = createDriver()
  const sent = await driver.turn('s7', [
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'error' } }],
  ])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'error', 'a failed turn is never announced as finished')
  assert.match(sent[0].title, /Failed:/)
  assert.match(sent[0].body, /the turn failed/, 'with no observed failure there is nothing more specific to say')
})

test('a failure with no work behind it stays silent, matching the tracker verdict', async () => {
  const driver = createDriver()
  const sent = await driver.turn('s7b', [
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'error' } }],
  ])
  assert.deepEqual(sent, [], 'nothing ran and no error observer fired, so there is nothing to report')
})

test('repeated identical failures cool down instead of mailing each time', async () => {
  const driver = createDriver({ guard: { cooldownMs: 600_000 } })
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's8' })
  driver.runtime.status({ sessionId: 's8', running: true })
  driver.runtime.error({ sessionId: 's8', error: new Error('same failure'), stage: 'turn' })
  driver.runtime.error({ sessionId: 's8', error: new Error('same failure'), stage: 'turn' })
  driver.runtime.error({ sessionId: 's8', error: new Error('same failure'), stage: 'turn' })
  driver.runtime.status({ sessionId: 's8', running: false })
  await driver.settle()
  assert.equal(driver.sent.length, 1, 'one failure family alerts once per cooldown window')
})

test('a question replaces the completion alert for its turn', async () => {
  const driver = createDriver()
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's9' })
  driver.runtime.status({ sessionId: 's9', running: true })
  driver.runtime.question({
    sessionId: 's9',
    request: { questions: [{ header: 'Deploy', question: 'Deploy to production?', options: [{ label: 'yes' }, { label: 'no' }] }] },
  })
  driver.runtime.status({ sessionId: 's9', running: false })
  await driver.settle()
  assert.equal(driver.sent.length, 1, 'the idle transition does not add a "finished" notice on top')
  assert.equal(driver.sent[0].kind, 'question')
  assert.match(driver.sent[0].title, /Deploy/)
  assert.match(driver.sent[0].body, /yes \| no/)
})

test('an approval request notifies with the tool that needs permission', async () => {
  const driver = createDriver()
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's10' })
  driver.runtime.status({ sessionId: 's10', running: true })
  driver.runtime.approval({ sessionId: 's10', request: { toolName: 'bash', reason: 'writes outside the workspace' } })
  driver.runtime.status({ sessionId: 's10', running: false })
  await driver.settle()
  assert.equal(driver.sent.length, 1)
  assert.equal(driver.sent[0].kind, 'approval')
  assert.match(driver.sent[0].title, /bash/)
  assert.match(driver.sent[0].body, /writes outside the workspace/)
})

test('a child agent stays silent unless the subagent kind is switched on', async () => {
  const off = createDriver()
  assert.deepEqual(await off.turn('child-a', workedTurn(), { parentSession: 'root' }), [])

  const on = createDriver({ runtimeSettings: { alerts: { kinds: { subagent: { enabled: true } } } } })
  const sent = await on.turn('child-b', workedTurn(), { parentSession: 'root' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'subagent')
})

test('a switched-off kind notifies nobody, whatever else happens', async () => {
  const driver = createDriver({
    runtimeSettings: { alerts: { kinds: { completed: { enabled: false }, error: { enabled: false } } } },
  })
  assert.deepEqual(await driver.turn('s11', workedTurn()), [])
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's12' })
  driver.runtime.status({ sessionId: 's12', running: true })
  driver.runtime.error({ sessionId: 's12', error: new Error('nope'), stage: 'turn' })
  driver.runtime.status({ sessionId: 's12', running: false })
  await driver.settle()
  assert.deepEqual(driver.sent, [])
})

test('a second identical event inside the duplicate window is suppressed', async () => {
  const driver = createDriver()
  driver.sent.length = 0
  driver.runtime.noteSession({ sessionId: 's13' })
  driver.runtime.status({ sessionId: 's13', running: true })
  driver.runtime.approval({ sessionId: 's13', request: { toolName: 'bash', reason: 'same request' } })
  await driver.settle()
  const first = driver.sent.length
  driver.runtime.approval({ sessionId: 's13', request: { toolName: 'bash', reason: 'same request' } })
  await driver.settle()
  assert.equal(first, 1)
  assert.equal(driver.sent.length, 1, 'the engine deduplicates the repeated event itself')
})

test('the tracker retains the verdict the deferred dispatch reads', async () => {
  // The unit-level contract behind the scenarios above: `noteTurnEnd` judges the
  // turn, and the same verdict must still be readable when the idle transition
  // is dispatched a moment later.
  const tracker = new Tracker()
  tracker.noteSession('s14')
  tracker.noteTurnStart('s14')
  const empty = tracker.noteTurnEnd('s14', 1, { kind: 'completed' })
  assert.equal(empty.notify, false)
  assert.deepEqual(tracker.factsOf('s14').turnEnd, { notify: false, failed: false, aborted: false, turn: 1 })

  tracker.noteTurnStart('s14')
  tracker.noteSessionEvent('s14', 'tool/call', {})
  const worked = tracker.noteTurnEnd('s14', 2, { kind: 'completed' })
  assert.equal(worked.notify, true)
  assert.equal(tracker.factsOf('s14').turnEnd.turn, 2)

  const failure = tracker.noteError('s14', { error: new Error('boom'), stage: 'step' })
  assert.equal(failure.stage, 'step', 'the stage is retained so the deferred path can rebuild the cooldown key')
})

/**
 * Watchdog triggers: a run that goes quiet, a credential that dies, a goal that
 * stops, a workflow that fails, and a background job that fails.
 *
 * These are the alerts that exist because *nothing else* would fire: a hung turn
 * never ends, an expired credential never reaches a turn, a blocked goal stops
 * the driver, and a failed job settles long after the tool call that started it
 * returned. Each test drives the real runtime against a recording engine, so
 * "did it alert?" is answered by the events that came out.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Tracker } from '../lib/core/detect.js'
import { Guard } from '../lib/core/policy.js'
import { createRuntime, STALL_AFTER_MS, STALL_CHECK_MS } from '../lib/runtime/handlers.js'

/**
 * Build a runtime whose engine records the events it is asked to raise.
 *
 * @param {object} [options] - harness options
 * @param {any} [options.settings] - effective configuration the runtime reads
 * @returns {any} the driver, with the recorded events and the scheduled timers
 */
function harness(options = {}) {
  const events = []
  const scheduled = []
  const engine = {
    guard: new Guard(),
    raise: async (event) => {
      events.push(event)
      return { delivered: true, channels: ['email'], failures: [] }
    },
  }
  const tracker = new Tracker()
  const runtime = createRuntime({
    tracker,
    engine,
    settings: () => options.settings ?? { alerts: { kinds: {} } },
    timer: (delay, callback) => {
      scheduled.push({ delay, callback })
      return () => undefined
    },
  })
  return { runtime, tracker, events, scheduled }
}

test('a silent running turn alerts once, and again only after it moves and stalls again', () => {
  const { runtime, tracker, events, scheduled } = harness({ settings: { stallAfterMs: 60_000, alerts: { kinds: {} } } })
  const t0 = 1_000_000
  runtime.noteSession({ sessionId: 's' })
  runtime.status({ sessionId: 's', running: true })
  tracker.noteTurnStart('s')
  runtime.activity({ sessionId: 's', at: t0 })
  // The tool name comes from the durable `tool/call` event the agent loop
  // appends before dispatch, which is also what the completion alert counts.
  runtime.sessionEvent('s', 'tool/call', { turn: 1, step: 1, name: 'bash' })
  runtime.activity({ sessionId: 's', at: t0 })

  assert.ok(scheduled.some((entry) => entry.delay === STALL_CHECK_MS), 'the watchdog arms itself while a turn is open')

  runtime.stallCheck(t0 + 61_000)
  assert.equal(events.length, 1, 'one silent episode is one alert')
  assert.equal(events[0].kind, 'stall')
  assert.match(events[0].title, /1 min/)
  assert.match(events[0].body, /last tool seen: bash/)
  assert.equal(events[0].sessionId, 's')

  runtime.stallCheck(t0 + 300_000)
  assert.equal(events.length, 1, 'a still-silent turn does not alert again')

  runtime.activity({ sessionId: 's', at: t0 + 400_000 })
  runtime.stallCheck(t0 + 500_000)
  assert.equal(events.length, 2, 'activity starts a new episode')
  assert.notEqual(events[1].fingerprint, events[0].fingerprint, 'a second episode is not a duplicate of the first')
})

test('a turn that is no longer open is dropped instead of stalling forever', () => {
  const { runtime, tracker, events } = harness({ settings: { stallAfterMs: 1_000, alerts: { kinds: {} } } })
  runtime.noteSession({ sessionId: 's' })
  runtime.status({ sessionId: 's', running: true })
  tracker.noteTurnStart('s')
  runtime.activity({ sessionId: 's', at: 0 })
  tracker.noteTurnEnd('s', 1, { kind: 'completed' })
  runtime.stallCheck(60_000)
  assert.deepEqual(events, [], 'a closed turn cannot stall')
})

test('the stall threshold defaults to ten minutes and follows the configuration', () => {
  const { runtime, tracker, events } = harness({ settings: { alerts: { kinds: {} } } })
  runtime.noteSession({ sessionId: 's' })
  runtime.status({ sessionId: 's', running: true })
  tracker.noteTurnStart('s')
  runtime.activity({ sessionId: 's', at: 0 })
  runtime.stallCheck(STALL_AFTER_MS - 1)
  assert.deepEqual(events, [], 'the default threshold is ten minutes')
  runtime.stallCheck(STALL_AFTER_MS + 1)
  assert.equal(events.length, 1)
})

test('a dead credential alerts; a finished authorization that succeeded does not', () => {
  const { runtime, events } = harness()
  runtime.account({ reason: 'sign-in-required' })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'account')
  assert.equal(events[0].urgency, 'error')

  runtime.account({ reason: 'session-expired' })
  assert.equal(events.length, 2)
  assert.notEqual(events[1].fingerprint, events[0].fingerprint, 'the two account failures are distinct alerts')

  runtime.authorizationSettled({ key: 'deepseek:account', settlement: 'failed' })
  assert.equal(events.length, 3)
  assert.match(events[2].body, /deepseek:account/)

  runtime.authorizationSettled({ key: 'deepseek:account', settlement: 'authorized' })
  runtime.authorizationSettled({ key: 'deepseek:account', settlement: 'cancelled' })
  assert.equal(events.length, 3, 'a normal authorization end is not an alert')
})

test('a blocked goal alerts with its reason and rounds; other goal operations do not', () => {
  const { runtime, events } = harness()
  const goal = {
    id: 'g1',
    revision: 4,
    objective: 'Ship the release',
    phase: 'blocked',
    blockedReason: { code: 'rounds-exhausted', message: 'max goal rounds reached' },
    maxGoalRounds: 3,
    roundsStarted: 3,
  }
  runtime.goalChanged({ sessionId: 's', change: { operation: 'block', ref: { id: 'g1', revision: 4 }, goal } })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'goal')
  assert.match(events[0].title, /Ship the release/)
  assert.match(events[0].body, /max goal rounds reached/)
  assert.match(events[0].body, /3\/3/)

  runtime.goalChanged({ sessionId: 's', change: { operation: 'complete', ref: { id: 'g1', revision: 5 }, goal: { ...goal, phase: 'complete' } } })
  runtime.goalChanged({ sessionId: 's', change: { operation: 'edit', ref: { id: 'g1', revision: 6 }, goal: { ...goal, phase: 'active' } } })
  assert.equal(events.length, 1, 'only a block is news of its own')
})

test('a workflow that failed alerts; a completed or cancelled run does not', () => {
  const { runtime, events } = harness()
  const info = { id: 'w1', meta: { name: 'audit-sweep', description: '' } }
  runtime.workflowEnd({ info, result: { stopReason: 'completed', agentsStarted: 4 } })
  runtime.workflowEnd({ info, result: { stopReason: 'cancelled', agentsStarted: 4 } })
  assert.deepEqual(events, [])

  runtime.workflowEnd({ info, result: { stopReason: 'error', error: 'child run failed', agentsStarted: 4 } })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'workflow')
  assert.match(events[0].title, /audit-sweep/)
  assert.match(events[0].body, /child run failed/)
  assert.match(events[0].body, /4 agent/)
})

test('only a failed background job alerts, and a teardown failure has no reader', () => {
  const { runtime, events } = harness()
  const job = { id: 'bash-7', kind: 'bash', label: 'npm run build', owner: 's', status: 'failed', detail: 'exit code 1' }
  runtime.jobSettled({ type: 'settled', job, cause: 'producer', awaited: false })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'job')
  assert.match(events[0].title, /npm run build/)
  assert.match(events[0].body, /exit code 1/)
  assert.equal(events[0].sessionId, 's')

  runtime.jobSettled({ type: 'settled', job: { ...job, status: 'completed' }, cause: 'producer', awaited: false })
  runtime.jobSettled({ type: 'settled', job: { ...job, status: 'killed' }, cause: 'kill', awaited: false })
  runtime.jobSettled({ type: 'settled', job: { ...job, id: 'bash-8' }, cause: 'teardown', awaited: false })
  runtime.jobSettled({ type: 'output', id: 'bash-7', total: 12 })
  assert.equal(events.length, 1, 'a finished, killed, torn-down or still-streaming job is not a failure alert')
})

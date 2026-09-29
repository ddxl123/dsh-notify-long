/**
 * Retry contract test: drive the *real* retry policy the harness runs
 * (`@deepseek-ai/dsh-llm-retry`) and alert on the event it actually appends.
 *
 * The whole `retry` kind rests on one external fact — the harness announces a
 * scheduled retry by appending a session event named `llm/retry` whose `data`
 * carries the provider failure and the delay it is about to wait. A hand-written
 * payload can only prove this plugin agrees with itself, so this test mounts the
 * real retry plugin, triggers a real `agent/request-error`, and feeds the exact
 * payload that came out into the real runtime: if a harness upgrade renames the
 * event or moves a field, this fails here instead of going quiet in production.
 *
 * The test skips itself on a checkout without the harness peers, like the other
 * boot-level tests.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Tracker } from '../lib/core/detect.js'
import { Guard } from '../lib/core/policy.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/** @returns {Promise<boolean>} true when the retry peer resolves */
async function retryAvailable() {
  try {
    await import('@deepseek-ai/dsh-llm-retry')
    return true
  } catch {
    return false
  }
}

const contractTests = (await retryAvailable()) ? test : test.skip

/**
 * Run one failed model request through the harness's own retry policy.
 *
 * The context is the smallest one the real plugin uses: a `sessionProjections`
 * that reports no retry yet (so the plugin mints retry 1), an event registration
 * that hands back the listener, and a session whose `append` records what the
 * plugin wrote.
 *
 * @param {object} [overrides] - retry-policy fields to replace, to steer the outcome
 * @returns {Promise<any[]>} the `{ type, data }` pairs the plugin appended, in order
 */
async function appendRetryEvents(overrides = {}) {
  const { apply } = await import('@deepseek-ai/dsh-llm-retry')
  /** @type {any[]} */
  const appended = []
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  const lifetime = new AbortController()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionProjections: {
      register: () => {},
      stateOf: () => ({}),
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback) {
      return callback()
    },
  }
  apply(ctx, {})

  const listener = listeners.get('agent/request-error')
  assert.notEqual(listener, undefined, 'the policy must listen on agent/request-error')
  const decision = await listener({
    turn: 3,
    step: 1,
    provider: 'deepseek',
    // A real `LlmFailure`, as the agent loop hands it over.
    failure: { message: 'Connection error.', code: 'CONNECTION' },
    retryPolicy: {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['CONNECTION'],
      initialDelayMs: 5,
      maxDelayMs: 50,
      jitterRatio: 0,
      ...overrides,
    },
    signal: lifetime.signal,
    agent: { session: { append: (type, data) => { appended.push({ type, data }) } } },
  }, async () => undefined)
  assert.deepEqual(decision, { kind: 'retry' }, 'a retryable connection failure schedules one retry')
  return appended
}

/**
 * Build the plugin's runtime over a recording engine.
 *
 * @returns {any} the engine (with `events`), the tracker and the runtime
 */
function createRecorder() {
  const engine = {
    guard: new Guard(),
    events: [],
    raise: async (event) => {
      engine.events.push(event)
      return { delivered: true, channels: ['email'], failures: [] }
    },
  }
  const tracker = new Tracker()
  const runtime = createRuntime({
    tracker,
    engine,
    settings: () => ({ alerts: { kinds: {} }, language: 'en' }),
  })
  runtime.noteSession({ sessionId: 'session-retry', cwd: '/repo' })
  return { engine, tracker, runtime }
}

contractTests('the retry event the harness appends is what the runtime alerts on', async () => {
  const appended = await appendRetryEvents()
  const scheduled = appended.find((entry) => entry.type === 'llm/retry')
  assert.notEqual(scheduled, undefined, 'the policy announces the wait as `llm/retry`')

  const { engine, runtime } = createRecorder()
  runtime.sessionEvent('session-retry', scheduled.type, scheduled.data)

  assert.equal(engine.events.length, 1, 'the payload the harness produced is alertable as it stands')
  const alert = engine.events[0]
  assert.equal(alert.kind, 'retry')
  assert.equal(alert.urgency, 'info')
  assert.equal(alert.turn, 3, 'the alert carries the turn the failed request belonged to')
  assert.equal(alert.cwd, '/repo')
  assert.match(alert.body, /Failure reason: Connection error\. \(CONNECTION\)/)
  assert.match(alert.body, /Retry delay: 5 ms/, 'the delay is the one the policy computed')
  assert.match(alert.body, /attempt 1 of 4/, 'and the position in the chain comes from the same payload')
  assert.match(alert.body, /provider: deepseek/)
})

contractTests('the retry that starts afterwards does not alert a second time', async () => {
  const appended = await appendRetryEvents()
  const types = appended.map((entry) => entry.type)
  assert.deepEqual(types, ['llm/retry', 'llm/retry-started'], 'one retry writes two events')

  const { engine, runtime } = createRecorder()
  for (const entry of appended) runtime.sessionEvent('session-retry', entry.type, entry.data)
  assert.equal(engine.events.length, 1, 'the started event is the same retry a moment later')
  assert.equal(engine.events[0].kind, 'retry')
})

contractTests('a non-retryable failure never reaches the runtime at all', async () => {
  const { apply } = await import('@deepseek-ai/dsh-llm-retry')
  /** @type {any[]} */
  const appended = []
  /** @type {Function | undefined} */
  let listener
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionProjections: { register: () => {}, stateOf: () => ({}) },
    on(_event, handler) {
      listener = handler
      return () => {}
    },
    effect: (callback) => callback(),
  }
  apply(ctx, {})
  // The policy decides: an auth failure is not in `retryableCodes`, so the
  // harness falls through to the terminal error instead of retrying — and the
  // plugin raises nothing, leaving the error alert to speak alone.
  const decision = await listener({
    turn: 1,
    step: 1,
    provider: 'deepseek',
    failure: { message: 'API key is invalid', code: 'AUTH' },
    retryPolicy: { mode: 'normal', maxRetries: 4, retryableCodes: ['CONNECTION'], initialDelayMs: 5, maxDelayMs: 50, jitterRatio: 0 },
    signal: new AbortController().signal,
    agent: { session: { append: (type, data) => { appended.push({ type, data }) } } },
  }, async () => undefined)
  assert.equal(decision, undefined)
  assert.deepEqual(appended, [])
})

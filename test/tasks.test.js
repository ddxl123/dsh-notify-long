/**
 * Task-list and plan-review triggers.
 *
 * Two things the operator asked to hear about that used to be invisible:
 *
 * - the model's `todo_write` list, which the harness appends to the session as a
 *   `todo/write` snapshot and resets on `turn/start`;
 * - a plan review, which `exit_plan_mode` asks through the same
 *   `user-questions/request` waterfall as any other question and marks with
 *   `intent.kind === 'plan-review'`.
 *
 * Both are driven here through the real runtime, so the assertions cover the
 * whole path from event payload to raised alert.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Tracker } from '../lib/core/detect.js'
import { Guard } from '../lib/core/policy.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/**
 * Build a runtime whose engine records the events it is asked to raise.
 *
 * @returns {any} the driver
 */
function harness() {
  const events = []
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
    settings: () => ({ alerts: { kinds: {} } }),
    timer: () => () => undefined,
  })
  /** Start a running turn with a little work behind it. */
  const beginTurn = (sessionId = 's') => {
    runtime.noteSession({ sessionId })
    runtime.status({ sessionId, running: true })
    tracker.noteTurnStart(sessionId)
    runtime.sessionEvent(sessionId, 'step/start', {})
    return sessionId
  }
  return { runtime, tracker, events, beginTurn }
}

const list = (...statuses) => statuses.map((status, index) => ({ content: `task ${index + 1}`, status }))

test('every change to the task list is reported, and an identical rewrite is not', () => {
  const { runtime, tracker, events, beginTurn } = harness()
  const s = beginTurn()

  runtime.sessionEvent(s, 'todo/write', { todos: list('in_progress', 'pending') })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'task')
  assert.match(events[0].title, /0\/2/)
  assert.match(events[0].body, /\[>\] task 1/)
  assert.match(events[0].body, /\[ \] task 2/)
  assert.equal(events[0].urgency, 'info')

  runtime.sessionEvent(s, 'todo/write', { todos: list('in_progress', 'pending') })
  assert.equal(events.length, 1, 'the same list written twice is one change')

  runtime.sessionEvent(s, 'todo/write', { todos: list('completed', 'in_progress') })
  assert.equal(events.length, 2)
  assert.match(events[1].title, /1\/2/)
  assert.notEqual(events[1].fingerprint, events[0].fingerprint)
  assert.equal(tracker.factsOf(s)?.todos?.length, 2, 'the folded facts carry the current list')
})

test('a fully completed list alerts as such and suppresses the turn-end completion', () => {
  const { runtime, tracker, events, beginTurn } = harness()
  const s = beginTurn()
  runtime.sessionEvent(s, 'todo/write', { todos: list('completed', 'completed') })
  assert.equal(events.length, 1)
  assert.match(events[0].title, /All tasks completed \(2\)/)
  assert.equal(events[0].urgency, 'action')

  tracker.noteTurnEnd(s, 1, { kind: 'completed' })
  runtime.finish(s, { becameIdle: true, pending: tracker.consumePending(s), facts: tracker.factsOf(s) })
  assert.equal(events.length, 1, 'the completion alert would repeat the task alert')
})

test('finishing the list early does not silence the completion of the turn that kept working', () => {
  const { runtime, tracker, events, beginTurn } = harness()
  const s = beginTurn()
  runtime.sessionEvent(s, 'todo/write', { todos: list('completed') })
  assert.equal(events.length, 1)
  runtime.sessionEvent(s, 'todo/write', { todos: [...list('completed'), { content: 'follow-up work', status: 'pending' }] })
  assert.equal(events.length, 2, 'new unfinished work is its own change')
  assert.equal(tracker.consumePending(s), undefined, 'the task flag was dropped when work reappeared')

  tracker.noteTurnEnd(s, 1, { kind: 'completed' })
  runtime.finish(s, { becameIdle: true, pending: undefined, facts: tracker.factsOf(s) })
  assert.equal(events.length, 3)
  assert.equal(events[2].kind, 'completed')
})

test('clearing the list is reported, and a question still outranks a task notice', () => {
  const { runtime, tracker, events, beginTurn } = harness()
  const s = beginTurn()
  runtime.sessionEvent(s, 'todo/write', { todos: list('pending') })
  runtime.sessionEvent(s, 'todo/write', { todos: [] })
  assert.equal(events.length, 2)
  assert.match(events[1].title, /cleared/)

  tracker.notePending(s, 'question')
  tracker.notePending(s, 'task')
  assert.equal(tracker.consumePending(s), 'question', 'a question is never downgraded by a task notice')
})

test('a plan review is its own kind, carries the plan, and survives a repeated prompt', () => {
  const { runtime, events, beginTurn } = harness()
  const s = beginTurn()
  const review = (callId, detail) => ({
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId },
    }],
  })

  runtime.question({ sessionId: s, request: review('call-1', '# Release plan\n\n1. build\n2. ship') })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'plan')
  assert.match(events[0].title, /Plan ready for review/)
  assert.match(events[0].body, /# Release plan/)
  assert.match(events[0].detail, /1\. build/, 'the plan travels as detail so the email can render it')
  assert.match(events[0].hint, /Approve the plan/)

  // The model revised the plan and presented it again: identical prompt text,
  // different call — the second review must not be swallowed as a duplicate.
  runtime.question({ sessionId: s, request: review('call-2', '# Release plan v2') })
  assert.equal(events.length, 2)
  assert.notEqual(events[1].fingerprint, events[0].fingerprint)
  assert.match(events[1].body, /v2/)
})

test('an ordinary question stays a question and carries no plan detail', () => {
  const { runtime, events, beginTurn } = harness()
  const s = beginTurn()
  runtime.question({ sessionId: s, request: { questions: [{ id: 'q1', question: 'Which database?', options: [{ label: 'pg' }, { label: 'sqlite' }] }] } })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'question')
  assert.equal(events[0].detail, undefined)
  assert.match(events[0].body, /Which database\?/)
  assert.match(events[0].body, /pg \| sqlite/)
})

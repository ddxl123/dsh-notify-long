/**
 * Engine → activity-log tests: what the settings card's log panel will show.
 *
 * The engine is harness-free by design, so the same object the plugin mounts is
 * driven here with a real {@link ActivityLog} in a temp directory: delivery,
 * suppression, retry, give-up and digest each have to leave exactly one honest
 * entry behind.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ActivityLog } from '../lib/core/activity.js'
import { Engine, MAX_ATTEMPTS } from '../lib/core/engine.js'
import { activeChannels, Guard } from '../lib/core/policy.js'
import { Outbox } from '../lib/core/queue.js'

/** @param {string} name - prefix @returns {string} a fresh temp directory */
function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

/**
 * Build an engine with a real outbox and activity log.
 *
 * @param {object} [options] - overrides
 * @returns {any} the engine, its log and its outbox
 */
function makeEngine(options = {}) {
  const dir = tempDir('dsh-notify-long-engine')
  const activity = new ActivityLog({ path: join(dir, 'activity.json') })
  const outbox = new Outbox({ path: join(dir, 'outbox.json') })
  const settings = options.settings ?? {
    enabled: true,
    alerts: { channels: ['desktop', 'email'], kinds: {} },
    quietHours: {},
    email: { user: '1033839760@qq.com', pass: 'code' },
  }
  const engine = new Engine({
    outbox,
    activity,
    guard: new Guard({ dedupeWindowMs: 60_000, cooldownMs: 0, channelCooldownMs: 0 }),
    settings: () => settings,
    emailReady: () => true,
    playSound: async () => ({ ok: true, detail: 'played' }),
    showDesktop: options.showDesktop ?? (async () => ({ ok: true, detail: 'shown' })),
    sendEmail: options.sendEmail ?? (async () => ({ ok: true, detail: 'sent' })),
  })
  return { engine, activity, outbox, settings }
}

test('a delivered alert leaves one entry naming the channels it used', async () => {
  const { engine, activity } = makeEngine()
  const outcome = await engine.raise({ kind: 'completed', title: 'nightly build', body: 'green', at: Date.now() })
  assert.equal(outcome.delivered, true)
  const [entry] = activity.entries()
  assert.equal(entry.event, 'delivered')
  assert.equal(entry.level, 'info')
  assert.equal(entry.kind, 'completed')
  assert.equal(entry.title, 'nightly build')
  assert.deepEqual(entry.channels, ['desktop', 'email'])
  assert.match(entry.message, /delivered completed “nightly build” over desktop, email/)
  assert.equal(activity.stats().delivered, 1)
})

test('a failed delivery records the failure and the retry that follows it', async () => {
  const { engine, activity, outbox } = makeEngine({
    sendEmail: async () => ({ ok: false, detail: '535 authentication failed' }),
    showDesktop: async () => ({ ok: false, detail: 'no notification backend' }),
  })
  const outcome = await engine.raise({ kind: 'error', title: 'turn failed', body: 'boom', at: Date.now() })
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.queued, true)
  const entries = activity.entries()
  assert.equal(entries.length, 2)
  assert.equal(entries[1].event, 'failed', 'the failure comes first, oldest first on disk')
  assert.deepEqual(entries[1].failures, ['desktop: no notification backend', 'email: 535 authentication failed'])
  assert.equal(entries[0].event, 'queued')
  assert.equal(entries[0].attempts, 1)
  assert.match(entries[0].message, /retrying a error alert at .* \(attempt 1 of 5\)/)
  assert.equal(outbox.size, 1, 'the alert is still queued for the retry the entry promises')
})

test('giving up is recorded as an error entry rather than a silent drop', async () => {
  const { engine, activity, outbox } = makeEngine({
    sendEmail: async () => ({ ok: false, detail: 'connection refused' }),
    showDesktop: async () => ({ ok: false, detail: 'connection refused' }),
  })
  const record = { id: 'r1', at: Date.now(), kind: 'error', title: 'turn failed', body: 'boom', attempts: MAX_ATTEMPTS - 1, channels: ['email'] }
  outbox.add(record)
  await engine.drain()
  const [entry] = activity.entries()
  assert.equal(entry.event, 'dropped')
  assert.equal(entry.level, 'error')
  assert.equal(entry.attempts, MAX_ATTEMPTS)
  assert.match(entry.message, /gave up on a error alert after 5 attempts \(email: connection refused\)/)
  assert.equal(outbox.size, 0)
})

test('suppressions are recorded as skips, not as failures', async () => {
  const { engine, activity } = makeEngine()
  await engine.raise({ kind: 'completed', title: 'build', body: 'green', at: Date.now() })
  const duplicate = await engine.raise({ kind: 'completed', title: 'build', body: 'green', at: Date.now() })
  assert.equal(duplicate.skipped, 'duplicate within the suppression window')
  assert.equal(activity.entries()[0].event, 'skipped')
  assert.match(activity.entries()[0].message, /the same event was alerted inside the suppression window/)

  const off = makeEngine({ settings: { enabled: false, alerts: { channels: [] }, quietHours: {}, email: {} } })
  const disabled = await off.engine.raise({ kind: 'completed', title: 'build', body: 'green', at: Date.now() })
  assert.equal(disabled.skipped, 'disabled by configuration')
  assert.equal(off.activity.entries()[0].event, 'skipped')
  assert.equal(off.activity.stats().failed, 0, 'a suppression is never counted as a failure')
})

test('a collapsed burst is recorded once, as a skip', async () => {
  const { engine, activity, settings } = makeEngine()
  // Sound is the only channel, and the guard is holding its burst window.
  settings.alerts.channels = ['sound']
  engine.guard.channelCooldownMs = 60_000
  engine.guard.channelLast.set('sound', Date.now())
  const outcome = await engine.raise({ kind: 'completed', title: 'build', body: 'green', at: Date.now() })
  assert.equal(outcome.skipped, 'collapsed into a recent alert')
  assert.equal(activity.entries()[0].event, 'skipped')
  assert.match(activity.entries()[0].message, /collapsed into a recent alert/)
  assert.equal(activity.stats().failed, 0)
})

test('merging a burst into a digest is recorded', async () => {
  const { engine, activity, outbox } = makeEngine()
  outbox.add({ id: 'a', at: Date.now(), kind: 'completed', title: 'one', body: '', attempts: 0, channels: ['email'] })
  outbox.add({ id: 'b', at: Date.now(), kind: 'error', title: 'two', body: '', attempts: 0, channels: ['email'] })
  assert.equal(engine.squash('quiet hours'), 2)
  const [entry] = activity.entries()
  assert.equal(entry.event, 'queued')
  assert.match(entry.message, /merged 2 queued alerts into one digest \(quiet hours\)/)
})

test('a broken activity sink never breaks delivery', async () => {
  const { engine, outbox } = makeEngine()
  engine.activity = {
    append() { throw new Error('disk on fire') },
    delivery() { throw new Error('disk on fire') },
  }
  const outcome = await engine.raise({ kind: 'completed', title: 'build', body: 'green', at: Date.now() })
  assert.equal(outcome.delivered, true, 'the alert still went out')
  assert.equal(outbox.size, 0)
})

test('activeChannels answers what notify_status and the card both report', () => {
  const settings = { alerts: { channels: ['sound', 'desktop', 'email'] }, sound: { enabled: false }, desktop: {} }
  assert.deepEqual(activeChannels(settings, true), ['desktop', 'email'])
  assert.deepEqual(activeChannels(settings, false), ['desktop'])
  assert.deepEqual(activeChannels({ alerts: { channels: ['email'] } }, false), [])
  assert.deepEqual(activeChannels({}, true), ['sound', 'desktop', 'email'], 'an unset list means every channel')
})

/**
 * Unit tests for the bounded activity log the settings card renders.
 *
 * The log is the only place an operator can see whether an alert was actually
 * delivered, so what is asserted here is its contract: newest-first reads, a
 * hard bound, survival across a reload, and the guarantee that nothing
 * unbounded or secret-shaped is ever stored.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ActivityLog, MAX_ACTIVITY_ENTRIES, normalizeEntry } from '../lib/core/activity.js'

/** @param {string} name - prefix @returns {string} a fresh temp directory */
function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

/** @returns {any} a log in a throwaway directory, plus its path */
function makeLog(options = {}) {
  const path = join(tempDir('dsh-notify-long-activity'), 'activity.json')
  return { path, log: new ActivityLog({ path, ...options }) }
}

test('entries are appended oldest-first on disk and read newest-first', () => {
  const { log } = makeLog()
  log.append({ level: 'info', event: 'start', message: 'first' })
  log.append({ level: 'warn', event: 'failed', message: 'second' })
  const entries = log.entries()
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.message), ['second', 'first'])
  assert.equal(log.entries({ limit: 1 }).length, 1)
  assert.equal(log.size, 2)
})

test('the log survives a reload and keeps its derived counts', () => {
  const { path, log } = makeLog()
  log.delivery({ delivered: true, kind: 'completed', title: 'build', channels: ['email'] })
  log.delivery({ delivered: false, kind: 'error', title: 'boom', channels: ['email'], failures: ['email: 535 auth failed'] })
  log.append({ level: 'info', event: 'skipped', message: 'duplicate' })

  const reloaded = new ActivityLog({ path })
  const restored = reloaded.load()
  assert.equal(restored.loaded, 3)
  assert.equal(restored.dropped, 0)
  const stats = reloaded.stats()
  assert.equal(stats.total, 3)
  assert.equal(stats.delivered, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.skipped, 1)
  assert.match(stats.lastFailure.failures[0], /535 auth failed/)
  assert.equal(stats.lastSuccess.kind, 'completed')
})

test('the log is bounded and drops its oldest entries', () => {
  const { log } = makeLog({ max: 5 })
  for (let index = 0; index < 12; index += 1) {
    log.append({ level: 'info', event: 'log', message: `line ${index}` })
  }
  assert.equal(log.size, 5)
  assert.deepEqual(log.entries().map((entry) => entry.message), ['line 11', 'line 10', 'line 9', 'line 8', 'line 7'])
  assert.equal(MAX_ACTIVITY_ENTRIES, 300)
})

test('stale entries are dropped on load and a corrupt file is reset', () => {
  const { path, log } = makeLog()
  log.append({ level: 'info', event: 'log', message: 'old' })
  log.append({ level: 'info', event: 'log', message: 'new' })
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.items[0].at = Date.now() - 30 * 24 * 60 * 60 * 1000
  writeFileSync(path, JSON.stringify(raw), 'utf8')
  const pruned = new ActivityLog({ path })
  assert.equal(pruned.load().dropped, 1)
  assert.deepEqual(pruned.entries().map((entry) => entry.message), ['new'])

  const brokenPath = join(tempDir('dsh-notify-long-broken'), 'activity.json')
  writeFileSync(brokenPath, 'not json', 'utf8')
  const broken = new ActivityLog({ path: brokenPath })
  assert.deepEqual(broken.load(), { loaded: 0, dropped: 0 })
  assert.equal(broken.size, 0)
})

test('an append past the age horizon prunes what fell out of it', () => {
  let now = 1_000_000
  const { log } = makeLog({ now: () => now })
  log.append({ level: 'info', event: 'log', message: 'old' })
  now += 8 * 24 * 60 * 60 * 1000
  log.append({ level: 'info', event: 'log', message: 'new' })
  assert.deepEqual(log.entries().map((entry) => entry.message), ['new'], 'a week-old line does not linger in a long-running process')
})

test('one entry is clipped, whitelisted and never unbounded', () => {
  const { log } = makeLog()
  const stored = log.append({
    level: 'nonsense',
    event: 'delivered',
    message: `${'x'.repeat(5000)}\nsecond line`,
    channels: ['email', 'pigeon', 'sound'],
    failures: Array.from({ length: 20 }, (_, index) => `failure ${index} ${'y'.repeat(500)}`),
    attempts: 3.7,
  })
  assert.equal(stored.level, 'info', 'an unknown level degrades to info')
  assert.ok(stored.message.length <= 600)
  assert.deepEqual(stored.channels, ['sound', 'email'], 'only real channels survive, in canonical order')
  assert.equal(stored.failures.length, 6)
  assert.ok(stored.failures.every((line) => line.length <= 240))
  assert.equal(stored.attempts, 3)
  assert.equal(log.append({ level: 'info', event: 'log', message: '   ' }), undefined, 'an empty message is not an entry')
})

test('delivery() composes a readable line for a success and a failure', () => {
  const { log } = makeLog()
  const success = log.delivery({ delivered: true, kind: 'completed', title: 'build', channels: ['desktop', 'email'] })
  assert.equal(success.event, 'delivered')
  assert.equal(success.level, 'info')
  assert.match(success.message, /delivered completed “build” over desktop, email/)
  const failure = log.delivery({
    delivered: false,
    kind: 'error',
    title: 'boom',
    channels: ['email'],
    failures: ['email: connection refused'],
  })
  assert.equal(failure.event, 'failed')
  assert.equal(failure.level, 'warn')
  assert.match(failure.message, /could not deliver error “boom”: email: connection refused/)
})

test('normalizeEntry refuses anything without a message and keeps extras', () => {
  assert.equal(normalizeEntry({ level: 'info' }), undefined)
  assert.equal(normalizeEntry('nope'), undefined)
  const entry = normalizeEntry({ at: 5, level: 'error', event: 'dropped', message: 'gave up', kind: 'error', title: 't', attempts: 5 })
  assert.deepEqual(entry, { at: 5, level: 'error', event: 'dropped', message: 'gave up', kind: 'error', title: 't', attempts: 5 })
})

test('clear() empties the log and persists the empty document', () => {
  const { path, log } = makeLog()
  log.append({ level: 'info', event: 'log', message: 'one' })
  log.append({ level: 'info', event: 'log', message: 'two' })
  assert.equal(log.clear(), 2)
  assert.equal(log.size, 0)
  assert.equal(existsSync(path), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).items, [])
})

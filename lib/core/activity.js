/**
 * Activity log: the human-readable record of what this plugin did.
 *
 * The outbox answers "what still has to be delivered"; this answers the
 * question an operator actually asks after a quiet night — *was I told, and did
 * it work?* Every delivery attempt, every suppression, every retry and every
 * plugin log line lands here, newest last on disk and newest first on the wire,
 * so Settings → Plugins can render a log without reading the harness console.
 *
 * Two properties matter and shape the implementation:
 *
 * - **It is bounded.** A notification plugin that grows an unbounded file is a
 *   disk leak with a friendly name, so entries are capped by count and by age,
 *   and the oldest are dropped on load and on append.
 * - **It never holds a secret.** Only messages this plugin composes reach it —
 *   configuration values are reported as their *source* (`env:DSH_SMTP_PASSWORD`),
 *   never as their value — and every string is clipped before it is stored, so a
 *   pathological SMTP banner cannot bloat the document either.
 *
 * The module is harness-free and synchronous: the same class is exercised by the
 * unit tests, and a failed write only reports through `onError`.
 *
 * @module dsh-notify-long/lib/core/activity
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { clip, describeError, isPlainObject, sanitizeLine, sanitizeText } from '../util.js'

/** Maximum entries retained in the activity log. */
export const MAX_ACTIVITY_ENTRIES = 300
/** Entries older than this are dropped on load: a week of history is plenty. */
export const MAX_ACTIVITY_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Longest stored message, in characters. */
export const MAX_MESSAGE_LENGTH = 600
/** Longest stored alert title, in characters. */
export const MAX_TITLE_LENGTH = 160
/** Longest stored single failure line, in characters. */
export const MAX_FAILURE_LENGTH = 240
/** How many failure lines one entry keeps. */
export const MAX_FAILURES = 6

/** Severities an entry can carry, most severe last. */
export const LEVELS = Object.freeze(['info', 'warn', 'error'])
/** Channels an entry may name, so a malformed one cannot invent a channel. */
const KNOWN_CHANNELS = Object.freeze(['sound', 'desktop', 'email'])

/**
 * @typedef {object} ActivityEntry
 * @property {number} at - epoch milliseconds the entry was written
 * @property {'info' | 'warn' | 'error'} level - severity
 * @property {string} event - what happened: `delivered`, `failed`, `queued`,
 *   `skipped`, `dropped`, `test`, `settings`, `log`, `start`
 * @property {string} message - one line describing it
 * @property {string} [kind] - notification kind, when the entry is about an alert
 * @property {string} [title] - alert title, when the entry is about one
 * @property {string[]} [channels] - channels the attempt covered
 * @property {string[]} [failures] - one line per channel that refused
 * @property {number} [attempts] - delivery attempts made for the alert
 */

/**
 * Normalize one candidate entry, dropping anything unusable.
 *
 * @param {unknown} value - candidate entry
 * @returns {ActivityEntry | undefined} the normalized entry, or undefined when it cannot be used
 */
export function normalizeEntry(value) {
  if (!isPlainObject(value)) return undefined
  const message = clip(sanitizeText(value.message), MAX_MESSAGE_LENGTH)
  if (message === '') return undefined
  const level = LEVELS.includes(value.level) ? value.level : 'info'
  const event = sanitizeLine(value.event ?? 'log') || 'log'
  const channels = Array.isArray(value.channels)
    ? KNOWN_CHANNELS.filter((channel) => value.channels.includes(channel))
    : []
  const failures = Array.isArray(value.failures)
    ? value.failures.slice(0, MAX_FAILURES).map((line) => clip(sanitizeLine(line), MAX_FAILURE_LENGTH)).filter((line) => line !== '')
    : []
  return {
    at: Number.isFinite(value.at) ? value.at : Date.now(),
    level,
    event,
    message,
    ...typeof value.kind === 'string' && value.kind !== '' ? { kind: sanitizeLine(value.kind) } : {},
    ...typeof value.title === 'string' && value.title !== '' ? { title: clip(sanitizeLine(value.title), MAX_TITLE_LENGTH) } : {},
    ...channels.length === 0 ? {} : { channels },
    ...failures.length === 0 ? {} : { failures },
    ...Number.isFinite(value.attempts) ? { attempts: Math.max(0, Math.trunc(value.attempts)) } : {},
  }
}

/**
 * File-backed, bounded activity log.
 *
 * Writes are immediate and atomic (`<file>.tmp` → rename), matching the outbox:
 * a crash mid-write must not truncate the history the operator is reading.
 */
export class ActivityLog {
  /**
   * @param {object} options - activity-log options
   * @param {string} options.path - absolute path of the JSON document
   * @param {number} [options.max] - retained entry count
   * @param {(message: string) => void} [options.onError] - diagnostic sink
   * @param {() => number} [options.now] - clock injection for tests
   */
  constructor(options) {
    this.path = options.path
    this.max = Number.isFinite(options.max) && options.max > 0 ? Math.trunc(options.max) : MAX_ACTIVITY_ENTRIES
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {ActivityEntry[]} oldest first */
    this.items = []
  }

  /**
   * Read the log from disk, dropping stale or malformed entries.
   *
   * @returns {{ loaded: number, dropped: number }} what the load found
   */
  load() {
    let raw
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return { loaded: 0, dropped: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.onError(`dsh-notify-long: activity log at ${this.path} is not valid JSON and was reset (${describeError(error)})`)
      this.items = []
      return { loaded: 0, dropped: 0 }
    }
    const list = isPlainObject(parsed) && Array.isArray(parsed.items) ? parsed.items : []
    const horizon = this.now() - MAX_ACTIVITY_AGE_MS
    const kept = []
    let dropped = 0
    for (const entry of list) {
      const normalized = normalizeEntry(entry)
      if (normalized === undefined || normalized.at < horizon) {
        dropped += 1
        continue
      }
      kept.push(normalized)
    }
    this.items = kept.slice(-this.max)
    return { loaded: this.items.length, dropped }
  }

  /** Persist the log. Failures are reported, never thrown. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version: 1, savedAt: this.now(), items: this.items }, undefined, 2)}\n`, 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      this.onError(`dsh-notify-long: could not persist the activity log at ${this.path} (${describeError(error)})`)
    }
  }

  /**
   * Append one entry, dropping the oldest when the cap or the age horizon is
   * reached. The age check is guarded by the oldest entry, so the common append
   * does no filtering at all.
   *
   * @param {object} entry - the entry to write
   * @returns {ActivityEntry | undefined} the stored entry, or undefined when it was unusable
   */
  append(entry) {
    const at = this.now()
    const normalized = normalizeEntry({ at, ...entry })
    if (normalized === undefined) return undefined
    const horizon = at - MAX_ACTIVITY_AGE_MS
    if (this.items.length > 0 && this.items[0].at < horizon) {
      this.items = this.items.filter((item) => item.at >= horizon)
    }
    this.items.push(normalized)
    if (this.items.length > this.max) this.items = this.items.slice(-this.max)
    this.save()
    return normalized
  }

  /**
   * Append a plain log line.
   *
   * @param {'info' | 'warn' | 'error'} level - severity
   * @param {string} message - the line
   * @param {object} [fields] - extra entry fields
   * @returns {ActivityEntry | undefined} the stored entry
   */
  log(level, message, fields = {}) {
    return this.append({ level, event: 'log', message, ...fields })
  }

  /**
   * Append a delivery outcome.
   *
   * @param {object} input - the outcome
   * @param {boolean} input.delivered - whether at least one channel succeeded
   * @param {string} [input.kind] - notification kind
   * @param {string} [input.title] - alert title
   * @param {string[]} [input.channels] - channels attempted
   * @param {string[]} [input.failures] - one line per failed channel
   * @param {number} [input.attempts] - attempts made
   * @param {string} [input.queued] - why the alert is being retried later
   * @param {string} [input.message] - an explicit message instead of the composed one
   * @returns {ActivityEntry | undefined} the stored entry
   */
  delivery(input) {
    const channels = Array.isArray(input.channels) ? input.channels : []
    const failures = Array.isArray(input.failures) ? input.failures : []
    const label = input.title === undefined ? (input.kind ?? 'alert') : `${input.kind ?? 'alert'} “${input.title}”`
    if (input.delivered === true) {
      return this.append({
        level: 'info',
        event: 'delivered',
        message: input.message ?? `delivered ${label} over ${channels.join(', ') || 'no channel'}`,
        kind: input.kind,
        title: input.title,
        channels,
        failures,
        attempts: input.attempts,
      })
    }
    return this.append({
      level: 'warn',
      event: 'failed',
      message: input.message ?? `could not deliver ${label}${failures.length === 0 ? '' : `: ${failures.join('; ')}`}`,
      kind: input.kind,
      title: input.title,
      channels,
      failures,
      attempts: input.attempts,
    })
  }

  /**
   * The newest entries first.
   *
   * @param {object} [options] - selection options
   * @param {number} [options.limit] - maximum entries to return
   * @returns {ActivityEntry[]} copies of the stored entries
   */
  entries(options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : this.max
    return this.items.slice(-limit).reverse().map((entry) => ({ ...entry }))
  }

  /**
   * Counts derived from the retained entries, so they survive a restart.
   *
   * @returns {{ total: number, delivered: number, failed: number, queued: number, dropped: number, skipped: number, lastSuccess?: ActivityEntry, lastFailure?: ActivityEntry }}
   *   the summary the settings card and `notify_status` render
   */
  stats() {
    const summary = { total: this.items.length, delivered: 0, failed: 0, queued: 0, dropped: 0, skipped: 0 }
    for (const entry of this.items) {
      if (entry.event === 'delivered') summary.delivered += 1
      else if (entry.event === 'failed') summary.failed += 1
      else if (entry.event === 'queued') summary.queued += 1
      else if (entry.event === 'dropped') summary.dropped += 1
      else if (entry.event === 'skipped') summary.skipped += 1
    }
    const lastOf = (event) => {
      for (let index = this.items.length - 1; index >= 0; index -= 1) {
        if (this.items[index].event === event) return { ...this.items[index] }
      }
      return undefined
    }
    const lastSuccess = lastOf('delivered')
    const lastFailure = lastOf('failed')
    return {
      ...summary,
      ...lastSuccess === undefined ? {} : { lastSuccess },
      ...lastFailure === undefined ? {} : { lastFailure },
    }
  }

  /** @returns {number} the retained entry count */
  get size() {
    return this.items.length
  }

  /**
   * Drop every entry, persisting the empty log.
   *
   * @returns {number} how many entries were removed
   */
  clear() {
    const count = this.items.length
    this.items = []
    this.save()
    return count
  }
}

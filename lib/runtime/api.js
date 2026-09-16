/**
 * The host half of the settings card's live view.
 *
 * The settings namespace carries configuration, and configuration is all it
 * carries: a card cannot learn from it whether last night's alert arrived. This
 * module is the second, read-mostly wire — one exact Fetch route that the
 * browser half posts to for the status strip and the activity log, for a test
 * alert, and for an outbox retry.
 *
 * ## Why an exact Fetch route and not a Connection RPC channel
 *
 * `ctx.connection.rpc.handle()` is the obvious home for this, and it does not
 * work from a consumer plugin. Its registry mounts each channel through
 * `owner.webServer.register(...)`, where `owner` is the Context that *read* the
 * service — and Cordis hands a service method a shadowed Context whose service
 * resolution walks the *provider's* fiber chain. `webServer` is not visible
 * there (Connection waits for it in a child fiber of its own), so the call
 * throws `cannot get property "webServer" without inject` and the channel is
 * never mounted. `ctx.connection.fetch.register()` has no such dependency: it
 * adds an exact route to the `/api` channel Connection has already mounted, and
 * the browser reaches it with an ordinary authenticated `fetch`.
 *
 * The handler is deliberately harness-free: it receives the engine, the outbox,
 * the activity log and the effective-settings thunk, and returns the
 * `{ ok, value }` / `{ ok, error }` envelope the card unwraps. {@link
 * createNotifyRoute} wraps that in the Fetch-shaped route object the registry
 * takes, so both halves are unit-testable without a browser or a live server —
 * the same reason `lib/core/*` exists.
 *
 * Nothing here ever returns a secret: the email view is
 * {@link describeEmail}'s redacted projection, and the activity entries are
 * composed by this plugin alone.
 *
 * @module dsh-notify-long/lib/runtime/api
 */

import { clampInt, describeError, isPlainObject } from '../util.js'
import { describeEmail } from '../channels/email.js'
import { activeChannels, describeQuietHours, quietHoursState } from '../core/policy.js'
import { runSelfTest } from './selftest.js'

/**
 * The exact path the card posts to. It lives below `/api` because that is the
 * channel Connection mounts, and it is namespaced by this package so no other
 * plugin can collide with it.
 */
export const API_PATH = '/api/dsh-notify-long'
/** Endpoints the route answers; anything else is refused. */
export const API_ENDPOINTS = Object.freeze(['snapshot', 'test', 'flush', 'clear'])
/** Test channels the `test` endpoint accepts. */
const TEST_CHANNELS = Object.freeze(['all', 'sound', 'desktop', 'email'])
/** Default number of activity entries one snapshot returns. */
export const DEFAULT_LOG_LIMIT = 100

/** @param {any} value - the payload @returns {any} the payload, or an empty object */
function asInput(value) {
  return isPlainObject(value) ? value : {}
}

/** @param {any} value - a business result @returns {{ ok: true, value: any }} the success envelope */
function ok(value) {
  return { ok: true, value }
}

/**
 * @param {string} code - machine-readable failure code
 * @param {string} message - human-readable reason
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the failure envelope
 */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * One queued alert, reduced to what a log line needs.
 *
 * @param {any} record - the outbox record
 * @returns {any} the summary
 */
function queuedSummary(record) {
  return {
    id: record.id,
    at: record.at,
    kind: record.kind,
    title: record.title,
    attempts: record.attempts ?? 0,
    ...Number.isFinite(record.notBefore) ? { notBefore: record.notBefore } : {},
    ...Array.isArray(record.channels) ? { channels: [...record.channels] } : {},
  }
}

/**
 * Build the endpoint handler behind {@link API_PATH}.
 *
 * @param {object} deps - endpoint dependencies
 * @param {any} deps.activity - the activity log
 * @param {any} deps.outbox - the durable outbox
 * @param {any} deps.engine - the alert engine
 * @param {() => any} deps.settings - reads the effective configuration
 * @param {() => boolean} deps.emailReady - whether SMTP is configured well enough to attempt
 * @param {(message: string) => void} [deps.log] - diagnostic sink
 * @returns {(endpoint: string, payload: unknown) => Promise<any>} the endpoint handler
 */
export function createNotifyApi(deps) {
  /**
   * The status strip: what is on, what is configured, what is queued.
   *
   * @param {any} input - the validated payload
   * @returns {any} the snapshot value
   */
  function snapshot(input) {
    const settings = deps.settings() ?? {}
    const email = describeEmail(settings)
    const quiet = quietHoursState(settings.quietHours?.start, settings.quietHours?.end)
    // A nonsense limit reads as "no preference" rather than "one entry": the
    // card asks for a page size, not for a way to break its own panel.
    const requested = Number.isFinite(input.limit) && input.limit > 0 ? input.limit : DEFAULT_LOG_LIMIT
    const limit = clampInt(requested, DEFAULT_LOG_LIMIT, 1, deps.activity.max)
    const stats = deps.activity.stats()
    return {
      at: Date.now(),
      status: {
        enabled: settings.enabled !== false,
        channels: activeChannels(settings, deps.emailReady() === true),
        email,
        quiet: {
          configured: quiet.configured,
          active: quiet.active,
          range: [...quiet.range],
          label: describeQuietHours(quiet) || 'not configured',
        },
        queued: deps.outbox.size,
        delivered: deps.engine.delivered,
        failed: deps.engine.failed,
        ...deps.engine.lastFailure === undefined ? {} : { lastFailure: deps.engine.lastFailure },
        logPath: deps.activity.path,
      },
      stats,
      entries: deps.activity.entries({ limit }),
      queued: deps.outbox.items.slice(-50).map(queuedSummary),
    }
  }

  /**
   * Fire a test alert and report every channel.
   *
   * @param {any} input - the validated payload
   * @returns {Promise<any>} the test result
   */
  async function test(input) {
    const settings = deps.settings() ?? {}
    const requested = TEST_CHANNELS.includes(input.channel) ? input.channel : 'all'
    const result = await runSelfTest({
      engine: deps.engine,
      settings,
      emailReady: deps.emailReady() === true,
      channel: requested,
    })
    const lines = ['sound', 'desktop', 'email']
      .filter((channel) => result[channel] !== 'not requested')
      .map((channel) => `${channel}: ${result[channel]}`)
    deps.activity.append({
      level: result.ok ? 'info' : 'warn',
      event: 'test',
      message: `test alert (${requested}) — ${lines.join('; ') || 'nothing requested'}`,
    })
    return {
      ...result,
      requested,
      at: Date.now(),
      ...deps.outbox.size === 0 ? {} : { note: `${deps.outbox.size} alert(s) are still queued for delivery` },
    }
  }

  /**
   * Retry everything the outbox is holding.
   *
   * @returns {Promise<any>} the flush summary
   */
  async function flush() {
    const queued = deps.outbox.size
    deps.outbox.retryAll()
    const summary = await deps.engine.drain()
    deps.activity.append({
      level: summary.delivered > 0 || summary.failed === 0 ? 'info' : 'warn',
      event: 'queued',
      message: `outbox flushed on request: ${summary.delivered} delivered, ${summary.failed} deferred, ${summary.dropped} dropped (${queued} had been queued)`,
    })
    return { queued, ...summary }
  }

  /**
   * Answer one endpoint.
   *
   * @param {string} endpoint - the endpoint name
   * @param {unknown} payload - the caller's JSON payload
   * @returns {Promise<any>} the result envelope
   */
  return async function handle(endpoint, payload) {
    const input = asInput(payload)
    try {
      if (endpoint === 'snapshot') return ok(snapshot(input))
      if (endpoint === 'test') return ok(await test(input))
      if (endpoint === 'flush') return ok(await flush())
      if (endpoint === 'clear') return ok({ cleared: deps.activity.clear() })
      return fail('notify/unknown-endpoint', `unknown endpoint ${JSON.stringify(String(endpoint))}`)
    } catch (error) {
      const message = describeError(error)
      deps.log?.(`dsh-notify-long: the settings-card request ${endpoint} failed (${message})`)
      return fail('notify/internal', message)
    }
  }
}

/**
 * Build the exact Fetch route the card posts to.
 *
 * Connection's registry owns authentication and the HTTP carrier, so this only
 * has to be a well-behaved Fetch handler: refuse the wrong method and media
 * type with the status that says why, decode one JSON request, and answer with
 * one JSON envelope. A malformed body is the caller's bug (400), never a
 * failure of the plugin's own dependencies, which {@link createNotifyApi}
 * already reports inside the envelope.
 *
 * @param {object} deps - endpoint dependencies, as {@link createNotifyApi} takes them
 * @returns {{ path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }}
 *   the route object `ctx.connection.fetch.register` accepts
 */
export function createNotifyRoute(deps) {
  const handle = createNotifyApi(deps)
  return {
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (!isPlainObject(body) || typeof body.endpoint !== 'string') {
        return new Response('body must carry a string "endpoint"', { status: 400 })
      }
      return Response.json(await handle(body.endpoint, body.payload))
    },
  }
}

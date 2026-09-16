/**
 * Endpoint tests for the channel the settings card calls.
 *
 * The card cannot be driven without a browser, but the handler it talks to can:
 * this file builds one against real (tiny) dependencies and asserts the exact
 * envelope Connection's RPC contract expects — a value on success, a coded
 * failure otherwise, and never a thrown error or a secret.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ActivityLog } from '../lib/core/activity.js'
import { Outbox } from '../lib/core/queue.js'
import { API_PATH, createNotifyApi, createNotifyRoute } from '../lib/runtime/api.js'

/** @param {string} name - prefix @returns {string} a fresh temp directory */
function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

/**
 * Build the handler over fresh stubs.
 *
 * @param {object} [options] - overrides
 * @returns {any} the handler and its dependencies
 */
function makeApi(options = {}) {
  const dir = tempDir('dsh-notify-long-api')
  const activity = new ActivityLog({ path: join(dir, 'activity.json') })
  const outbox = new Outbox({ path: join(dir, 'outbox.json') })
  const settings = options.settings ?? {
    enabled: true,
    alerts: { channels: ['sound', 'desktop', 'email'] },
    email: { user: '1033839760@qq.com', pass: 'code' },
    sound: { enabled: false },
    desktop: { enabled: false },
  }
  const engine = {
    delivered: 2,
    failed: 1,
    lastFailure: 'email: 535 auth failed',
    drained: 0,
    sent: [],
    async drain() {
      this.drained += 1
      return { delivered: 1, failed: 0, dropped: 0 }
    },
    async playSound() { return { ok: false, detail: 'disabled in settings' } },
    async showDesktop() { return { ok: false, detail: 'disabled in settings' } },
    async sendEmail(input) {
      this.sent.push(input)
      return options.emailOutcome ?? { ok: true, detail: '250 queued as ABC123' }
    },
  }
  const logs = []
  const handle = createNotifyApi({
    activity,
    outbox,
    engine,
    settings: () => (typeof settings === 'function' ? settings() : settings),
    emailReady: () => options.emailReady ?? true,
    log: (message) => logs.push(message),
  })
  return { handle, activity, outbox, engine, logs }
}

test('snapshot reports the status, the log and the queue without secrets', async () => {
  const { handle, activity, outbox } = makeApi()
  activity.append({ level: 'info', event: 'start', message: 'started' })
  activity.delivery({ delivered: true, kind: 'completed', title: 'build', channels: ['email'] })
  outbox.add({ id: 'r1', at: Date.now(), kind: 'error', title: 'boom', body: 'b', attempts: 2, channels: ['email'] })

  const result = await handle('snapshot', { limit: 10 })
  assert.equal(result.ok, true)
  const value = result.value
  assert.equal(value.status.enabled, true)
  assert.deepEqual(value.status.channels, ['email'], 'sound and desktop are switched off in this configuration')
  assert.equal(value.status.email.ready, true)
  assert.equal(value.status.email.host, 'smtp.qq.com')
  assert.deepEqual(value.status.email.to, ['1033839760@qq.com'])
  assert.equal(value.status.email.secretSource, 'inline')
  assert.equal(value.status.queued, 1)
  assert.equal(value.status.delivered, 2)
  assert.equal(value.status.lastFailure, 'email: 535 auth failed')
  assert.match(value.status.logPath, /activity\.json$/)
  assert.equal(value.stats.delivered, 1)
  assert.deepEqual(value.entries.map((entry) => entry.message), ['delivered completed “build” over email', 'started'])
  assert.deepEqual(value.queued, [{ id: 'r1', at: value.queued[0].at, kind: 'error', title: 'boom', attempts: 2, channels: ['email'] }])
  assert.equal(JSON.stringify(value).includes('code'), false, 'the authorization code never crosses the wire')
})

test('the snapshot limit is clamped to what the log actually holds', async () => {
  const { handle, activity } = makeApi()
  for (let index = 0; index < 5; index += 1) activity.append({ level: 'info', event: 'log', message: `line ${index}` })
  assert.equal((await handle('snapshot', { limit: 2 })).value.entries.length, 2)
  assert.equal((await handle('snapshot', { limit: -5 })).value.entries.length, 5)
  assert.equal((await handle('snapshot', undefined)).value.entries.length, 5)
})

test('test fires the configured channels, records the result and reports each line', async () => {
  const { handle, activity, engine } = makeApi()
  const result = await handle('test', { channel: 'email' })
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, true)
  assert.equal(result.value.requested, 'email')
  assert.equal(result.value.email, 'sent (250 queued as ABC123)')
  assert.equal(result.value.sound, 'not requested')
  assert.equal(engine.sent.length, 1)
  const entries = activity.entries()
  assert.equal(entries[0].event, 'test')
  assert.match(entries[0].message, /test alert \(email\) — email: sent \(250 queued as ABC123\)/)
})

test('test reports a failure per channel instead of failing the request', async () => {
  const { handle } = makeApi({ emailOutcome: { ok: false, detail: '535 authentication failed' } })
  const result = await handle('test', { channel: 'all' })
  assert.equal(result.ok, true, 'the request succeeded even though the test alert did not')
  assert.equal(result.value.ok, false)
  assert.match(result.value.email, /failed: 535 authentication failed/)
  assert.equal(result.value.sound, 'disabled in settings')
})

test('test refuses an unknown channel by falling back to all of them', async () => {
  const { handle } = makeApi()
  const result = await handle('test', { channel: 'carrier-pigeon' })
  assert.equal(result.value.requested, 'all')
})

test('flush retries the outbox and records what happened', async () => {
  const { handle, activity, outbox, engine } = makeApi()
  outbox.add({ id: 'r1', at: Date.now(), kind: 'error', title: 'boom', body: 'b', attempts: 3, notBefore: Date.now() + 60_000 })
  const result = await handle('flush', {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { queued: 1, delivered: 1, failed: 0, dropped: 0 })
  assert.equal(engine.drained, 1)
  assert.equal(outbox.items[0].attempts, 0, 'every record got its attempt budget back')
  assert.match(activity.entries()[0].message, /outbox flushed on request: 1 delivered, 0 deferred, 0 dropped \(1 had been queued\)/)
})

test('clear empties the log and reports how much it dropped', async () => {
  const { handle, activity } = makeApi()
  activity.append({ level: 'info', event: 'log', message: 'one' })
  activity.append({ level: 'info', event: 'log', message: 'two' })
  const result = await handle('clear', {})
  assert.deepEqual(result.value, { cleared: 2 })
  assert.equal(activity.size, 0)
})

test('an unknown endpoint and a broken dependency both answer with an error envelope', async () => {
  const { handle, logs } = makeApi()
  const unknown = await handle('explode', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'notify/unknown-endpoint')
  assert.deepEqual(unknown.error.details, {})

  const broken = makeApi({ settings: () => { throw new Error('settings exploded') } })
  const failed = await broken.handle('snapshot', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'notify/internal')
  assert.match(failed.error.message, /settings exploded/)
  assert.equal(broken.logs.length, 1, 'the failure is reported to the plugin log too')
  assert.equal(logs.length, 0)
})

test('an email section with no configuration reports itself as not ready', async () => {
  const { handle } = makeApi({ settings: { enabled: true, alerts: { channels: ['email'] }, email: {} }, emailReady: false })
  const value = (await handle('snapshot', {})).value
  assert.equal(value.status.email.ready, false)
  assert.deepEqual(value.status.channels, [], 'email drops out of the active channels while it is unconfigured')
  assert.match(value.status.email.summary, /not configured/)
})

/** @param {string} endpoint - the endpoint to ask for @param {any} [payload] - its payload @returns {Request} the request the card would send */
function cardRequest(endpoint, payload) {
  return new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload ?? {} }),
  })
}

test('the published route is an exact Fetch route on the connection channel', () => {
  const { handle } = makeApi()
  const route = createNotifyRoute({ activity: new ActivityLog({ path: join(tempDir('dsh-notify-long-route'), 'a.json') }), outbox: {}, engine: {}, settings: () => ({}), emailReady: () => false })
  assert.equal(route.path, '/api/dsh-notify-long', 'below /api, namespaced by this package')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
  assert.equal(typeof handle, 'function')
})

test('the route answers the card with the endpoint envelope', async () => {
  const { handle, activity } = makeApi()
  const route = createNotifyRoute({ activity, outbox: { size: 0, items: [] }, engine: { delivered: 0, failed: 0 }, settings: () => ({ enabled: true, alerts: { channels: [] }, email: {} }), emailReady: () => false })
  const response = await route.fetch(cardRequest('snapshot', { limit: 5 }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true)
  const envelope = await response.json()
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.value.entries, [])
  assert.equal(envelope.value.status.email.ready, false)
  assert.equal(handle !== undefined, true)
})

test('the route refuses a wrong method, media type or body with the status that says why', async () => {
  const route = createNotifyRoute({ activity: { max: 10 }, outbox: {}, engine: {}, settings: () => ({}), emailReady: () => false })
  const wrongMethod = await route.fetch(new Request(`http://dsh.test${API_PATH}`, { method: 'GET' }))
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')

  const wrongType = await route.fetch(new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  }))
  assert.equal(wrongType.status, 415)

  const brokenJson = await route.fetch(new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  assert.equal(brokenJson.status, 400)

  const noEndpoint = await route.fetch(new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: {} }),
  }))
  assert.equal(noEndpoint.status, 400)
  assert.match(await noEndpoint.text(), /endpoint/)
})

test('an unknown endpoint travels as a failure envelope, not as an HTTP error', async () => {
  const { activity } = makeApi()
  const route = createNotifyRoute({ activity, outbox: { size: 0, items: [] }, engine: {}, settings: () => ({}), emailReady: () => false })
  const response = await route.fetch(cardRequest('explode'))
  assert.equal(response.status, 200, 'the transport worked; the request did not')
  const envelope = await response.json()
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'notify/unknown-endpoint')
})

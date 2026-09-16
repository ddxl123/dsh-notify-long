/**
 * Transport integration test: mount the real plugin into a real Cordis runtime
 * with the real Connection service, then drive the route the settings card uses.
 *
 * This is the seam a fake cannot cover, and it has already caught one real
 * failure: `ctx.connection.rpc.handle()` looks like the obvious way to publish
 * the card's endpoints, but its registry mounts each channel through
 * `owner.webServer.register(...)` on a *shadowed* Context whose service
 * resolution walks the provider's fiber chain — where `webServer` is not
 * visible. The call throws `cannot get property "webServer" without inject`, the
 * channel is never mounted, and the browser gets the frontend's 405 for every
 * request. The plugin therefore registers an exact Fetch route through
 * `connection.fetch`, and this test proves the route is mounted, answers, and is
 * removed again on dispose.
 *
 * The test skips itself on a checkout without the harness peers, like the other
 * boot-level tests.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNotifyRoute, API_PATH } from '../lib/runtime/api.js'

/** @returns {Promise<boolean>} true when the transport peers resolve */
async function peersAvailable() {
  try {
    await import('@deepseek-ai/cordis')
    await import('@deepseek-ai/dsh-client-connection')
    return true
  } catch {
    return false
  }
}

const transportTests = (await peersAvailable()) ? test : test.skip

/**
 * Build the real runtime: a Cordis root with the stub services this plugin
 * reads, the real Connection service, and the real plugin mounted through the
 * same `inject` list its package declares.
 *
 * @param {string} home - the state directory the plugin should use
 * @returns {Promise<any>} the shared `/api` handler, the plugin fiber, and the root
 */
async function mountTransport(home) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { HostConnectionService } = await import('@deepseek-ai/dsh-client-connection')
  const module = await import('../src/index.js')

  const root = new Context()
  const holder = { connection: undefined }
  root.plugin({
    name: 'test-harness',
    apply(ctx) {
      ctx.provide('agents', {})
      ctx.provide('tools', { register: () => () => {} })
      ctx.provide('paths', { home })
      ctx.provide('settings', {
        writable: true,
        installSection(_owner, namespace, _schema, base, hooks) {
          if (namespace !== 'dsh-notify-long') throw new Error(`unexpected namespace ${namespace}`)
          hooks.setSource(() => base)
        },
      })
      holder.connection = new HostConnectionService(ctx, [], { isAuthenticated: () => true })
    },
  })
  const fiber = root.plugin({ name: module.name, inject: module.inject, apply: module.apply })
  await new Promise((resolve) => { setTimeout(resolve, 200) })
  return { root, fiber, connection: holder.connection }
}

/**
 * POST one endpoint the way the browser half does.
 *
 * @param {any} handler - the shared `/api` fetch handler
 * @param {any} body - the request envelope
 * @returns {Promise<{ status: number, envelope: any }>} the decoded answer
 */
async function post(handler, body) {
  const response = await handler.fetch(new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, envelope: await response.json() }
}

transportTests('the card route mounts on the real connection channel and answers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-notify-long-transport-'))
  const { fiber, connection } = await mountTransport(home)
  const handler = connection.createSharedFetchHandler('/api')

  assert.equal(
    handler.requestBodyMode({ method: 'POST', url: new URL(`http://dsh.test${API_PATH}`) }),
    'buffered',
    'the route declares a buffered body, which is what the HTTP bridge reads',
  )

  const snapshot = await post(handler, { endpoint: 'snapshot', payload: { limit: 10 } })
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.envelope.ok, true)
  assert.equal(snapshot.envelope.value.status.enabled, true)
  assert.equal(snapshot.envelope.value.status.email.ready, false, 'no mailbox is configured in this test')
  assert.deepEqual(snapshot.envelope.value.entries.map((entry) => entry.event), ['start'])

  // The regression guard: a plugin that failed to publish its route says so in
  // its own activity log, and the card would render that instead of a log.
  const messages = snapshot.envelope.value.entries.map((entry) => entry.message).join('\n')
  assert.equal(messages.includes('could not publish'), false, messages)
  assert.equal(messages.includes('without inject'), false, messages)

  const unknown = await post(handler, { endpoint: 'nope' })
  assert.equal(unknown.status, 200, 'the transport worked; the request did not')
  assert.equal(unknown.envelope.ok, false)
  assert.equal(unknown.envelope.error.code, 'notify/unknown-endpoint')

  // Disposal is part of the contract: unloading the plugin must take the route
  // with it, not leave a dead endpoint on the channel.
  await fiber.dispose()
  const gone = await handler.fetch(new Request(`http://dsh.test${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'snapshot' }),
  }))
  assert.equal(gone.status, 404)
})

transportTests('the route object is the one the plugin registers', () => {
  const route = createNotifyRoute({
    activity: { max: 10, entries: () => [], stats: () => ({}), append: () => {}, clear: () => 0, path: '/tmp/x' },
    outbox: { size: 0, items: [] },
    engine: { delivered: 0, failed: 0 },
    settings: () => ({ enabled: true, alerts: { channels: [] }, email: {} }),
    emailReady: () => false,
  })
  assert.equal(route.path, API_PATH)
  assert.deepEqual(route.methods, ['POST'])
})

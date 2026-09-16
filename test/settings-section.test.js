/**
 * The host half's settings contract, checked against the same peer packages a
 * dsh installation provides.
 *
 * The browser card cannot be exercised without a browser, but the two things
 * it depends on can: the schema must survive the wire serialization the
 * settings page performs, and `role('secret')` must be redacted the way the
 * card's "configured" indicator assumes. Both are properties of the peer
 * packages, so this file skips itself on a checkout without them rather than
 * reporting a failure the package cannot fix.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { Config } from '../src/index.js'

/**
 * Whether this checkout can reach the harness peer packages.
 *
 * @returns {Promise<boolean>} true when schemastery and dsh-settings resolve
 */
async function peersAvailable() {
  try {
    await import('@deepseek-ai/schemastery')
    await import('@deepseek-ai/dsh-settings')
    return true
  } catch {
    return false
  }
}

const contractTests = (await peersAvailable()) ? test : test.skip

contractTests('the schema serializes for the settings wire', () => {
  const json = Config.toJSON()
  assert.deepEqual(Object.keys(json).sort(), ['refs', 'uid'], 'the wire form is a reference graph')
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json, 'the whole document must survive JSON')
  const root = json.refs[String(json.uid)]
  assert.equal(root.type, 'object')
  for (const key of ['enabled', 'email', 'quietHours', 'alerts', 'outbox', 'tools', 'debug']) {
    assert.ok(key in root.dict, `the serialized section must carry ${key}`)
  }
  const email = json.refs[String(root.dict.email)]
  assert.equal(email.type, 'object')
  assert.deepEqual(Object.keys(email.dict).slice(0, 4), ['enabled', 'preset', 'host', 'port'])
  const pass = json.refs[String(email.dict.pass)]
  assert.equal(pass.meta.role, 'secret', 'the password keeps its secret role across the wire')
})

contractTests('a stored password is redacted into the sidecar the card reads', async () => {
  const { redactSecrets } = await import('@deepseek-ai/dsh-settings')
  const redacted = redactSecrets(Config, { email: { host: 'smtp.qq.com', pass: 'app-password' } })
  assert.equal(redacted.value.email.pass, undefined, 'the literal never crosses the wire')
  assert.deepEqual(redacted.secrets, [{ path: ['email', 'pass'], set: true }])
  const empty = redactSecrets(Config, { email: { host: 'smtp.qq.com' } })
  assert.deepEqual(empty.secrets, [{ path: ['email', 'pass'], set: false }])
})

test('the host namespace and the browser card key are the same string', () => {
  const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const browser = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  const namespace = /installSection\(ctx, '([^']+)'/.exec(host)
  assert.ok(namespace !== null, 'the host half must register a settings section')
  assert.ok(
    browser.includes(`const NS = '${namespace[1]}'`),
    `the browser card must claim the settings.plugin.item seat keyed ${namespace[1]}`,
  )
  assert.ok(browser.includes("name: 'settings.plugin.item'"), 'the card must register into the plugin card slot')
})

test('the host route and the browser card post to the same path', async () => {
  const { API_PATH } = await import('../lib/runtime/api.js')
  const browser = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  assert.equal(API_PATH, '/api/dsh-notify-long', 'the route lives below the channel Connection mounts')
  assert.ok(
    browser.includes('const API_PATH = `/api/${NS}`'),
    'the browser card must build the same path from its namespace',
  )
  assert.ok(
    browser.includes('body: JSON.stringify({ endpoint, payload: payload ?? {} })'),
    'both halves must agree on the request envelope',
  )
})

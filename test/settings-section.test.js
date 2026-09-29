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

contractTests('every path the card writes is one the host accepts', async () => {
  // The decisive contract, checked with the host's own functions rather than a
  // reimplementation: `volatileForm` decides whether the entry is served at all,
  // and `isVolatilePath` is what the host runs over every form write before it
  // touches the document. A path missing from either list is a card control that
  // either never appears or always fails.
  const entry = import.meta.resolve('@deepseek-ai/dsh-settings')
  const { isVolatilePath, volatileForm } = await import(new URL('./types/schema.js', entry).href)

  assert.notEqual(volatileForm(Config), undefined, 'an entry with no volatile field is never served, so the page cannot exist')
  assert.deepEqual(
    Object.keys(volatileForm(Config).dict ?? {}).sort(),
    ['alerts', 'email', 'enabled', 'language'],
    'the served form covers exactly the sections the card edits',
  )

  /** The paths the browser card writes, mirroring its `FIELDS` specs. */
  const cardPaths = [
    ['enabled'],
    ['language'],
    ['alerts', 'channels'],
    ['email', 'enabled'],
    ['email', 'preset'],
    ['email', 'host'],
    ['email', 'port'],
    ['email', 'tls'],
    ['email', 'user'],
    ['email', 'pass'],
    ['email', 'passEnv'],
    ['email', 'passCommand'],
    ['email', 'from'],
    ['email', 'to'],
    ['email', 'cc'],
    ['email', 'subjectPrefix'],
    ['email', 'requireTls'],
    ['email', 'verifyCert'],
  ]
  for (const path of cardPaths) {
    assert.equal(isVolatilePath(Config, path), true, `${path.join('.')} must be volatile or the host refuses the write`)
  }

  // Everything else stays ordinary composition configuration: read from the
  // entry, changed by editing the profile, never writable from the browser.
  for (const path of [['debug'], ['tools', 'enabled'], ['outbox', 'path'], ['alerts', 'dedupeWindowMs'], ['sound', 'enabled'], ['email', 'html']]) {
    assert.equal(isVolatilePath(Config, path), false, `${path.join('.')} is composition-only`)
  }
})

test('the patch row, the package name, and the card namespace are one string', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const browser = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
  // The profile addresses the entry by row id, the harness serves the form under
  // that same id, and the card binds it by that name. A drift between them is an
  // entry that loads but can never be configured.
  const rowId = /^\s*-?\s*id:\s*(\S+)\s*$/m.exec(patch)
  assert.ok(rowId !== null, 'the bundle patch must insert a row')
  assert.equal(rowId[1], pkg.name, 'the row id is the package the profile installs')
  assert.ok(browser.includes(`const NS = '${rowId[1]}'`), 'the card must bind the entry id the host serves')
  assert.ok(browser.includes("name: 'plugins.item'"), 'the card must register into the Plugins page slot')
  assert.ok(browser.includes('configForms.whileServed([NS]'), 'the card must withdraw when the host stops serving the entry')
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

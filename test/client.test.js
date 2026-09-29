/**
 * Browser-half tests: load the real client bundle the way the web module
 * loader does, then drive the settings card through its public seams.
 *
 * `client/index.js` is not an ordinary module — it registers a factory with
 * `window.__ModuleLoader__`, exactly as the shipped client bundles do. The
 * harness here stubs that facade, materializes the factory with the platform
 * seed words it requires (`react`, the client store), and renders its card
 * against a fake settings host and a fake Connection RPC channel. What is
 * asserted is therefore the bundle the browser actually receives: the same
 * registration shape, the same staged writes, the same endpoint calls, the same
 * rendered tree.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Registrations the bundle pushed into the stubbed loader facade. */
const registrations = []

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

/**
 * A minimal `react` stand-in: elements are plain records, and the hooks the card
 * uses either return the current snapshot or do nothing at all. The card keeps
 * no React state of its own (its disclosure is a native `<details>`), so nothing
 * else is needed to render it.
 *
 * @returns {any} the fake module namespace
 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
    },
    Fragment: 'Fragment',
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

/**
 * The `@deepseek-ai/dsh-client-store` seed word, reduced to the contract the
 * card binds to: a stable snapshot that subscribers observe.
 *
 * @param {any} initial - the first snapshot
 * @returns {any} the store
 */
function fakeStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Seed modules the bundle requires, keyed by specifier. */
const SEEDS = {
  react: fakeReact(),
  '@deepseek-ai/dsh-client-store': { createSnapshotStore: fakeStore },
}

const require = (specifier) => {
  const seed = SEEDS[specifier]
  if (seed === undefined) throw new Error(`test harness has no seed module for "${specifier}"`)
  return seed
}

/**
 * Copy that stands in for the locale-bound `t`, so assertions can name keys.
 *
 * @param {string} key - dictionary key
 * @returns {string} the key itself
 */
const t = (key) => key

/**
 * Write one path-addressed settings operation into a plain section.
 *
 * @param {any} section - user layer, mutated in place
 * @param {any} op - the operation
 * @returns {void}
 */
function applyOp(section, op) {
  const path = op.path
  if (path.length === 0) throw new Error('test harness does not model whole-section ops')
  let node = section
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key]
  }
  const last = path[path.length - 1]
  if (op.op === 'set') node[last] = op.value
  else delete node[last]
}

/**
 * A settings host stand-in: one namespace, one user layer, a describe mirror
 * whose secret sidecar follows the layer.
 *
 * The runtime pieces mirror the 0.2 client contract exactly: `configForms.get`
 * hands back the `ConfigForm` (read/subscribe/mutate), `configForms.describe()`
 * the shared mirror, and `configForms.whileServed` the registration gate.
 *
 * @param {any} [user] - the initial user layer
 * @returns {any} the scope, describe face, and the recorded operations
 */
function createSettingsHost(user = {}) {
  /** @type {any[]} */
  const ops = []
  const listeners = new Set()
  const mirrorListeners = new Set()
  let revision = 1
  let layer = structuredClone(user)
  const base = { email: { port: 465 }, alerts: { channels: ['sound', 'desktop', 'email'] } }

  const secrets = () => [{ path: ['email', 'pass'], set: typeof layer?.email?.pass === 'string' && layer.email.pass !== '' }]
  let snapshot = build()

  function build() {
    return {
      status: 'ready',
      value: { ...structuredClone(base), ...structuredClone(layer) },
      base: structuredClone(base),
      user: structuredClone(layer),
      revision,
      writable: true,
      mode: 'host',
    }
  }

  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Record and apply one atomic mutation, then republish. */
    async mutate(operations) {
      ops.push(...structuredClone(operations))
      for (const operation of operations) applyOp(layer, operation)
      revision += 1
      snapshot = build()
      for (const listener of [...listeners]) listener()
      for (const listener of [...mirrorListeners]) listener()
    },
  }

  const describeFace = {
    getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: 'dsh-notify-long', secrets: secrets() }], writable: true, hasDocument: true }, error: null }),
    subscribe(listener) {
      mirrorListeners.add(listener)
      return () => { mirrorListeners.delete(listener) }
    },
    ensure: async () => {},
  }

  return { scope, describeFace, ops, layer: () => structuredClone(layer) }
}

/**
 * A host stand-in: it replaces the page's `fetch` with a recording stub that
 * answers the card's route the way the host half does.
 *
 * Stubbing the transport rather than a client service is deliberate — the card
 * posts to an ordinary same-origin URL, so what a test must pin is the request
 * it builds (path, method, media type, envelope) and how it reads the answer.
 *
 * @param {object} [options] - stub options
 * @param {any} [options.snapshot] - the value `snapshot` answers with
 * @param {number} [options.status] - an HTTP status to fail every call with
 * @param {Error} [options.fail] - an error every call rejects with
 * @returns {any} the stub, its recorded calls, and a restore function
 */
function createFakeTransport(options = {}) {
  /** @type {Array<{ url: string, method: string, contentType: string, body: any }>} */
  const calls = []
  const original = globalThis.fetch
  const value = options.snapshot ?? {
    at: Date.now(),
    status: {
      enabled: true,
      channels: ['desktop', 'email'],
      email: { ready: true, host: 'smtp.qq.com', port: 465, to: ['123456789@qq.com'], summary: 'ready' },
      quiet: { configured: false, active: false, range: [], label: 'not configured' },
      queued: 1,
      delivered: 1,
      failed: 0,
      logPath: '/tmp/activity.json',
    },
    stats: { total: 1, delivered: 1, failed: 0, queued: 0, dropped: 0, skipped: 0, lastSuccess: { at: Date.now(), message: 'delivered' } },
    entries: [{ at: Date.now(), level: 'info', event: 'delivered', message: 'delivered completed “build” over email', channels: ['email'] }],
    queued: [{ id: 'r1', at: Date.now(), kind: 'error', title: 'turn failed', attempts: 2, channels: ['email'] }],
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, contentType: init.headers['content-type'], body: JSON.parse(init.body) })
    if (options.fail !== undefined) throw options.fail
    if (options.status !== undefined) return new Response('nope', { status: options.status })
    const endpoint = calls[calls.length - 1].body.endpoint
    if (endpoint === 'test') return Response.json({ ok: true, value: { ok: true, requested: 'all', sound: 'played (afplay)', desktop: 'shown (osascript)', email: 'sent (250 queued)' } })
    if (endpoint === 'flush') return Response.json({ ok: true, value: { queued: 2, delivered: 1, failed: 1, dropped: 0 } })
    if (endpoint === 'clear') return Response.json({ ok: true, value: { cleared: 7 } })
    return Response.json({ ok: true, value })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// Import for effect: the bundle registers its factory with the stub above,
// which is the only thing executing a client bundle does.
await import('../client/index.js')

/** The registration the bundle produced, materialized with the seed modules. */
const registration = registrations.find((entry) => entry.id === 'dsh-notify-long')
const clientModule = registration.factory(require)

/**
 * Boot the client plugin against a fresh fake host.
 *
 * @param {any} [user] - the initial user layer
 * @param {object} [options] - harness options
 * @param {any} [options.transport] - the fetch stub to answer with
 * @returns {any} the host, the registered card, and the inject face
 */
function mount(user, options = {}) {
  const host = createSettingsHost(user)
  const transport = options.transport ?? createFakeTransport()
  /** @type {any[]} */
  const cards = []
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    locale: {
      bind: () => t,
      register: () => () => {},
    },
    inject(_deps, callback) {
      callback(this)
    },
    configForms: {
      get(namespace) {
        assert.equal(namespace, 'dsh-notify-long')
        return host.scope
      },
      describe: () => host.describeFace,
      whileServed(namespaces, register) {
        assert.deepEqual(namespaces, ['dsh-notify-long'])
        // The page is registered only while the host serves the namespace; the
        // stand-in always serves it, which is the case a card test cares about.
        return register(new Set(['dsh-notify-long']))
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'plugins.item')
        callback()
      },
      register(options_, component) {
        cards.push({ options: options_, component })
        return () => {}
      },
    },
  }
  clientModule.apply(ctx)
  assert.equal(cards.length, 1)
  const card = cards[0]
  const injected = card.options.inject()
  const props = {
    ...injected,
    t,
    view: 'page',
    useNotifySettings: (selector) => selector(injected.hooks.notifySettings.getSnapshot()),
    useNotifyLog: (selector) => selector(injected.hooks.notifyLog.getSnapshot()),
  }
  return { ...host, card, injected, props, transport }
}

/**
 * Collect every element from a fake-rendered tree.
 *
 * @param {any} element - the root element, or a nested children array
 * @returns {any[]} every element in the tree, root first
 */
function flatten(element) {
  if (Array.isArray(element)) return element.flatMap((child) => flatten(child))
  if (element === null || element === undefined || typeof element !== 'object') return []
  const children = element.props?.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  return [element, ...list.flatMap((child) => flatten(child))]
}

/**
 * Find the first element matching a predicate.
 *
 * @param {any} element - the root element
 * @param {(element: any) => boolean} predicate - the match
 * @returns {any} the element
 */
function find(element, predicate) {
  const match = flatten(element).find(predicate)
  assert.ok(match !== undefined, 'expected the rendered tree to contain a matching element')
  return match
}

/** @param {any} element - the rendered tree @returns {string[]} every control id in it */
function ids(element) {
  return flatten(element).map((entry) => entry.props?.id).filter((id) => typeof id === 'string')
}

/** Boot the bundle, which the module-loader stub captured on import. */
test('the bundle registers one client module under the package id', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registration.id, 'dsh-notify-long')
  assert.equal(typeof registration.factory, 'function')
})

test('the client plugin claims its entry on the Plugins page', () => {
  const { card, injected } = mount()
  assert.equal(clientModule.name, 'dsh-notify-long')
  assert.deepEqual(clientModule.inject, ['slots', 'locale'])
  assert.equal(card.options.name, 'plugins.item', '0.2 moved plugin pages from settings.plugin.item to the Plugins page')
  assert.equal(card.options.id, 'dsh-notify-long', 'a list slot is addressed by id, not key')
  assert.equal(card.options.key, undefined, 'key belongs to keyed slots only')
  assert.equal(card.options.locale, 'dsh-notify-long')
  assert.equal(typeof card.options.label, 'function')
  assert.equal(card.options.label(), 'cardTitle')
  assert.equal(typeof injected.hooks.notifySettings.getSnapshot, 'function')
  assert.equal(typeof injected.hooks.notifyLog.getSnapshot, 'function')
  for (const action of ['edit', 'resetField', 'discard', 'save', 'refreshLog', 'setCardOpen', 'setLogOpen', 'testLog', 'flushQueue', 'clearLog']) {
    assert.equal(typeof injected[action], 'function', `expected the card to receive ${action}`)
  }
})

test('the summary view is the one-liner the Plugins page lists', () => {
  const { card, props } = mount()
  const summary = card.component({ ...props, view: 'summary' })
  assert.equal(summary, 'cardDescription', 'the list row is copy, not the form')
  assert.notEqual(card.component({ ...props, view: 'page' }), null)
})

test('the card renders nothing while the host does not serve the namespace', () => {
  const { props, injected } = mount()
  injected.hooks.notifySettings.set({ available: false })
  assert.equal(props.useNotifySettings((snapshot) => snapshot).available, false)
  assert.equal(mount().card.component(props), null)
})

test('a staged SMTP host saves as one path-addressed write', async () => {
  const { props, ops, layer } = mount()
  assert.equal(props.useNotifySettings((snapshot) => snapshot).dirty, false)
  assert.equal(props.useNotifySettings((snapshot) => snapshot).port.text, '465', 'the composition layer fills the form')
  props.edit('host', 'smtp.qq.com')
  const staged = props.useNotifySettings((snapshot) => snapshot)
  assert.equal(staged.dirty, true)
  assert.equal(staged.host.text, 'smtp.qq.com')
  assert.equal(await props.save(), true)
  assert.deepEqual(ops, [{ op: 'set', path: ['email', 'host'], value: 'smtp.qq.com' }])
  assert.deepEqual(layer(), { email: { host: 'smtp.qq.com' } }, 'only the edited key reaches the user layer')
  assert.equal(props.useNotifySettings((snapshot) => snapshot).dirty, false)
})

test('an unparsable port blocks the save instead of dropping the edit', async () => {
  const { props, ops } = mount()
  props.edit('port', '70000')
  const state = props.useNotifySettings((snapshot) => snapshot)
  assert.equal(state.invalid, true)
  assert.equal(state.port.invalid, true)
  assert.equal(await props.save(), false)
  assert.deepEqual(ops, [])
  assert.equal(props.useNotifySettings((snapshot) => snapshot).dirty, true)
})

test('a reset stages a clear back to the layer below', async () => {
  const { props, ops, layer } = mount({ email: { host: 'smtp.example.com' } })
  assert.equal(props.useNotifySettings((snapshot) => snapshot).host.overridden, true)
  props.resetField('host')
  assert.equal(await props.save(), true)
  assert.deepEqual(ops, [{ op: 'unset', path: ['email', 'host'] }])
  assert.equal(layer().email.host, undefined)
})

test('the password is write-only and reports configured from the secret sidecar', async () => {
  const { props, ops, layer } = mount()
  assert.equal(props.useNotifySettings((snapshot) => snapshot).secretSet, false)
  assert.equal(props.useNotifySettings((snapshot) => snapshot).pass.text, '')
  props.edit('pass', 'app-password')
  assert.equal(await props.save(), true)
  assert.deepEqual(ops, [{ op: 'set', path: ['email', 'pass'], value: 'app-password' }])
  assert.equal(layer().email.pass, 'app-password')
  const saved = props.useNotifySettings((snapshot) => snapshot)
  assert.equal(saved.secretSet, true)
  assert.equal(saved.pass.text, '', 'the stored password never rides back into the form')
  props.resetField('pass')
  assert.equal(await props.save(), true)
  assert.deepEqual(ops[1], { op: 'unset', path: ['email', 'pass'] })
  assert.equal(props.useNotifySettings((snapshot) => snapshot).secretSet, false)
})

test('channel checkboxes rewrite the channel list in canonical order', async () => {
  const { props, ops } = mount()
  props.edit('channels', 'email,sound')
  assert.equal(await props.save(), true)
  assert.deepEqual(ops, [{ op: 'set', path: ['alerts', 'channels'], value: ['sound', 'email'] }])
})

test('a save the host refuses keeps the drafts and reports the failure', async () => {
  const { props, scope } = mount()
  scope.mutate = async () => {}
  props.edit('host', 'smtp.qq.com')
  assert.equal(await props.save(), false)
  const state = props.useNotifySettings((snapshot) => snapshot)
  assert.equal(state.failed, true)
  assert.equal(state.dirty, true)
  assert.equal(state.host.text, 'smtp.qq.com')
})

test('a QQ address is saved together with the provider preset it implies', async () => {
  const { props, ops, layer } = mount()
  assert.equal(props.useNotifySettings((snapshot) => snapshot).autoPreset, false, 'nothing to infer while the account is empty')
  props.edit('user', '123456789@qq.com')
  props.edit('pass', 'authorization-code')
  assert.equal(props.useNotifySettings((snapshot) => snapshot).autoPreset, true)
  assert.equal(await props.save(), true)
  assert.deepEqual(ops, [
    { op: 'set', path: ['email', 'user'], value: '123456789@qq.com' },
    { op: 'set', path: ['email', 'pass'], value: 'authorization-code' },
    { op: 'set', path: ['email', 'preset'], value: 'qq' },
  ])
  assert.equal(layer().email.preset, 'qq')
})

test('the inferred preset never overwrites a configured one', async () => {
  const explicit = mount({ email: { preset: 'qq-exmail' } })
  explicit.props.edit('user', 'someone@qq.com')
  assert.equal(explicit.props.useNotifySettings((snapshot) => snapshot).autoPreset, false)
  assert.equal(await explicit.props.save(), true)
  assert.deepEqual(explicit.ops, [{ op: 'set', path: ['email', 'user'], value: 'someone@qq.com' }])

  const hosted = mount({ email: { host: 'smtp.example.com' } })
  hosted.props.edit('user', 'someone@qq.com')
  assert.equal(hosted.props.useNotifySettings((snapshot) => snapshot).autoPreset, false, 'an explicit host means the user owns the server fields')
  const other = mount()
  other.props.edit('user', 'someone@gmail.com')
  assert.equal(other.props.useNotifySettings((snapshot) => snapshot).autoPreset, false, 'another provider is not silently reconfigured')
})

test('the rendered card leads with the QQ mailbox and hides the rest', () => {
  const { card, props } = mount()
  const tree = card.component(props)
  for (const field of ['enabled', 'channels', 'emailEnabled', 'user', 'pass', 'to', 'preset', 'host', 'port', 'tls', 'requireTls', 'verifyCert', 'from', 'cc', 'subjectPrefix', 'passEnv', 'passCommand']) {
    assert.ok(ids(tree).includes(`dsh-notify-long-${field}`), `expected a control for ${field}`)
  }
  assert.equal(find(tree, (element) => element.props?.id === 'dsh-notify-long-pass').props.type, 'password')
  assert.equal(find(tree, (element) => element.props?.id === 'dsh-notify-long-port').props.inputMode, 'numeric')

  // The server details live inside one collapsed disclosure, and the mailbox
  // fields do not: that is the whole simplification.
  const disclosures = flatten(tree).filter((element) => element.type === 'details')
  const advanced = disclosures.find((element) => flatten(element).some((entry) => entry.props?.id === 'dsh-notify-long-host'))
  assert.ok(advanced !== undefined, 'the advanced fields are inside a disclosure')
  assert.equal(advanced.props.open, undefined, 'and it starts collapsed')
  const mailbox = find(tree, (element) => element.type === 'fieldset' && flatten(element).some((entry) => entry.props?.id === 'dsh-notify-long-user'))
  assert.equal(flatten(mailbox).some((element) => element.props?.id === 'dsh-notify-long-host'), false, 'the mailbox fieldset carries only the mailbox fields')

  const select = find(tree, (element) => element.props?.id === 'dsh-notify-long-preset')
  const options = flatten(select).filter((element) => element.type === 'option').map((element) => element.props.value)
  assert.deepEqual(options, ['', 'qq', 'qq-exmail'], 'only QQ mail is offered')

  const buttons = flatten(tree).filter((element) => element.type === 'button')
  for (const button of buttons) {
    if (['discard', 'save'].includes(button.props.children)) {
      assert.equal(button.props.disabled, true, 'a clean form cannot be saved or discarded')
    }
  }
  props.edit('host', 'smtp.qq.com')
  const dirty = flatten(card.component(props)).filter((element) => element.type === 'button')
  assert.equal(dirty.filter((button) => ['discard', 'save'].includes(button.props.children)).every((button) => button.props.disabled === false), true)
})

test('the log panel reads the host route and renders what it answers', async () => {
  const { card, props, transport } = mount()
  await props.setCardOpen(true)
  assert.equal(transport.calls.length, 1)
  assert.deepEqual(
    { url: transport.calls[0].url, method: transport.calls[0].method, contentType: transport.calls[0].contentType },
    { url: '/api/dsh-notify-long', method: 'POST', contentType: 'application/json' },
    'the card posts one JSON request to the route the host half registers',
  )
  assert.deepEqual(transport.calls[0].body, { endpoint: 'snapshot', payload: { limit: 100 } })

  const tree = card.component(props)
  const summary = flatten(tree).find((element) => element.type === 'summary' && typeof element.props.children === 'string' && element.props.children.startsWith('logTitle'))
  assert.ok(summary !== undefined, 'the log disclosure is labelled with its counters')
  assert.match(summary.props.children, /logTitle · logDelivered 1 · logFailed 0/)
  const entries = flatten(tree).filter((element) => element.props?.className === 'dshNotifyLongEntry')
  assert.equal(entries.length, 1)
  assert.equal(flatten(entries[0]).some((element) => element.props?.children === 'delivered completed “build” over email'), true)
  const statuses = flatten(tree).filter((element) => element.props?.className === 'dshNotifyLongStatus')
  assert.match(statuses[0].props.children, /logEmail: logReady smtp\.qq\.com:465 → 123456789@qq\.com/)
  assert.match(statuses[1].props.children, /logQueued: error “turn failed” \(2\)/, 'a queued alert is named, not just counted')
})

test('the panel buttons call the matching endpoints and show the outcome', async () => {
  const { card, props, transport } = mount()
  await props.setLogOpen(true)
  await props.testLog()
  await props.flushQueue()
  await props.clearLog()
  assert.deepEqual(transport.calls.map((call) => call.body.endpoint), ['snapshot', 'test', 'snapshot', 'flush', 'snapshot', 'clear', 'snapshot'])
  assert.deepEqual(transport.calls[1].body.payload, { channel: 'all' })
  const tree = card.component(props)
  const result = flatten(tree).find((element) => element.props?.className === 'dshNotifyLongResult')
  assert.match(result.props.children, /logClearResult \(7\)/, 'the newest action owns the result line')
})

test('a card whose host half is not published still configures, and says why the log is empty', async () => {
  const { card, props } = mount(undefined, { transport: createFakeTransport({ status: 404 }) })
  await props.refreshLog()
  const log = props.useNotifyLog((snapshot) => snapshot)
  assert.equal(log.available, false)
  assert.match(log.error, /not published/)
  const tree = card.component(props)
  assert.match(find(tree, (element) => element.props?.className === 'dshNotifyLongHint' && String(element.props.children).includes('logUnavailable')).props.children, /logUnavailable/)
  assert.ok(ids(tree).includes('dsh-notify-long-user'), 'the form still renders')
})

test('a failing request is reported instead of breaking the card', async () => {
  const { card, props } = mount(undefined, { transport: createFakeTransport({ fail: new Error('network down') }) })
  await props.refreshLog()
  const log = props.useNotifyLog((snapshot) => snapshot)
  assert.equal(log.available, false)
  assert.match(log.error, /network down/)
  assert.notEqual(card.component(props), null)
})

test('a host that answers with a failure envelope is reported, not rendered as data', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ ok: false, error: { code: 'notify/internal', message: 'settings exploded', details: {} } })
  try {
    const { card, props } = mount(undefined, { transport: { calls: [], restore: () => {} } })
    await props.refreshLog()
    assert.match(props.useNotifyLog((snapshot) => snapshot).error, /settings exploded/)
    assert.notEqual(card.component(props), null)
  } finally {
    globalThis.fetch = original
  }
})

test('both dictionaries carry the same keys', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'))
  const keys = (locale) => {
    const opening = source.indexOf(`      ${locale}: {`)
    assert.ok(opening > 0, `the ${locale} dictionary is not shaped as the scan expects`)
    const start = source.indexOf('\n', opening) + 1
    const end = source.indexOf('\n      },', start)
    assert.ok(end > start, `the ${locale} dictionary is not shaped as the scan expects`)
    return [...source.slice(start, end).matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort()
  }
  const zh = keys('zh')
  const en = keys('en')
  assert.ok(zh.length > 40, `the dictionary scan found only ${zh.length} keys`)
  assert.deepEqual(zh, en, 'every key needs both languages')
  for (const key of ['cardTitle', 'save', 'discard', 'groupMailbox', 'fieldUser', 'fieldPass', 'fieldTo', 'logTitle', 'logTest', 'logUnavailable']) {
    assert.ok(zh.includes(key), `missing dictionary key ${key}`)
  }
})

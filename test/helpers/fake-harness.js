/**
 * A minimal stand-in for the Cordis plugin context.
 *
 * It records event subscriptions, tool registrations, and disposers exactly as
 * far as this plugin uses them, so `apply()` can be driven end to end in a
 * plain Node test: subscribe the fake harness to the plugin, emit synthetic
 * harness events, and observe the alerts that come out.
 *
 * @module dsh-notify-long/test/helpers/fake-harness
 */

/**
 * @typedef {object} FakeHarnessOptions
 * @property {Record<string, any>} [services] - services `ctx.get(name)` should return
 * @property {string} [entryId] - the Loader entry id the plugin's fiber carries
 * @property {string} [profileHome] - the harness home exposed as `ctx.profileContext.home`
 */

/**
 * Build a fake context plus the driver functions a test needs.
 *
 * @param {FakeHarnessOptions} [options] - harness options
 * @returns {any} the harness
 */
export function createFakeHarness(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {any[]} */
  const tools = []
  /** @type {Function[]} */
  const disposers = []
  const logs = []
  const settingsSections = []
  /** Waits registered by `ctx.inject` whose services have not appeared yet. */
  const pendingInjects = []
  let services = { ...(options.services ?? {}) }

  /** Run every wait whose dependencies are now satisfied. */
  function reconcileInjects() {
    for (const record of [...pendingInjects]) {
      if (!record.deps.every((name) => services[name] !== undefined)) continue
      pendingInjects.splice(pendingInjects.indexOf(record), 1)
      record.callback(serviceContext())
    }
  }

  /**
   * A context carrying the resolved services as properties, the way Cordis
   * exposes them (`ctx.settings`, `ctx.agents`, …) on top of the accessors this
   * fake already provides.
   *
   * @returns {any} the derived context
   */
  function serviceContext() {
    const derived = Object.create(ctx)
    for (const [name, service] of Object.entries(services)) derived[name] = service
    return derived
  }

  const ctx = {
    // The Loader fiber the plugin runs in. The settings integration reads the
    // entry id off it to claim the page policy and to filter
    // `settings/document-updated` to this plugin's own form.
    fiber: { entry: { id: options.entryId ?? 'dsh-notify-long' } },
    ...options.profileHome === undefined ? {} : { profileContext: { home: options.profileHome } },
    logger: {
      info: (format, ...args) => logs.push({ level: 'info', message: `${format} ${args.join(' ')}`.trim() }),
      warn: (format, ...args) => logs.push({ level: 'warn', message: `${format} ${args.join(' ')}`.trim() }),
    },
    get(name) {
      return services[name]
    },
    /**
     * Cordis's dependency wait: run the callback now when every service is
     * already there, otherwise park it until `provide` supplies the last one.
     * A plugin that reads a service once instead of waiting is exactly the bug
     * this fake exists to catch.
     *
     * @param {string[]} deps - required service names
     * @param {Function} callback - runs with a context once they all exist
     * @returns {Function} cancels the wait
     */
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined)) {
        callback(serviceContext())
        return () => {}
      }
      const record = { deps, callback }
      pendingInjects.push(record)
      return () => {
        const index = pendingInjects.indexOf(record)
        if (index >= 0) pendingInjects.splice(index, 1)
      }
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    effect(callback) {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }

  return {
    ctx,
    settingsSections,
    tools,
    logs,
    listeners,
    /**
     * Publish a service after mount, releasing any `ctx.inject` wait on it.
     *
     * @param {string} name - service name
     * @param {any} service - the service instance
     * @returns {void}
     */
    provide(name, service) {
      services = { ...services, [name]: service }
      reconcileInjects()
    },
    /** @returns {number} how many dependency waits are still parked */
    pendingInjectCount() {
      return pendingInjects.length
    },
    /** @param {any} config - composition entry @returns {Promise<any>} the plugin module */
    async mount(config = {}) {
      const module = await import('../../src/index.js')
      await module.apply(ctx, config)
      return module
    },
    /**
     * Emit one harness event to the subscribed listeners, awaiting every result.
     *
     * @param {string} event - event name
     * @param {...any} args - event arguments
     * @returns {Promise<any[]>} the listener results
     */
    async emit(event, ...args) {
      const list = listeners.get(event) ?? []
      const results = []
      for (const listener of list) {
        // Waterfall listeners receive a `next` continuation; everything else
        // receives the raw payload.
        const next = () => Promise.resolve(undefined)
        results.push(await listener(...args, next))
      }
      return results
    },
    /** @param {string} name - event name @returns {number} how many listeners are subscribed */
    count(event) {
      return (listeners.get(event) ?? []).length
    },
    /** @param {string} name - tool name @returns {any} the registered tool, when present */
    tool(name) {
      return tools.find((entry) => entry.name === name)
    },
    /** @returns {string[]} the names of every registered tool */
    toolNames() {
      return tools.map((entry) => entry.name)
    },
    /** @returns {string[]} one line per log entry */
    logLines() {
      return logs.map((entry) => `${entry.level}: ${entry.message}`)
    },
  }
}

/**
 * A settings stub that behaves like the 0.2 `ctx.settings` service, as far as
 * this plugin touches it: the plugin no longer installs a namespace, it claims
 * its own page policy on the fiber it runs in.
 *
 * @returns {any} the settings stub
 */
export function createFakeSettings() {
  /** @type {any[]} */
  const configurations = []
  return {
    writable: true,
    /**
     * Register the calling plugin instance's page policy.
     *
     * @param {any} presentation - the policy
     * @param {any} owner - the fiber the policy belongs to
     * @returns {Function} the disposer
     */
    configure(presentation, owner) {
      // The real service throws for a second policy on one instance; a stub
      // that silently accepted it would hide exactly the plugin bug this is
      // here to catch.
      if (configurations.some((entry) => entry.owner === owner)) {
        throw new Error('Settings presentation is already configured for this plugin instance')
      }
      const record = { presentation, owner }
      configurations.push(record)
      return () => {
        const index = configurations.indexOf(record)
        if (index >= 0) configurations.splice(index, 1)
      }
    },
    /** @returns {any[]} the registered page policies, in order */
    configurations() {
      return configurations
    },
  }
}

/**
 * Build a composition entry whose editable fields are live references.
 *
 * This is what the Loader hands `apply` once a Config schema marks fields
 * `.volatile()`: the value is not on the row, the reference is, and a save
 * rewrites the reference in place. `set()` is therefore a faithful stand-in for
 * one settings save: it writes through the reference the plugin already holds,
 * so a test observes the same thing a running harness would.
 *
 * Arrays and scalars become one reference each; plain objects are descended
 * into, because the plugin's real schema marks leaves rather than sections.
 *
 * @param {Record<string, any>} [values] - the entry's initial values
 * @returns {any} `{ config, set, refs }`
 */
export function createFakeConfig(values = {}) {
  const write = Symbol.for('cosmokit.volatile.write')
  /** @type {Map<string, any>} */
  const refs = new Map()

  /** @param {any} value - a config node @param {string[]} path - its key path @returns {any} the node with references at its leaves */
  function wrap(value, path) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, wrap(child, [...path, key])]))
    }
    let current = value
    const ref = Object.freeze({
      get: () => current,
      [write]: (next) => { current = next },
    })
    refs.set(path.join('.'), ref)
    return ref
  }

  const config = wrap(values, [])
  return {
    config,
    /** @param {string[]} path - the field to write @param {any} value - its new value @returns {void} */
    set(path, value) {
      const key = path.join('.')
      const ref = refs.get(key)
      if (ref === undefined) throw new Error(`no volatile field at ${key}`)
      ref[write](value)
    },
    /** @returns {string[]} the key paths that are references */
    paths() {
      return [...refs.keys()]
    },
  }
}

/**
 * A Connection stub that behaves like the host registry the settings card talks
 * to: it records the exact Fetch routes a plugin publishes and lets a test post
 * one endpoint the way the browser half does.
 *
 * The real service owns authentication and the HTTP carrier; both are outside
 * this plugin's contract, so the stub keeps only the part that is: a route path,
 * a decoded endpoint, and the JSON envelope the plugin answers with.
 *
 * @returns {any} the connection stub
 */
export function createFakeConnection() {
  /** @type {Map<string, any>} */
  const routes = new Map()
  return {
    fetch: {
      /**
       * Register one exact Fetch route, as `HostConnectionFetch.register` does.
       *
       * @param {any} route - the route object
       * @returns {Function} the disposer
       */
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
        }
      },
    },
    /** @returns {string[]} the registered route paths */
    paths() {
      return [...routes.keys()]
    },
    /**
     * Post one endpoint to a registered route, exactly as the card does.
     *
     * @param {string} endpoint - the endpoint name
     * @param {any} payload - the JSON payload
     * @returns {Promise<any>} the decoded response envelope
     */
    async call(endpoint, payload) {
      const [path, route] = [...routes.entries()][0] ?? []
      if (route === undefined) throw new Error('no settings-card route is registered')
      const response = await route.fetch(new Request(`http://dsh.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload: payload ?? {} }),
      }))
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      return response.json()
    },
  }
}

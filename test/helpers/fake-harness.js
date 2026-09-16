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
 * @property {any} [entry] - composition entry handed to `apply`
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
 * A settings stub that behaves like `ctx.settings.installSection`: it keeps the
 * base entry and applies patches the way the real service would.
 *
 * @param {object} [options] - stub options
 * @param {any} [options.user] - initial user layer
 * @returns {any} the settings stub
 */export function createFakeSettings(options = {}) {
  let source = () => undefined
  let user = options.user
  let hooked
  return {
    writable: true,
    installSection(_owner, namespace, _schema, base, hooks) {
      if (namespace !== 'dsh-notify-long') throw new Error(`unexpected namespace ${namespace}`)
      hooked = hooks
      source = () => ({ ...base, ...user })
      hooks.setSource(source)
    },
    get() {
      return source()
    },
    /** Apply a user-layer patch, as `settings.update` would. */
    patch(next) {
      user = { ...user, ...next }
      source = () => ({ ...(hooked === undefined ? {} : {}), ...next })
      hooked?.setSource(() => ({ ...next }))
      hooked?.onChange()
    },
    /** @returns {any} the raw hooks the plugin registered */
    hooks() {
      return hooked
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

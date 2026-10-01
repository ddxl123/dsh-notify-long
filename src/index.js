/**
 * dsh-notify-long — DeepSeek Harness notification plugin.
 *
 * A subscribe-side Cordis plugin: it watches the harness for the moments that
 * need a human (a finished task, a failure, a retried model request, a question,
 * an approval) and alerts the operator over system sound, a desktop banner, and
 * email — with a durable outbox so an alert survives a reload or a temporary
 * delivery failure.
 *
 * Everything decision-shaped lives in `lib/`; this file only reads services,
 * subscribes to events, and registers the model-facing `notify_*` tools.
 *
 * @module dsh-notify-long
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { deepMerge, describeError, resolveVolatile, sanitizeLine } from '../lib/util.js'
import { activeChannels, Guard } from '../lib/core/policy.js'
import { ActivityLog } from '../lib/core/activity.js'
import { Outbox } from '../lib/core/queue.js'
import { Engine } from '../lib/core/engine.js'
import { Tracker } from '../lib/core/detect.js'
import { playSound } from '../lib/channels/sound.js'
import { showDesktop } from '../lib/channels/desktop.js'
import { describeEmail, emailReady, sendEmail } from '../lib/channels/email.js'
import { createRuntime } from '../lib/runtime/handlers.js'
import { API_PATH, createNotifyRoute } from '../lib/runtime/api.js'
import { runSelfTest } from '../lib/runtime/selftest.js'

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'dsh-notify-long'

/** Services this plugin consumes; the plugin waits until they all exist. */
export const inject = ['agents', 'tools']

/**
 * Composition entry schema.
 *
 * Cordis validates a row's `config` with `Config['~standard'].validate(...)`
 * *before* `apply` runs, so `Config` must be a Standard Schema. `Schema` is
 * `@deepseek-ai/schemastery`, a package shipped with dsh: the launcher's profile
 * resolution serves it from the running installation to every profile plugin,
 * including one linked from outside the profile — a plugin declares the shipped
 * packages it imports in `peerDependencies` and Node's lookup for that name is
 * routed to the installation's own copy. That is also why this module imports
 * its peers statically and unmapped: an install that cannot resolve them is a
 * broken install, and a broken row is reported instead of silently degraded.
 */
export const Config = buildConfigSchema(Schema)

/**
 * Build the schemastery configuration schema. The harness validates a row's
 * `config` against this schema before `apply` runs, which is where the
 * documented defaults come from.
 *
 * @param {any} z - the schemastery module
 * @returns {any} the schema
 */
function buildConfigSchema(z) {
  const channel = z.union(['sound', 'desktop', 'email'])
  return z.object({
    // `.volatile()` marks the fields the Settings card may edit while the
    // harness runs. It *is* the registration: the Loader hands `apply` a live
    // reference instead of a value for each one, `@deepseek-ai/dsh-settings`
    // serves a form for exactly the entries that have at least one, and a write
    // through that form rewrites the reference in place — no remount, no
    // restart. Everything left unmarked (cooldowns, the outbox path, the tools
    // switch, `debug`) is ordinary composition configuration: readable here,
    // changeable only by editing the profile.
    enabled: z.boolean().default(true).volatile(),
    // The language of every alert a human reads. `auto` follows the operating
    // system (Intl / LANG); an unset value means English, so a library caller
    // never gets machine-dependent output.
    language: z.union(['auto', 'en', 'zh']).default('auto').volatile(),
    sound: z.object({
      enabled: z.boolean().default(true),
      file: z.string(),
      player: z.string(),
      perKind: z.dict(z.string()),
      timeoutMs: z.natural().default(10_000),
    }),
    desktop: z.object({
      enabled: z.boolean().default(true),
      titlePrefix: z.string(),
      sound: z.string(),
    }),
    email: z.object({
      enabled: z.boolean().default(true).volatile(),
      preset: z.union(['qq', 'qq-exmail', '163', '163-enterprise', 'aliyun', 'gmail', 'outlook', 'office365', 'icloud', 'zoho', 'yahoo', 'sendgrid', 'mailgun', 'resend', 'brevo']).volatile(),
      host: z.string().volatile(),
      port: z.natural().default(465).volatile(),
      tls: z.union(['implicit', 'starttls', 'plain']).volatile(),
      user: z.string().volatile(),
      pass: z.string().role('secret').volatile(),
      passEnv: z.string().default('DSH_SMTP_PASSWORD').volatile(),
      passCommand: z.string().volatile(),
      from: z.string().volatile(),
      to: z.union([z.string(), z.array(z.string())]).default([]).volatile(),
      cc: z.union([z.string(), z.array(z.string())]).default([]).volatile(),
      subjectPrefix: z.string().default('[DSH]').volatile(),
      html: z.boolean().default(true),
      requireTls: z.boolean().default(true).volatile(),
      verifyCert: z.boolean().default(true).volatile(),
      preferPlain: z.boolean().default(true),
      allowPortFallback: z.boolean().default(true),
      heloName: z.string(),
      timeoutMs: z.natural().default(20_000),
    }),
    quietHours: z.object({
      start: z.string(),
      end: z.string(),
    }),
    // How long a running turn may stay silent before the stall alert fires.
    // Composition configuration rather than a card field: it is a policy about
    // the harness, not something an operator retunes per alert.
    stallAfterMs: z.natural().default(600_000),
    alerts: z.object({
      channels: z.array(channel).default(['sound', 'desktop', 'email']).volatile(),
      dedupeWindowMs: z.natural().default(300_000),
      errorCooldownMs: z.natural().default(600_000),
      channelCooldownMs: z.natural().default(15_000),
      kinds: z.dict(z.object({
        enabled: z.boolean().default(true),
        channels: z.array(channel),
      })),
    }),
    outbox: z.object({
      path: z.string(),
      flushOnStart: z.boolean().default(true),
    }),
    tools: z.object({
      enabled: z.boolean().default(true),
    }),
    log: z.object({
      delivered: z.boolean().default(true),
      failures: z.boolean().default(true),
    }),
    debug: z.boolean().default(false),
  })
}

/**
 * Apply the documented defaults to a raw configuration. Used when schemastery
 * is unavailable, and to make every nested section present for direct readers.
 *
 * @param {any} value - raw configuration
 * @returns {any} the configuration with defaults filled in
 */
export function defaultsFor(value) {
  return deepMerge({
    enabled: true,
    language: 'auto',
    sound: { enabled: true, perKind: {}, timeoutMs: 10_000 },
    desktop: { enabled: true },
    email: {
      enabled: true,
      port: 465,
      passEnv: 'DSH_SMTP_PASSWORD',
      to: [],
      cc: [],
      subjectPrefix: '[DSH]',
      html: true,
      requireTls: true,
      verifyCert: true,
      preferPlain: true,
      allowPortFallback: true,
      timeoutMs: 20_000,
    },
    quietHours: {},
    stallAfterMs: 600_000,
    alerts: {
      channels: ['sound', 'desktop', 'email'],
      dedupeWindowMs: 300_000,
      errorCooldownMs: 600_000,
      channelCooldownMs: 15_000,
      kinds: {},
    },
    outbox: { flushOnStart: true },
    tools: { enabled: true },
    log: { delivered: true, failures: true },
    debug: false,
  }, value)
}

/**
 * Resolve the directory holding this plugin's durable state.
 *
 * `ctx.profileContext.home` is present in every profile `dsh` launches. The
 * environment fallback covers a composition booted without a profile at all, and
 * resolves to the same place, so an upgraded deployment keeps reading the outbox
 * and the activity log it already wrote rather than starting empty beside them.
 *
 * @param {any} ctx - the plugin context
 * @returns {string} `<harness home>/dsh-notify-long`
 */
export function stateDirectory(ctx) {
  const profileHome = ctx?.profileContext?.home
  if (typeof profileHome === 'string' && profileHome !== '') return join(profileHome, 'dsh-notify-long')
  const home = sanitizeLine(process.env.DSH_HOME ?? '') || join(sanitizeLine(process.env.HOME ?? '') || '.', '.dsh')
  return join(home, 'dsh-notify-long')
}

/**
 * Register the plugin.
 *
 * @param {any} ctx - the loader-provided plugin context
 * @param {any} rawConfig - the validated composition entry
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const entry = defaultsFor(resolveVolatile(rawConfig))
  const debug = entry.debug === true

  const stateDir = stateDirectory(ctx)
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (error) {
    console.warn(`[dsh-notify-long] could not create the state directory ${stateDir} (${describeError(error)})`)
  }

  // The activity log is created before the logger because the logger mirrors
  // every line into it; its own persistence errors therefore go to the console
  // through `log.raw`, which never re-enters the log and cannot recurse.
  const activity = new ActivityLog({
    path: join(stateDir, 'activity.json'),
    onError: (message) => { console.warn(`[dsh-notify-long] ${message}`) },
  })
  const restoredActivity = activity.load()
  const log = createLogger(ctx, entry, debug, activity)
  activity.onError = (message) => { log.raw('warn', message) }

  /** Holds the engine for callbacks that are wired before it exists. */
  const engineHolder = { current: undefined }

  /**
   * The effective configuration, re-read on every use.
   *
   * The volatile fields arrive as live references, so resolving them each time
   * is what makes a Settings save take effect without a restart — the job
   * `installSection`'s `setSource` hook did before the 0.2 settings rework,
   * which removed that API altogether. `rawConfig` is the object the Loader
   * keeps for this entry and rewrites in place, so holding on to it is holding
   * on to the live document.
   */
  const settingsNow = () => defaultsFor(resolveVolatile(rawConfig))

  // 0.2 turned the settings integration around: a plugin no longer installs a
  // namespace for the harness's generic page. Marking fields `.volatile()` in
  // the Config schema is what makes `@deepseek-ai/dsh-settings` serve this
  // entry at all, and `configure({ auto: false })` says the page this plugin
  // ships itself is the only one to render — without it the harness would also
  // offer a schema-generated page for the same entry. The call is still worth
  // making from an `inject` child: Settings settles after this plugin activates,
  // and the child names the fiber the policy belongs to.
  const entryId = ctx.fiber?.entry?.id
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.effect(
        () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
        'dsh-notify-long: own settings page',
      )
    } catch (error) {
      log.warn(`could not claim this plugin's settings page; the harness may also render its generated one (${describeError(error)})`)
    }
  })

  // A saved form changes the references above, so the cooldowns that key off
  // the previous settings have to be dropped. `document-updated` also fires
  // when the form first appears, and a "settings changed" line at every boot
  // would be noise in the card's log; only a later change is news.
  let announced = false
  try {
    ctx.on('settings/document-updated', (ns) => {
      if (entryId !== undefined && String(ns) !== String(entryId)) return
      if (announced) {
        log.debug('notification settings changed')
        activity.append({ level: 'info', event: 'settings', message: 'notification settings changed' })
      }
      announced = true
      engineHolder.current?.guard.reset()
    })
  } catch (error) {
    log.warn(`could not watch for settings changes; new values still apply (${describeError(error)})`)
  }

  const outbox = new Outbox({
    path: sanitizeLine(settingsNow().outbox?.path ?? '') || join(stateDir, 'outbox.json'),
    onError: (message) => log.warn(message),
  })
  const guard = new Guard({
    dedupeWindowMs: settingsNow().alerts?.dedupeWindowMs,
    cooldownMs: settingsNow().alerts?.errorCooldownMs,
    channelCooldownMs: settingsNow().alerts?.channelCooldownMs,
  })
  const emailConfigured = () => emailReady(settingsNow())
  const engine = new Engine({
    outbox,
    guard,
    settings: settingsNow,
    activity,
    emailReady: emailConfigured,
    playSound: (input) => (settingsNow().sound?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'sound is disabled in settings' })
      : playSound(input)),
    showDesktop: (input) => (settingsNow().desktop?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'desktop notifications are disabled in settings' })
      : showDesktop(input)),
    sendEmail: (input) => (settingsNow().email?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'email is disabled in settings' })
      : sendEmail(input)),
    // The engine already writes a structured activity entry for every outcome,
    // so its free-form lines stay in the harness console instead of doubling up
    // in the card's log.
    log: (message) => log.raw('warn', message),
  })
  engineHolder.current = engine

  const tracker = new Tracker()
  const runtime = createRuntime({
    tracker,
    engine,
    settings: settingsNow,
    log: (message) => log.raw('warn', message),
  })
  ctx.on('dispose', () => runtime.dispose())

  // The settings card's live half: status, activity log, test alert and outbox
  // retry over one exact Fetch route on Connection's `/api` channel. `connection`
  // is optional — a headless deployment has no browser to serve, and the card is
  // simply configuration only there — so it is waited for rather than declared
  // as a hard dependency.
  //
  // The route is registered through `connection.fetch` rather than
  // `connection.rpc.handle`, for the reason spelled out in lib/runtime/api.js:
  // the RPC registry mounts a channel with the *provider's* fiber, where
  // `webServer` is not visible, so `handle()` throws `cannot get property
  // "webServer" without inject` from any consumer plugin. The exact Fetch
  // registry adds the route to a channel Connection already mounted.
  const route = createNotifyRoute({
    activity,
    outbox,
    engine,
    settings: settingsNow,
    emailReady: emailConfigured,
    log: (message) => log.warn(message),
  })
  ctx.inject(['connection'], (connectionCtx) => {
    try {
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register(route),
        'dsh-notify-long: settings-card route',
      )
      log.debug(`settings-card endpoint published on ${API_PATH}`)
    } catch (error) {
      log.warn(`could not publish the settings-card endpoint; the card will show configuration only (${describeError(error)})`)
    }
  })

  // Background jobs: the jobs registry publishes one `settled` event per job, so
  // a failed job needs no polling. Only failures alert (see the runtime), and
  // `jobs` is optional — a composition without the registry has no background
  // work to report rather than a missing capability.
  ctx.inject(['jobs'], (jobsCtx) => {
    try {
      const off = jobsCtx.jobs.events.subscribe({ owners: 'all' }, (event) => runtime.jobSettled(event))
      jobsCtx.effect(() => off, 'dsh-notify-long: background job watcher')
      log.debug('watching background jobs for failures')
    } catch (error) {
      log.warn(`could not watch background jobs; a failed job will not alert (${describeError(error)})`)
    }
  })

  // Each subscription group is guarded independently: if one harness event
  // disappears in a future release, only that capability goes quiet instead of
  // the whole composition failing to load.
  subscribe(ctx, log, 'session lifecycle', () => {
    ctx.on('session/created', (session) => {
      const header = session?.header ?? {}
      runtime.noteSession({
        sessionId: String(session?.id ?? ''),
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
      })
    })
    ctx.on('agent/created', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId !== '') runtime.noteSession({ sessionId })
    })
  })

  subscribe(ctx, log, 'session events', () => {
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return
      runtime.sessionEvent(sessionId, String(event?.type ?? ''), event?.data)
    })
  })

  subscribe(ctx, log, 'agent status', () => {
    ctx.on('agent/status', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.status({ sessionId, status: payload?.status === 'running' ? 'running' : 'idle' })
    })
    ctx.on('api-session/status', (sessionId, running) => {
      runtime.status({ sessionId: String(sessionId ?? ''), running: running === true })
    })
  })

  subscribe(ctx, log, 'agent errors', () => {
    ctx.on('agent/error', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.error({
        sessionId,
        error: payload?.error,
        stage: payload?.step === undefined ? 'turn' : 'step',
        turn: payload?.turn,
        step: payload?.step,
      })
    })
    ctx.on('api-session/error', (sessionId, message) => {
      if (String(sessionId ?? '') === '') return
      runtime.error({ sessionId: String(sessionId), error: message, stage: 'session' })
    })
  })

  subscribe(ctx, log, 'tool results', () => {
    ctx.on('tools/result', (exec, result) => {
      const sessionId = String(exec?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.toolResult({ sessionId, toolName: String(exec?.name ?? ''), result })
    })
  })

  // Both of these are Cordis *waterfall* events: the first listener that returns
  // an answer claims the request and the rest of the chain never runs. The
  // browser UI is one such answerer, and after a live plugin reload it can
  // already be registered — so the observer is registered with `prepend`, which
  // puts it ahead of every answerer and makes "the operator is told" independent
  // of who else is listening. It always delegates with `next()`, so the request
  // is never consumed here.
  subscribe(ctx, log, 'user questions', () => {
    ctx.on('user-questions/request', (request, next) => {
      runtime.question({ sessionId: sessionOf(request), request })
      return next()
    }, { prepend: true })
  })

  subscribe(ctx, log, 'approval requests', () => {
    ctx.on('approval/request', (request, next) => {
      runtime.approval({ sessionId: sessionOf(request), request })
      return next()
    }, { prepend: true })
  })

  // Account state: both of these mean the model route is dead until a human
  // acts, and neither is reachable through a turn's own error path — the turn
  // may not even be running when the credential goes.
  subscribe(ctx, log, 'account state', () => {
    ctx.on('deepseek-account/model-sign-in-required', () => runtime.account({ reason: 'sign-in-required' }))
    ctx.on('deepseek-account/session-expired', () => runtime.account({ reason: 'session-expired' }))
    ctx.on('authorization/settled', (key, settlement) => runtime.authorizationSettled({ key, settlement }))
  })

  subscribe(ctx, log, 'goal changes', () => {
    ctx.on('goal/changed', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      runtime.goalChanged({ ...sessionId === '' ? {} : { sessionId }, change: payload?.change })
    })
  })

  subscribe(ctx, log, 'workflow runs', () => {
    ctx.on('workflow/end', (info, result) => runtime.workflowEnd({ info, result }))
  })

  // Stream frames are the finest-grained sign of life a running turn produces,
  // and the stall watchdog needs exactly that.
  subscribe(ctx, log, 'assistant stream', () => {
    ctx.on('agent/assistant-stream', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId !== '') runtime.activity({ sessionId })
    })
  })

  subscribe(ctx, log, 'subagent completions', () => {
    ctx.on('subagent/end', (info) => {
      const sessionId = String(info?.id ?? '')
      if (sessionId !== '') runtime.subagentEnd({ sessionId, info })
    })
  })

  if (entry.tools?.enabled !== false) {
    registerTools(ctx, { engine, tracker, outbox, activity, settingsNow, emailConfigured, log })
  }

  const restored = outbox.load()
  log.debug(`state directory ${stateDir}; ${restored.loaded} queued alert(s) restored, ${restored.dropped} stale record(s) dropped`)
  activity.append({
    level: 'info',
    event: 'start',
    message: `dsh-notify-long started: ${restored.loaded} queued alert(s) restored, ${restoredActivity.loaded} log entr(ies) kept`,
  })
  if (outbox.size > 0) {
    engine.drain().then((summary) => {
      if (summary.delivered > 0 || summary.failed > 0) {
        log.info(`alert outbox flushed: ${summary.delivered} delivered, ${summary.failed} deferred, ${summary.dropped} dropped`)
      }
    }).catch((error) => log.warn(`could not flush the alert outbox (${describeError(error)})`))
  }
}

/**
 * The session a request belongs to, when it named a live agent.
 *
 * `user-questions/request` declares its `agent` optional, so this returns
 * `undefined` rather than an empty string: an unattributed question still has to
 * alert, and an empty string would look like a session id everywhere downstream.
 *
 * @param {any} request - a question or approval request
 * @returns {string | undefined} the owning session id
 */
function sessionOf(request) {
  const id = request?.agent?.id
  return id === undefined || id === null || String(id) === '' ? undefined : String(id)
}

/**
 * Run one subscription group, reporting — but never propagating — a failure.
 *
 * @param {any} ctx - the plugin context
 * @param {{ warn: Function }} log - the logger
 * @param {string} label - what is being subscribed
 * @param {() => void} register - the subscriptions
 * @returns {void}
 */
function subscribe(ctx, log, label, register) {
  try {
    register()
  } catch (error) {
    log.warn(`could not subscribe to ${label}; that capability is inactive (${describeError(error)})`)
  }
}

/**
 * Register the model-facing `notify_*` tools.
 *
 * `ctx.tools.register` owns the registration on this plugin's context, so
 * unloading the plugin (or a profile patch that disables it) removes the tools
 * with it — the same shape every shipped tool plugin uses.
 *
 * @param {any} ctx - the plugin context
 * @param {object} deps - tool dependencies
 * @returns {void}
 */
function registerTools(ctx, deps) {
  for (const tool of [
    defineNotifyTool(deps),
    defineTestTool(deps),
    defineStatusTool(deps),
    defineFlushTool(deps),
  ]) {
    ctx.tools.register(tool)
  }
}

/**
 * The `notify_user` tool: an explicit, model-initiated alert.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineNotifyTool(deps) {
  const { engine, tracker } = deps
  return defineTool({
    name: 'notify_user',
    description: [
      'Send the operator an out-of-band notification (system sound, desktop banner, email) without ending the turn.',
      'Use it when a long unattended job finishes, when you are about to wait on something, or when the operator asked to be told.',
      'urgency "action" means a human must act before work can continue; "error" marks a failure.',
      'Do not use it for routine progress narration: the harness already alerts on finished turns, failures, model-request retries, questions and approvals.',
    ].join(' '),
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'One short line describing the alert, for example "Nightly build finished".',
      },
      message: {
        type: 'string',
        description: 'Body of the alert: what happened and what the operator should do next.',
      },
      urgency: {
        type: 'string',
        enum: ['info', 'action', 'error'],
        description: 'info (default) for a notice, action when a human must act, error for a failure.',
      },
      sound: {
        type: 'string',
        description: 'Optional sound override for this alert: a macOS system sound name, or a path to an audio file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          channels: { type: 'array', required: true, items: { type: 'string' } },
          failures: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `Alert delivered over: ${value.channels.join(', ') || 'none'}.`
          : `Alert not delivered${value.failures.length === 0 ? '' : `: ${value.failures.join('; ')}`}.`,
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id === undefined ? undefined : String(exec.agent.id)
      const urgency = args.urgency === 'action' || args.urgency === 'error' ? args.urgency : 'info'
      const facts = sessionId === undefined ? undefined : tracker.factsOf(sessionId)
      const sound = sanitizeLine(args.sound ?? '')
      const outcome = await engine.raise({
        kind: urgency === 'action' ? 'question' : urgency === 'error' ? 'error' : 'manual',
        title: sanitizeLine(args.title) || 'Notification from the agent',
        body: sanitizeLine(args.message ?? ''),
        sessionId,
        sessionTitle: facts?.title,
        cwd: facts?.cwd,
        urgency,
        fingerprint: `manual:${sanitizeLine(args.title)}`,
        ...sound === '' ? {} : { sound },
      })
      return {
        delivered: outcome.delivered === true,
        channels: outcome.channels,
        failures: outcome.failures,
        ...outcome.skipped === undefined ? {} : { note: outcome.skipped },
        ...outcome.queued === true
          ? { note: `delivery failed (${outcome.failures.join('; ')}); the alert is queued in the durable outbox and will be retried` }
          : {},
      }
    },
  })
}

/**
 * The `notify_test` tool: deliver a test alert over the requested channels and
 * report exactly what worked, so the operator can verify their setup.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineTestTool(deps) {
  const { engine, settingsNow, emailConfigured, outbox } = deps
  return defineTool({
    name: 'notify_test',
    description: 'Send a test notification over the configured channels (system sound, desktop banner, email) and report which ones worked. Use it to verify or debug the operator\'s alert setup.',
    parameters: {
      channel: {
        type: 'string',
        enum: ['all', 'sound', 'desktop', 'email'],
        description: 'Which channel to exercise; defaults to all configured channels.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sound: { type: 'string', required: true },
          desktop: { type: 'string', required: true },
          email: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.ok ? 'Test alert sent.' : 'Test alert could not be sent.',
          `sound: ${value.sound}`,
          `desktop: ${value.desktop}`,
          `email: ${value.email}`,
          ...value.note === undefined ? [] : [value.note],
        ].join('\n'),
      }],
    },
    async execute(args) {
      const settings = settingsNow()
      const requested = args?.channel ?? 'all'
      const results = await runSelfTest({
        engine,
        settings,
        emailReady: emailConfigured() === true,
        channel: requested,
      })
      const lines = ['sound', 'desktop', 'email']
        .filter((channel) => results[channel] !== 'not requested')
        .map((channel) => `${channel}: ${results[channel]}`)
      deps.activity?.append({
        level: results.ok ? 'info' : 'warn',
        event: 'test',
        message: `test alert (${requested}) — ${lines.join('; ') || 'nothing requested'}`,
      })
      return {
        ...results,
        ...outbox.size === 0 ? {} : { note: `${outbox.size} alert(s) are still queued for delivery` },
      }
    },
  })
}

/**
 * The `notify_status` tool: report channel readiness and queue state.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineStatusTool(deps) {
  const { engine, settingsNow, outbox, activity } = deps
  return defineTool({
    name: 'notify_status',
    description: 'Report the operator notification setup: which channels are active, whether email is configured, quiet hours, how many alerts are queued, and the most recent delivery results. Secrets are never included.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          channels: { type: 'array', required: true, items: { type: 'string' } },
          quiet: { type: 'string', required: true },
          queued: { type: 'integer', required: true },
          delivered: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          email: { type: 'string', required: true },
          lastFailure: { type: 'string' },
          recent: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `notifications: ${value.enabled ? 'enabled' : 'disabled'}; channels: ${value.channels.join(', ') || 'none'}`,
          `email: ${value.email}`,
          `quiet hours: ${value.quiet}`,
          `queued: ${value.queued}; delivered this run: ${value.delivered}; failed: ${value.failed}`,
          ...value.lastFailure === undefined ? [] : [`last failure: ${value.lastFailure}`],
          ...value.recent === undefined ? [] : ['recent activity:', ...value.recent.map((line) => `  ${line}`)],
        ].join('\n'),
      }],
    },
    async execute() {
      const settings = settingsNow()
      const status = engine.status()
      const email = describeEmail(settings)
      const recent = activity?.entries({ limit: 5 }).map((entry) => `${new Date(entry.at).toLocaleString()} ${entry.level}: ${entry.message}`) ?? []
      return {
        enabled: status.enabled,
        channels: activeChannels(settings, email.ready),
        quiet: status.quiet.configured
          ? `${status.quiet.range[0]}–${status.quiet.range[1]}${status.quiet.active ? ' (active now: sound and desktop muted, email still sent)' : ''}`
          : 'not configured',
        queued: outbox.size,
        delivered: status.delivered,
        failed: status.failed,
        email: email.summary,
        ...status.lastFailure === undefined ? {} : { lastFailure: status.lastFailure },
        ...recent.length === 0 ? {} : { recent },
      }
    },
  })
}

/**
 * The `notify_flush` tool: retry everything the outbox is holding.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineFlushTool(deps) {
  const { engine, outbox } = deps
  return defineTool({
    name: 'notify_flush',
    description: 'Retry every notification still waiting in the durable outbox (for example after fixing the email password) and report the outcome.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'integer', required: true },
          delivered: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Outbox flushed: ${value.delivered} delivered, ${value.failed} deferred, ${value.dropped} dropped (${value.queued} had been queued).`,
      }],
    },
    async execute() {
      const queued = outbox.size
      outbox.retryAll()
      const summary = await engine.drain()
      return { queued, ...summary }
    },
  })
}

/**
 * Build the plugin logger.
 *
 * Every line this logger emits is mirrored into the activity log, so the log
 * panel in Settings → Plugins shows what the harness console shows. `raw` is the
 * escape hatch: it writes to the console only, for callers that already recorded
 * a structured entry (the engine) or that are reporting a failure *of* the
 * activity log itself — mirroring those would double up, or recurse.
 *
 * @param {any} ctx - the plugin context
 * @param {any} config - the composition entry
 * @param {boolean} debug - whether debug logging is on
 * @param {any} [activity] - the activity log to mirror into
 * @returns {{ info: Function, warn: Function, error: Function, debug: Function, raw: Function }} the logger
 */
function createLogger(ctx, config, debug, activity) {
  const logger = ctx.logger ?? ctx.get?.('logger')
  const quiet = config.log?.delivered === false
  const write = (level, message) => {
    try {
      if (logger !== undefined && typeof logger[level] === 'function') logger[level]('[dsh-notify-long] %s', message)
      else if (level === 'warn' || level === 'error') console.warn(`[dsh-notify-long] ${message}`)
      else console.log(`[dsh-notify-long] ${message}`)
    } catch {
      // Logging must never be the reason an alert fails.
    }
  }
  const emit = (level, message) => {
    if (quiet && level === 'info') return
    write(level, message)
    try {
      activity?.log(level, message)
    } catch {
      // The activity log is a convenience; the console line already landed.
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
    debug: (message) => { if (debug) emit('info', message) },
    raw: (level, message) => write(level, message),
  }
}

export default { name, inject, Config, apply }

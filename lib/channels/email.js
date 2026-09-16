/**
 * Email channel: turns a notification into a message and submits it over SMTP.
 *
 * Credential resolution is layered so a password never has to be written into a
 * tracked file:
 *
 * 1. `email.passEnv` names an environment variable (default `DSH_SMTP_PASSWORD`);
 * 2. `email.pass` is a literal in the composition or settings document;
 * 3. `email.passCommand` is a local command whose stdout is the secret
 *    (Keychain helper, `security find-generic-password`, `pass`, …).
 *
 * @module dsh-notify-long/lib/channels/email
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { clip, describeError, deepMerge, positiveNumber, sanitizeLine, sanitizeText } from '../util.js'
import { buildAlertMessage, normalizeAddress, normalizeRecipients } from '../email/mime.js'
import { sendMail } from '../email/smtp.js'

const run = promisify(execFile)

/**
 * Well-known provider endpoints, so a configuration only needs a user, a sender
 * and a recipient. `implicit` means TLS from the first byte (port 465);
 * `starttls` upgrades a plain connection (port 587).
 */
export const PROVIDER_PRESETS = Object.freeze({
  qq: { host: 'smtp.qq.com', port: 465, tls: 'implicit' },
  'qq-exmail': { host: 'smtp.exmail.qq.com', port: 465, tls: 'implicit' },
  '163': { host: 'smtp.163.com', port: 465, tls: 'implicit' },
  '163-enterprise': { host: 'smtphz.qiye.163.com', port: 465, tls: 'implicit' },
  aliyun: { host: 'smtp.qiye.aliyun.com', port: 465, tls: 'implicit' },
  gmail: { host: 'smtp.gmail.com', port: 465, tls: 'implicit' },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' },
  office365: { host: 'smtp.office365.com', port: 587, tls: 'starttls' },
  icloud: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
  zoho: { host: 'smtp.zoho.com', port: 465, tls: 'implicit' },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, tls: 'implicit' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, tls: 'starttls', user: 'apikey' },
  mailgun: { host: 'smtp.mailgun.org', port: 587, tls: 'starttls' },
  resend: { host: 'smtp.resend.com', port: 465, tls: 'implicit', user: 'resend' },
  brevo: { host: 'smtp-relay.brevo.com', port: 587, tls: 'starttls' },
})

/**
 * Name the provider preset an email section implies when it names none.
 *
 * The common configuration is a QQ mailbox and an authorization code, and
 * asking for `smtp.qq.com`, `465` and `implicit` on top of that is three
 * questions with one answer. A section that sets no `preset` and no `host`, but
 * whose account is a QQ address (or a bare QQ number), therefore means the QQ
 * preset — and a section that configures anything else keeps meaning exactly
 * what it says.
 *
 * @param {any} email - the email section
 * @returns {string} the preset name, or an empty string when none is implied
 */
export function inferPreset(email) {
  const preset = sanitizeLine(email?.preset ?? '')
  if (preset !== '') return preset
  if (sanitizeLine(email?.host ?? '') !== '') return ''
  const account = sanitizeLine(email?.user ?? '') || sanitizeLine(email?.from ?? '')
  if (/^\d{5,12}$/.test(account)) return 'qq'
  const domain = (/@([^\s@>]+)$/.exec(account)?.[1] ?? '').toLowerCase()
  return domain === 'qq.com' || domain === 'foxmail.com' ? 'qq' : ''
}

/**
 * Expand a bare QQ number into the mailbox address QQ's SMTP expects. Only the
 * QQ preset does this: every other provider wants the account verbatim.
 *
 * @param {unknown} user - the configured account
 * @param {string} presetName - the resolved preset
 * @returns {string} the account to authenticate with
 */
function accountOf(user, presetName) {
  const value = sanitizeLine(user ?? '')
  if (presetName !== 'qq') return value
  return /^\d{5,12}$/.test(value) ? `${value}@qq.com` : value
}

/**
 * Fill in the two addresses a configuration can imply: the sender falls back to
 * the account, and the recipient falls back to the sender, so "notify me" needs
 * no address typed twice.
 *
 * @param {any} email - the email section, with any preset already merged
 * @param {string} presetName - the resolved preset
 * @returns {any} the email section with account defaults applied
 */
function withAccountDefaults(email, presetName) {
  const user = accountOf(email.user, presetName)
  const configuredFrom = sanitizeLine(email.from ?? '')
  const from = configuredFrom !== '' ? email.from : user
  const to = normalizeRecipients(email.to).length > 0
    ? email.to
    : normalizeRecipients(from)
  return {
    ...email,
    ...user === email.user ? {} : { user },
    ...from === email.from ? {} : { from },
    ...to === email.to ? {} : { to },
  }
}

/**
 * Resolve the effective email section: a named provider preset — or the one the
 * account implies — supplies host/port/transport, anything set explicitly still
 * wins, and the sender/recipient addresses fall back to the account.
 *
 * @param {any} settings - effective configuration
 * @returns {any} the email section with the preset and account defaults applied
 */
export function resolveEmailSettings(settings) {
  const email = settings?.email ?? {}
  const presetName = inferPreset(email)
  if (presetName === '') return withAccountDefaults(email, '')
  const preset = PROVIDER_PRESETS[presetName]
  if (preset === undefined) return { ...email, presetError: `unknown email preset "${presetName}"` }
  return withAccountDefaults(deepMerge(preset, email), presetName)
}

/**
 * Whether SMTP is configured well enough to attempt delivery.
 *
 * @param {any} settings - effective configuration
 * @returns {boolean} true when host, sender and at least one recipient exist
 */
export function emailReady(settings) {
  const email = resolveEmailSettings(settings)
  if (email.enabled === false) return false
  if (sanitizeLine(email.host ?? '') === '') return false
  if (normalizeAddress(email.from) === undefined) return false
  return normalizeRecipients(email.to).length > 0
}

/**
 * Describe the email channel without revealing the secret.
 *
 * @param {any} settings - effective configuration
 * @returns {{ ready: boolean, preset: string, host: string, port: number, user: string, from: string, to: string[], secretSource: string, summary: string }}
 *   a redacted view for tool output, the settings card and logs
 */
export function describeEmail(settings) {
  const raw = settings?.email ?? {}
  const email = resolveEmailSettings(settings)
  const ready = emailReady(settings)
  const view = {
    ready,
    // The preset is read from the raw section: the resolved one always carries
    // a host, which is exactly what suppresses inference.
    preset: inferPreset(raw),
    host: sanitizeLine(email.host ?? ''),
    port: Number.isFinite(email.port) ? email.port : 465,
    user: sanitizeLine(email.user ?? ''),
    from: sanitizeLine(email.from ?? ''),
    to: normalizeRecipients(email.to),
    secretSource: secretSourceOf(email),
  }
  return {
    ...view,
    summary: ready
      ? `${view.host}:${view.port} as ${view.user || view.from} → ${view.to.join(', ')} (secret: ${view.secretSource})`
      : 'not configured: set the mailbox address and its authorization code',
  }
}

/**
 * Name the source a password would come from, for diagnostics.
 *
 * @param {any} email - the email section
 * @returns {string} `env:NAME`, `command`, `inline`, or `missing`
 */
export function secretSourceOf(email) {
  if (sanitizeLine(email?.pass ?? '') !== '') return 'inline'
  if (sanitizeLine(email?.passCommand ?? '') !== '') return 'command'
  return `env:${sanitizeLine(email?.passEnv ?? '') || 'DSH_SMTP_PASSWORD'}`
}

/**
 * Resolve the SMTP password from the layered sources.
 *
 * @param {any} email - the email section
 * @param {object} [options] - resolution options
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read, defaults to the process
 * @param {(command: string) => Promise<string>} [options.execute] - command runner seam for tests
 * @returns {Promise<string>} the password, or an empty string when none is configured
 */
export async function resolvePass(email, options = {}) {
  const env = options.env ?? process.env
  const inline = typeof email?.pass === 'string' ? email.pass : ''
  if (inline !== '') return inline
  const passEnv = sanitizeLine(email?.passEnv ?? '')
  if (passEnv !== '' && typeof env[passEnv] === 'string' && env[passEnv] !== '') return env[passEnv]
  if (passEnv === '' && typeof env.DSH_SMTP_PASSWORD === 'string' && env.DSH_SMTP_PASSWORD !== '') {
    return env.DSH_SMTP_PASSWORD
  }
  const command = sanitizeLine(email?.passCommand ?? '')
  if (command === '') return ''
  const execute = typeof options.execute === 'function'
    ? options.execute
    : async (line) => {
      const { stdout } = await run('/bin/sh', ['-c', line], { timeout: 10_000 })
      return stdout
    }
  try {
    return String(await execute(command)).trim()
  } catch (error) {
    throw new Error(`dsh-notify-long: passCommand failed: ${describeCommandFailure(error)}`)
  }
}

/**
 * Describe a failed password command without echoing the command itself, which
 * may carry the secret as an argument. Only the exit status and stderr survive,
 * clipped, so the reason reaches the activity log while the command line does
 * not.
 *
 * @param {unknown} error - the thrown value
 * @returns {string} a printable reason
 */
function describeCommandFailure(error) {
  if (typeof error === 'object' && error !== null) {
    const status = Number.isFinite(error.code) ? `exit ${error.code}` : ''
    const stderr = clip(sanitizeText(error.stderr ?? '').replace(/\s+/g, ' '), 200)
    const detail = [status, stderr].filter((part) => part !== '').join(': ')
    if (detail !== '') return detail
  }
  return 'the command did not produce a secret'
}

/**
 * Send one notification by email.
 *
 * @param {object} input - send input
 * @param {object} input.event - the notification event
 * @param {any} input.settings - effective configuration
 * @param {string} [input.sessionTitle] - human title of the owning session
 * @param {(options: any) => Promise<any>} [input.transport] - SMTP seam for tests
 * @param {object} [input.secretOptions] - password resolution options
 * @param {boolean} [input.trace] - include the redacted SMTP conversation in the outcome
 * @returns {Promise<{ ok: boolean, detail: string, code?: string, transcript?: string[] }>} the delivery outcome
 */
export async function sendEmail(input) {
  const email = resolveEmailSettings(input.settings)
  if (!emailReady(input.settings)) {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED', detail: 'email is not configured: set the mailbox address and its authorization code' }
  }
  let message
  try {
    // The message is built from the *resolved* section, so the preset's host,
    // the account-derived sender and the self-addressed recipient are what the
    // mail actually uses — the same view `describeEmail` reports.
    message = buildAlertMessage({
      event: input.event,
      settings: { ...input.settings, email },
      sessionTitle: input.sessionTitle,
    })
  } catch (error) {
    return { ok: false, code: 'EMAIL_BUILD', detail: `could not build the message: ${describeError(error)}` }
  }
  if (message === undefined) {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED', detail: 'email is not configured: set the mailbox address and its authorization code' }
  }
  let pass = ''
  try {
    pass = await resolvePass(email, input.secretOptions ?? {})
  } catch (error) {
    return { ok: false, code: 'EMAIL_SECRET', detail: describeError(error) }
  }
  const port = Number.isFinite(email.port) && email.port > 0 ? Math.trunc(email.port) : 465
  const transport = typeof input.transport === 'function' ? input.transport : sendMail
  const result = await transport({
    host: sanitizeLine(email.host ?? ''),
    port,
    tls: email.tls,
    requireTls: email.requireTls !== false,
    verifyCert: email.verifyCert !== false,
    preferPlain: email.preferPlain !== false,
    user: sanitizeLine(email.user ?? ''),
    pass,
    from: message.from,
    to: message.to,
    raw: message.raw,
    subject: message.subject,
    messageId: message.messageId,
    heloName: email.heloName,
    timeoutMs: positiveNumber(email.timeoutMs, 20_000),
    allowPortFallback: email.allowPortFallback !== false,
    trace: input.trace === true,
  })
  return {
    ok: result.ok === true,
    code: result.code,
    detail: result.detail ?? '',
    ...Array.isArray(result.transcript) ? { transcript: result.transcript } : {},
  }
}

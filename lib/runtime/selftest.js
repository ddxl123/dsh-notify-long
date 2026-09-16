/**
 * Channel self-test: "is my alert setup actually working?"
 *
 * One implementation serves both the model-facing `notify_test` tool and the
 * button in the settings card, so the answer the operator reads in the GUI is
 * literally the answer the model would get. Each channel reports its own line —
 * `played`, `shown`, `sent`, or the reason it could not — because "the test
 * failed" is useless when three channels are configured and only one is broken.
 *
 * @module dsh-notify-long/lib/runtime/selftest
 */

import { planSoundCommand, resolveSoundFile } from '../channels/sound.js'
import { messagesFor } from '../core/i18n.js'

/**
 * Build the test event one channel reports on.
 *
 * @param {number} at - epoch milliseconds of the test
 * @param {any} settings - effective configuration, for the message language
 * @returns {any} the notification event
 */
function testEvent(at, settings) {
  const m = messagesFor(settings?.language)
  return {
    kind: 'test',
    title: m.testTitle,
    body: m.testBody(new Date(at).toLocaleString()),
    at,
    urgency: 'info',
  }
}

/**
 * Exercise the requested channels and report each one.
 *
 * @param {object} input - test input
 * @param {any} input.engine - the alert engine
 * @param {any} input.settings - effective configuration
 * @param {boolean} input.emailReady - whether SMTP is configured well enough to attempt
 * @param {'all' | 'sound' | 'desktop' | 'email'} [input.channel] - which channel to exercise
 * @param {number} [input.at] - epoch milliseconds of the test
 * @returns {Promise<{ ok: boolean, sound: string, desktop: string, email: string }>} one line per channel
 */
export async function runSelfTest(input) {
  const settings = input.settings ?? {}
  const requested = input.channel ?? 'all'
  const at = Number.isFinite(input.at) ? input.at : Date.now()
  const event = testEvent(at, settings)
  const results = { sound: 'not requested', desktop: 'not requested', email: 'not requested' }

  if (requested === 'all' || requested === 'sound') {
    const configuredSound = settings.sound?.perKind?.test ?? settings.sound?.file
    const file = resolveSoundFile({ kind: 'test', sound: configuredSound })
    if (settings.sound?.enabled === false) results.sound = 'disabled in settings'
    else if (planSoundCommand({ file, player: settings.sound?.player }) === undefined) results.sound = 'no usable player or sound file on this machine'
    else {
      const outcome = await input.engine.playSound({ file, kind: 'test', player: settings.sound?.player, timeoutMs: settings.sound?.timeoutMs })
      results.sound = outcome.ok ? `played (${outcome.detail})` : `failed: ${outcome.detail}`
    }
  }
  if (requested === 'all' || requested === 'desktop') {
    const outcome = settings.desktop?.enabled === false
      ? { ok: false, detail: 'disabled in settings' }
      : await input.engine.showDesktop({
        title: event.title,
        body: event.body,
        kind: 'test',
        sound: settings.desktop?.sound,
      })
    results.desktop = outcome.ok ? `shown (${outcome.detail})` : `failed: ${outcome.detail}`
  }
  if (requested === 'all' || requested === 'email') {
    const outcome = settings.email?.enabled === false
      ? { ok: false, detail: 'disabled in settings' }
      : await input.engine.sendEmail({ event, settings })
    results.email = outcome.ok ? `sent (${outcome.detail})` : `failed: ${outcome.detail}`
    if (input.emailReady !== true && settings.email?.enabled !== false) {
      results.email = 'not configured: set the mailbox address and its authorization code'
    }
  }
  const ok = Object.values(results).some((entry) => /^(played|shown|sent)/.test(entry))
  return { ok, ...results }
}

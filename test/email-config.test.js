/**
 * The email configuration contract behind the simplified card: a QQ address and
 * its authorization code are the whole configuration.
 *
 * What the host half promises, and what these tests pin down: the QQ preset is
 * inferred from the account when nothing else is configured, the sender falls
 * back to the account, the recipient falls back to the sender, an explicit
 * value always wins, and a failing password command never echoes its own
 * command line into a log.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeEmail,
  emailReady,
  inferPreset,
  resolveEmailSettings,
  sendEmail,
} from '../lib/channels/email.js'

test('a QQ account implies the QQ preset and nothing else does', () => {
  assert.equal(inferPreset({ user: '123456789@qq.com' }), 'qq')
  assert.equal(inferPreset({ user: 'someone@foxmail.com' }), 'qq')
  assert.equal(inferPreset({ user: '123456789' }), 'qq', 'a bare QQ number is a QQ mailbox account')
  assert.equal(inferPreset({ from: 'someone@qq.com' }), 'qq')
  assert.equal(inferPreset({ user: 'someone@gmail.com' }), '')
  assert.equal(inferPreset({ user: 'someone@qq.com', host: 'smtp.example.com' }), '', 'an explicit host means the user configured the server')
  assert.equal(inferPreset({ user: 'someone@qq.com', preset: 'qq-exmail' }), 'qq-exmail', 'an explicit preset wins')
  assert.equal(inferPreset({}), '')
})

test('the resolved section fills host, sender and recipient from the account', () => {
  const resolved = resolveEmailSettings({ email: { user: '123456789@qq.com', pass: 'code' } })
  assert.equal(resolved.host, 'smtp.qq.com')
  assert.equal(resolved.port, 465)
  assert.equal(resolved.tls, 'implicit')
  assert.equal(resolved.from, '123456789@qq.com')
  assert.deepEqual(resolved.to, ['123456789@qq.com'], 'mail goes to the operator when no recipient is typed')
  assert.equal(emailReady({ email: { user: '123456789@qq.com', pass: 'code' } }), true)

  const bare = resolveEmailSettings({ email: { user: '123456789' } })
  assert.equal(bare.user, '123456789@qq.com', 'a bare number becomes the address QQ expects')
  assert.deepEqual(bare.to, ['123456789@qq.com'])
})

test('explicit addresses and servers always win over the inferred ones', () => {
  const resolved = resolveEmailSettings({
    email: {
      user: '123456789@qq.com',
      host: 'smtp.example.com',
      port: 2525,
      from: 'DSH <bot@example.com>',
      to: 'ops@example.com, second@example.com',
      cc: 'audit@example.com',
    },
  })
  assert.equal(resolved.host, 'smtp.example.com')
  assert.equal(resolved.port, 2525)
  assert.equal(resolved.from, 'DSH <bot@example.com>')
  assert.equal(resolved.to, 'ops@example.com, second@example.com', 'a configured recipient list is left exactly as the user wrote it')
  assert.deepEqual(describeEmail({ email: resolved }).to, ['ops@example.com', 'second@example.com'], 'and is normalized where it is used')
  assert.deepEqual(resolved.cc, 'audit@example.com', 'keys the card does not derive are untouched')
})

test('an unconfigured email section stays quiet', () => {
  assert.equal(emailReady({ email: {} }), false)
  assert.equal(emailReady({ email: { user: 'someone@gmail.com' } }), false, 'a non-QQ account with no host is not ready')
  assert.equal(emailReady({ email: { user: '123456789@qq.com', enabled: false } }), false)
  assert.equal(emailReady({ email: { user: '123456789@qq.com', pass: 'code', enabled: true } }), true)
})

test('sendEmail delivers to the account over the inferred QQ endpoint', async () => {
  let seen
  const result = await sendEmail({
    event: { kind: 'completed', title: 'build', body: 'done', at: Date.now() },
    settings: { email: { user: '123456789@qq.com', pass: 'code' } },
    transport: async (options) => { seen = options; return { ok: true, detail: 'stub' } },
  })
  assert.equal(result.ok, true, result.detail)
  assert.equal(seen.host, 'smtp.qq.com')
  assert.equal(seen.port, 465)
  assert.equal(seen.tls, 'implicit')
  assert.equal(seen.user, '123456789@qq.com')
  assert.equal(seen.pass, 'code')
  assert.equal(seen.from, '123456789@qq.com')
  assert.deepEqual(seen.to, ['123456789@qq.com'])
})

test('describeEmail reports the resolved route and never the secret', () => {
  const view = describeEmail({ email: { user: '123456789@qq.com', pass: 'super-secret-code' } })
  assert.equal(view.ready, true)
  assert.equal(view.preset, 'qq')
  assert.match(view.summary, /smtp\.qq\.com:465 as 123456789@qq\.com → 123456789@qq\.com \(secret: inline\)/)
  assert.equal(JSON.stringify(view).includes('super-secret-code'), false)

  const missing = describeEmail({ email: {} })
  assert.equal(missing.ready, false)
  assert.match(missing.summary, /not configured/)
})

test('a failing password command reports its status without echoing the command', async () => {
  const result = await sendEmail({
    event: { kind: 'test', title: 't', body: 'b', at: Date.now() },
    settings: {
      email: {
        host: 'smtp.qq.com',
        user: '123456789@qq.com',
        passCommand: 'echo "keychain is locked" >&2; exit 7',
      },
    },
    transport: async () => ({ ok: true, detail: 'stub' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EMAIL_SECRET')
  assert.match(result.detail, /passCommand failed: exit 7/)
  assert.equal(result.detail.includes('exit 7; echo'), false, 'the command line may carry the secret and must not be echoed')
  assert.equal(result.detail.includes('keychain is locked'), true, 'the command stderr is what makes the failure diagnosable')
})

test('a password command that succeeds still provides the secret', async () => {
  let seen
  const result = await sendEmail({
    event: { kind: 'test', title: 't', body: 'b', at: Date.now() },
    settings: { email: { user: '123456789@qq.com', passCommand: 'printf code-from-keychain' } },
    transport: async (options) => { seen = options; return { ok: true, detail: 'stub' } },
  })
  assert.equal(result.ok, true, result.detail)
  assert.equal(seen.pass, 'code-from-keychain')
})

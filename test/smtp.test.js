/**
 * SMTP client tests, driven against the in-process stub server so real protocol
 * responses (greeting, EHLO, AUTH, envelope, DATA) are exercised.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sendMail } from '../lib/email/smtp.js'
import { sendEmail } from '../lib/channels/email.js'
import { startSmtpServer } from './helpers/smtp-server.js'

/** @returns {string} a minimal RFC 5322 message */
function sampleMessage() {
  return [
    'From: bot@example.com',
    'To: ops@example.com',
    'Subject: test',
    '',
    'body',
  ].join('\r\n')
}

test('sendMail delivers a message over a plain connection with AUTH PLAIN', async () => {
  const server = await startSmtpServer({ auth: ['PLAIN'], user: 'user@example.com', pass: 'secret' })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: false,
      user: 'user@example.com',
      pass: 'secret',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, true, result.detail)
    assert.equal(result.code, 'SMTP_OK')
    assert.equal(server.received.length, 1)
    assert.equal(server.received[0].from, 'bot@example.com')
    assert.deepEqual(server.received[0].to, ['ops@example.com'])
    assert.match(server.received[0].raw, /body/)
  } finally {
    await server.close()
  }
})

test('the envelope paths carry the RFC 5321 angle brackets QQ Mail insists on', async () => {
  // Regression: the client used to send `MAIL FROM:user@qq.com`, which QQ
  // answers with `502 Invalid input from <ip> to <host>.` while accepting the
  // bracketed form in the same session. The stub server here is strict exactly
  // like QQ, so a bare path fails the delivery outright.
  const server = await startSmtpServer({ auth: ['PLAIN'], user: 'user@example.com', pass: 'secret' })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: false,
      user: 'user@example.com',
      pass: 'secret',
      from: 'DSH <bot@example.com>',
      to: ['ops@example.com', 'second@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, true, result.detail)
    assert.equal(server.received[0].envelope.mailFrom, '<bot@example.com>', 'a display name is stripped, the brackets are not')
    assert.deepEqual(server.received[0].envelope.rcptTo, ['<ops@example.com>', '<second@example.com>'])
  } finally {
    await server.close()
  }
})

test('esmtpArg always brackets a path and never doubles the brackets', async () => {
  const { esmtpArg } = await import('../lib/email/smtp.js')
  assert.equal(esmtpArg('user@example.com'), '<user@example.com>')
  assert.equal(esmtpArg('<user@example.com>'), '<user@example.com>')
  assert.equal(esmtpArg('  user@example.com  '), '<user@example.com>')
  assert.equal(esmtpArg(''), '<>', 'the null reverse-path of a bounce is still a valid path')
})

test('a rejected envelope names the command that was rejected', async () => {
  const server = await startSmtpServer({ auth: [], rejectSender: true })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: false,
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SMTP_REJECT')
    assert.match(result.detail, /SMTP rejected the sender \(502 5\.5\.2 sender rejected by policy\) for MAIL FROM:<bot@example\.com>/)
  } finally {
    await server.close()
  }
})

test('the opt-in transcript shows the conversation with credentials redacted', async () => {
  const server = await startSmtpServer({ auth: ['PLAIN'], user: 'user@example.com', pass: 'top-secret-pass' })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: false,
      user: 'user@example.com',
      pass: 'top-secret-pass',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
      trace: true,
    })
    assert.equal(result.ok, true, result.detail)
    const transcript = result.transcript.join('\n')
    assert.match(transcript, /> EHLO /)
    assert.match(transcript, /> AUTH PLAIN \[redacted\]/)
    assert.match(transcript, /> MAIL FROM:<bot@example\.com>/)
    assert.match(transcript, /> RCPT TO:<ops@example\.com>/)
    assert.match(transcript, /> DATA/)
    assert.match(transcript, /< 250 /)
    const secret = Buffer.from('\u0000user@example.com\u0000top-secret-pass', 'utf8').toString('base64')
    assert.equal(transcript.includes(secret), false, 'the SASL payload never reaches the transcript')
    assert.equal(transcript.includes('top-secret-pass'), false)
  } finally {
    await server.close()
  }

  const quiet = await startSmtpServer({ auth: [] })
  try {
    const plain = await sendMail({
      host: '127.0.0.1',
      port: quiet.port,
      tls: 'plain',
      requireTls: false,
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(plain.transcript, undefined, 'the transcript is opt-in: it is not carried around by default')
  } finally {
    await quiet.close()
  }
})

test('sendMail reports a failed authentication instead of throwing', async () => {
  const server = await startSmtpServer({ auth: ['PLAIN'], user: 'user@example.com', pass: 'right' })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: false,
      user: 'user@example.com',
      pass: 'wrong',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SMTP_PROTOCOL')
    assert.match(result.detail, /authentication failed/i)
    assert.equal(server.received.length, 0)
  } finally {
    await server.close()
  }
})

test('sendMail refuses to send credentials over a cleartext link when requireTls is on', async () => {
  const server = await startSmtpServer({ auth: ['PLAIN'] })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      requireTls: true,
      user: 'user@example.com',
      pass: 'secret',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /credentials over a cleartext link/)
  } finally {
    await server.close()
  }
})

test('sendMail reports rejected recipients and fails when none are accepted', async () => {
  const server = await startSmtpServer({ auth: [], rejectRecipients: ['bad@example.com'] })
  try {
    const rejected = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      from: 'bot@example.com',
      to: ['bad@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, 'SMTP_REJECT')
    assert.match(rejected.detail, /rejected every recipient/)

    const partial = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      from: 'bot@example.com',
      to: ['ops@example.com', 'bad@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(partial.ok, true, partial.detail)
    assert.deepEqual(partial.accepted, [0])
    assert.match(partial.detail, /rejected: bad@example\.com/)
  } finally {
    await server.close()
  }
})

test('sendMail reports a DATA rejection as a failure', async () => {
  const server = await startSmtpServer({ auth: [], failData: true })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: sampleMessage(),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /rejected the message body/)
  } finally {
    await server.close()
  }
})

test('sendMail dot-stuffs a body line that starts with a period', async () => {
  const server = await startSmtpServer({ auth: [] })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      tls: 'plain',
      from: 'bot@example.com',
      to: ['ops@example.com'],
      raw: ['From: bot@example.com', 'To: ops@example.com', '', '.hidden line', 'plain line'].join('\r\n'),
      timeoutMs: 5_000,
    })
    assert.equal(result.ok, true, result.detail)
    assert.match(server.received[0].raw, /\n\.hidden line/)
  } finally {
    await server.close()
  }
})

test('sendMail times out instead of hanging on an unreachable port', async () => {
  const result = await sendMail({
    host: '127.0.0.1',
    // A port that is closed for connections; the client must fail fast rather
    // than wait for the operating system's connect timeout.
    port: 1,
    tls: 'plain',
    from: 'bot@example.com',
    to: ['ops@example.com'],
    raw: sampleMessage(),
    allowPortFallback: false,
    timeoutMs: 2_000,
  })
  assert.equal(result.ok, false)
  assert.ok(['SMTP_CONNECT', 'SMTP_TIMEOUT'].includes(result.code ?? ''), `unexpected code ${result.code}`)
})

test('sendEmail builds and delivers a full alert through the channel', async () => {
  const server = await startSmtpServer({ auth: ['PLAIN'], user: 'user@example.com', pass: 'secret' })
  try {
    const settings = {
      email: {
        host: '127.0.0.1',
        port: server.port,
        tls: 'plain',
        requireTls: false,
        user: 'user@example.com',
        pass: 'secret',
        from: 'DSH <bot@example.com>',
        to: 'ops@example.com',
        subjectPrefix: '[DSH]',
      },
    }
    const result = await sendEmail({
      event: { kind: 'completed', title: 'Finished: nightly build', body: 'all green', at: Date.now(), urgency: 'action' },
      settings,
      sessionTitle: 'nightly build',
    })
    assert.equal(result.ok, true, result.detail)
    assert.equal(server.received.length, 1)
    assert.match(server.received[0].raw, /Subject: =\?UTF-8\?B\?|Subject: \[DSH\]/)
    assert.match(server.received[0].raw, /Content-Type: multipart\/alternative/)
  } finally {
    await server.close()
  }
})

test('sendEmail resolves the password from a command and reports an unconfigured channel', async () => {
  const settings = {
    email: {
      host: '127.0.0.1',
      port: 1,
      tls: 'plain',
      from: 'bot@example.com',
      to: 'ops@example.com',
      passCommand: 'printf secret',
    },
  }
  let executed = ''
  const result = await sendEmail({
    event: { kind: 'test', title: 't', body: 'b', at: Date.now() },
    settings,
    transport: async (options) => {
      executed = options.pass
      return { ok: true, detail: 'stub' }
    },
    secretOptions: { execute: async (command) => `${command} -> secret` },
  })
  assert.equal(result.ok, true, result.detail)
  assert.equal(executed, 'printf secret -> secret')

  const unconfigured = await sendEmail({ event: { kind: 'test', title: 't', body: 'b' }, settings: { email: {} } })
  assert.equal(unconfigured.ok, false)
  assert.equal(unconfigured.code, 'EMAIL_NOT_CONFIGURED')
})

test('a provider preset fills in host, port and transport, and explicit values win', async () => {
  const { resolveEmailSettings } = await import('../lib/channels/email.js')
  assert.equal(resolveEmailSettings({ email: { preset: 'qq' } }).host, 'smtp.qq.com')
  assert.equal(resolveEmailSettings({ email: { preset: 'qq' } }).port, 465)
  assert.equal(resolveEmailSettings({ email: { preset: 'outlook' } }).tls, 'starttls')
  // An explicit value always wins over the preset.
  assert.equal(resolveEmailSettings({ email: { preset: 'qq', host: 'custom.example.com' } }).host, 'custom.example.com')
  assert.match(resolveEmailSettings({ email: { preset: 'nope' } }).presetError, /unknown email preset/)

  let seen
  const preset = await sendEmail({
    event: { kind: 'test', title: 'preset', body: 'b', at: Date.now() },
    settings: { email: { preset: 'sendgrid', pass: 'k', from: 'bot@example.com', to: ['ops@example.com'] } },
    transport: async (options) => { seen = options; return { ok: true, detail: 'stub' } },
  })
  assert.equal(preset.ok, true, preset.detail)
  assert.equal(seen.host, 'smtp.sendgrid.net')
  assert.equal(seen.port, 587)
  assert.equal(seen.user, 'apikey')
})

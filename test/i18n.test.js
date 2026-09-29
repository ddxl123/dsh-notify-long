/**
 * The alert-language contract.
 *
 * Everything a human reads — the mail subject, the mail body, the desktop
 * banner title — comes from one catalogue, and the language that selects it is
 * a setting. What this file pins down:
 *
 * - `auto` follows the operating system, `zh` / `en` pin it, and an **unset**
 *   value means English (never "detect"), so a library caller or a test gets the
 *   same output on every machine;
 * - both catalogues carry the same keys, so a message added to one cannot
 *   silently fall back to English in the other;
 * - a Chinese configuration really produces Chinese mail, encoded the way a
 *   mail header must be.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LANGUAGES, MESSAGES, messagesFor, resolveLanguage, systemLanguage } from '../lib/core/i18n.js'
import { buildSubject, kindLabel, renderHtmlBody, renderTextBody, urgencyLabel } from '../lib/core/text.js'
import { completionBody, completionTitle } from '../lib/core/detect.js'
import { resolveEmailSettings } from '../lib/channels/email.js'
import { buildAlertMessage } from '../lib/email/mime.js'
import { runSelfTest } from '../lib/runtime/selftest.js'

/**
 * Decode the quoted-printable text of a raw message, so assertions can read what
 * a mail client would show instead of the wire form.
 *
 * @param {string} raw - the raw RFC 5322 message
 * @returns {string} the decoded text
 */
function decodeBody(raw) {
  const unfolded = raw.replace(/=\r\n/g, '')
  const bytes = []
  for (let index = 0; index < unfolded.length; index += 1) {
    const escape = /^=([0-9A-Fa-f]{2})/.exec(unfolded.slice(index))
    if (escape !== null) {
      bytes.push(Number.parseInt(escape[1], 16))
      index += 2
      continue
    }
    const code = unfolded.codePointAt(index)
    bytes.push(...Buffer.from(String.fromCodePoint(code), 'utf8'))
    if (code > 0xffff) index += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

test('the language setting resolves as documented', () => {
  assert.deepEqual(LANGUAGES, ['auto', 'en', 'zh'])
  assert.equal(resolveLanguage('zh'), 'zh')
  assert.equal(resolveLanguage('zh-CN'), 'zh', 'a full locale tag is accepted too')
  assert.equal(resolveLanguage('ZH'), 'zh')
  assert.equal(resolveLanguage('en'), 'en')
  assert.equal(resolveLanguage('en-GB'), 'en')
  assert.equal(resolveLanguage(undefined), 'en', 'unset means English, not "detect"')
  assert.equal(resolveLanguage(''), 'en')
  assert.equal(resolveLanguage('klingon'), 'en')
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }), 'zh')
})

test('auto follows the system, and an unknown locale stays English', () => {
  assert.equal(systemLanguage({ LANG: 'zh_CN.UTF-8' }, 'C'), 'zh', 'the environment is consulted when Intl is neutral')
  assert.equal(systemLanguage({ LC_ALL: 'zh_TW.UTF-8' }, 'C'), 'zh')
  assert.equal(systemLanguage({ LANG: 'en_US.UTF-8' }, 'C'), 'en')
  assert.equal(systemLanguage({}, 'zh-Hans-CN'), 'zh', 'Intl reflects the real user locale')
  assert.equal(systemLanguage({}, 'fr-FR'), 'en', 'a language with no catalogue falls back to English')
  assert.equal(systemLanguage({}, 'C'), 'en')
})

test('both catalogues carry exactly the same keys, of the same kind', () => {
  const en = Object.keys(MESSAGES.en).sort()
  const zh = Object.keys(MESSAGES.zh).sort()
  assert.deepEqual(zh, en, 'every message needs both languages')
  assert.ok(en.length > 40, `the catalogue looks too small: ${en.length} keys`)
  for (const key of en) {
    assert.equal(typeof MESSAGES.en[key], typeof MESSAGES.zh[key], `${key} has a different kind in zh`)
    assert.notEqual(String(MESSAGES.en[key]), '', `${key} is empty in en`)
    assert.notEqual(String(MESSAGES.zh[key]), '', `${key} is empty in zh`)
  }
  assert.equal(MESSAGES.zh.language, 'zh')
  assert.equal(MESSAGES.en.language, 'en')
})

test('messagesFor returns the catalogue a language asked for', () => {
  assert.equal(messagesFor('zh').labelNext, '下一步')
  assert.equal(messagesFor('en').labelNext, 'Next')
  assert.equal(messagesFor(undefined), MESSAGES.en)
  assert.equal(messagesFor('auto', { LANG: 'zh_CN.UTF-8' }), MESSAGES.zh)
})

test('titles, bodies and labels speak the configured language', () => {
  const zh = messagesFor('zh')
  const en = messagesFor('en')
  const facts = { reply: '构建完成', toolCalls: 3, errors: 1 }

  assert.equal(completionTitle({}, undefined, zh), '任务完成')
  assert.equal(completionTitle({ title: 'nightly build' }, 'nightly build', zh), '已完成：nightly build')
  assert.equal(completionTitle({}, undefined, en), 'Task finished')
  assert.equal(completionBody(facts, 2, zh), '构建完成\n\n（3 次工具调用，1 次工具调用失败，第 2 轮）')
  assert.equal(completionBody(facts, 2, en), '构建完成\n\n(3 tool call(s), 1 failed tool call(s), turn 2)')
  assert.equal(completionBody({}, undefined, undefined), '', 'the default catalogue is English and says nothing when there is nothing to say')

  assert.equal(kindLabel('completed', zh), '任务完成')
  assert.equal(kindLabel('question', zh), '需要你回答')
  assert.equal(kindLabel('retry', zh), '模型请求重试')
  assert.equal(kindLabel('completed', en), 'task finished')
  assert.equal(kindLabel('retry', en), 'model retry')
  assert.equal(urgencyLabel('action', zh), '需要处理')
  assert.equal(urgencyLabel('error', en), 'error')
})

test('a Chinese model-retry alert reads like the card that prompted it', () => {
  const zh = messagesFor('zh')
  assert.equal(zh.retryTitle('nightly build'), '模型请求重试：nightly build')
  assert.equal(zh.retryFailure('Connection error.'), '失败原因：Connection error.')
  assert.equal(zh.retryDelay(7_742), '重试延迟：7.7 秒')
  assert.equal(zh.retryDelay(500), '重试延迟：500 毫秒')
  assert.equal(zh.retryAttempt(2, 5), '第 2/5 次重试')
  assert.equal(zh.retryAttempt(1, undefined), '第 1 次重试（不限次数）')

  const en = messagesFor('en')
  assert.equal(en.retryDelay(7_742), 'Retry delay: 7.7 s')
  assert.equal(en.retryAttempt(2, 5), 'attempt 2 of 5')

  // The mail a Chinese configuration produces names the retry in its subject and
  // carries the failure the card showed.
  const message = buildAlertMessage({
    event: {
      kind: 'retry',
      title: zh.retryTitle('nightly build'),
      body: [zh.retryFailure('Connection error. (CONNECTION)'), zh.retryDelay(7_742), zh.retryAttempt(2, 5)].join('\n'),
      hint: zh.hintRetryAuto,
      sessionId: 'session-retry',
      at: Date.UTC(2026, 0, 2, 3, 4, 5),
      urgency: 'info',
    },
    settings: {
      language: 'zh',
      email: resolveEmailSettings({ email: { user: '123456789@qq.com', pass: 'code', subjectPrefix: '[DSH]' } }),
    },
  })
  assert.notEqual(message, undefined)
  assert.equal(message.subject, '[DSH] 模型请求重试 - 模型请求重试：nightly build')
  const text = decodeBody(message.raw)
  assert.match(text, /事件: 模型请求重试/)
  assert.match(text, /失败原因：Connection error\. \(CONNECTION\)/)
  assert.match(text, /重试延迟：7\.7 秒/)
  assert.match(text, /第 2\/5 次重试/)
  assert.match(text, /下一步: 这是 harness 的自动重试/)
})

test('a Chinese alert renders a Chinese subject and body', () => {
  const message = buildAlertMessage({
    event: {
      kind: 'completed',
      title: '已完成：nightly build',
      body: '构建完成，全部通过',
      detail: 'turn 2, 3 tool call(s)',
      hint: '打开会话查看结果。',
      sessionId: 'session-abc',
      sessionTitle: 'nightly build',
      cwd: '/tmp/project',
      at: Date.UTC(2026, 0, 2, 3, 4, 5),
      urgency: 'action',
    },
    // The channel resolves the mailbox first (preset, sender, recipient); the
    // message builder then renders in the language the whole configuration names.
    settings: {
      language: 'zh',
      email: resolveEmailSettings({ email: { user: '123456789@qq.com', pass: 'code', subjectPrefix: '[DSH]' } }),
    },
  })
  assert.notEqual(message, undefined)
  assert.equal(message.subject, '[DSH] 任务完成 - 已完成：nightly build')
  const encoded = /^Subject: (.+)$/m.exec(message.raw)?.[1] ?? ''
  assert.match(encoded, /^=\?UTF-8\?B\?/, 'a non-ASCII subject travels as an encoded word')
  const decoded = encoded.split(' ').map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('')
  assert.equal(decoded, message.subject, 'and decodes back to the same subject')

  const text = decodeBody(message.raw)
  assert.match(text, /已完成：nightly build/)
  assert.match(text, /下一步: 打开会话查看结果。/)
  assert.match(text, /事件: 任务完成/)
  assert.match(text, /工作目录: \/tmp\/project/)
  assert.match(text, /紧急程度: 需要处理/)
  assert.match(text, /由 dsh-notify-long（DeepSeek Harness）发送。/)
  assert.equal(text.includes('Sent by dsh-notify-long'), false, 'no English footer survives')
})

test('an English alert is unchanged by the catalogue', () => {
  const message = buildAlertMessage({
    event: { kind: 'error', title: 'Error: agent run', body: 'boom', at: Date.UTC(2026, 0, 2, 3, 4, 5), urgency: 'error' },
    settings: { email: resolveEmailSettings({ email: { user: 'bot@example.com', pass: 'code' } }) },
  })
  assert.equal(message.subject, '[DSH] error - Error: agent run')
  const text = decodeBody(message.raw)
  assert.match(text, /Event: error/)
  assert.match(text, /Sent by dsh-notify-long/)
})

test('the body renderers take a catalogue directly', () => {
  const zh = renderTextBody({ kind: 'question', title: '需要你的输入：部署', messages: messagesFor('zh') })
  assert.match(zh, /需要你的输入：部署/)
  assert.match(zh, /事件: 需要你回答/)

  const html = renderHtmlBody({ kind: 'question', title: '需要你的输入：部署', hint: '在界面里回答。', messages: messagesFor('zh') })
  assert.match(html, /DeepSeek Harness · 需要你回答/)
  assert.match(html, /<strong>下一步:<\/strong> 在界面里回答。/)

  assert.equal(buildSubject({ kind: 'test', title: '测试', messages: messagesFor('zh') }), '[DSH] 测试通知 - 测试')
  assert.equal(buildSubject({ kind: 'test', title: 'ping' }), '[DSH] test alert - ping', 'an unset catalogue is English')
})

test('the test alert speaks the configured language on every channel', async () => {
  const shown = []
  const result = await runSelfTest({
    settings: { language: 'zh', sound: { enabled: false }, desktop: { enabled: true }, email: { enabled: true } },
    emailReady: true,
    engine: {
      async playSound() { return { ok: false, detail: 'off' } },
      async showDesktop(input) { shown.push(input); return { ok: true, detail: 'stub' } },
      async sendEmail(input) { shown.push(input.event); return { ok: true, detail: 'stub' } },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(shown[0].title, 'dsh-notify-long 测试通知')
  assert.match(shown[0].body, /^验证请求时间：/)
  assert.equal(shown[1].title, 'dsh-notify-long 测试通知')
})

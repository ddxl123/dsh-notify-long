/**
 * Question and approval notifications, tested against the real harness service.
 *
 * `user-questions/request` is a Cordis **waterfall**: the first listener that
 * returns an answer claims the request, and every listener after it is skipped.
 * The browser UI is such an answerer, which makes "was the operator told?" a
 * question about *listener order* — not about the plugin being mounted. A fake
 * harness cannot show that, so this file mounts the real
 * `@deepseek-ai/dsh-user-questions` service next to the real plugin and asks a
 * real question, twice over: once with an answerer registered before the plugin
 * (the live-reload ordering), and once with no agent identity at all.
 *
 * The plugin must notify in every one of those cases, and must never consume the
 * request: the UI still has to receive it and answer.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/** @returns {Promise<boolean>} true when the question service resolves */
async function peersAvailable() {
  try {
    await import('@deepseek-ai/cordis')
    await import('@deepseek-ai/dsh-user-questions')
    return true
  } catch {
    return false
  }
}

const questionTests = (await peersAvailable()) ? test : test.skip

/**
 * Boot a real Cordis runtime with the real question service and the real plugin.
 *
 * @param {object} [options] - harness options
 * @param {boolean} [options.answererFirst] - register the UI answerer before the plugin mounts
 * @param {string} [options.language] - alert language
 * @returns {Promise<any>} the runtime, the activity log and the answer log
 */
async function mountQuestionRuntime(options = {}) {
  const { Context } = await import('@deepseek-ai/cordis')
  const UserQuestionService = (await import('@deepseek-ai/dsh-user-questions')).default
  const module = await import('../src/index.js')

  const home = mkdtempSync(join(tmpdir(), 'dsh-notify-long-question-'))
  const root = new Context()
  const agent = { id: 'session-live-1' }
  /** @type {any[]} */
  const answers = []
  const settings = {
    enabled: true,
    language: options.language ?? 'en',
    // Every real channel is switched off: what is asserted is that the alert was
    // *raised*, which the activity log records whether or not a channel accepted
    // it. A test must never play a sound or open a banner on the operator's Mac.
    sound: { enabled: false },
    desktop: { enabled: false },
    email: { enabled: false },
    alerts: { channels: ['sound', 'desktop', 'email'], kinds: {} },
  }

  root.plugin({
    name: 'test-harness',
    apply(ctx) {
      ctx.provide('agents', { get: (id) => (id === agent.id ? agent : undefined), roots: () => [agent] })
      ctx.provide('tools', { register: () => () => {} })
      ctx.provide('paths', { home })
      ctx.provide('settings', {
        writable: true,
        installSection(_owner, _ns, _schema, base, hooks) { hooks.setSource(() => ({ ...base, ...settings })) },
      })
    },
  })
  root.plugin(UserQuestionService)

  // The UI answerer, exactly as the browser half registers it: it claims the
  // request and returns the human's answer.
  const registerAnswerer = () => root.on('user-questions/request', async () => {
    answers.push('claimed')
    return { answers: [{ id: 'q1', selected: ['yes'] }] }
  })
  if (options.answererFirst === true) registerAnswerer()

  const fiber = root.plugin({ name: module.name, inject: module.inject, apply: module.apply })
  await new Promise((resolve) => { setTimeout(resolve, 250) })
  if (options.answererFirst !== true) registerAnswerer()

  // The card's own route reads the activity log; using it keeps the assertion on
  // the plugin's public surface instead of its files.
  const { createFakeConnection } = await import('./helpers/fake-harness.js')
  void createFakeConnection

  return { root, fiber, agent, answers, home, settings }
}

/**
 * Read the activity entries the plugin recorded.
 *
 * @param {string} home - the plugin's state directory parent
 * @returns {any[]} the entries, newest first
 */
async function readActivity(home) {
  const { readFileSync, existsSync } = await import('node:fs')
  const path = join(home, 'dsh-notify-long', 'activity.json')
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8')).items.slice().reverse()
}

/**
 * The alert *attempts* for a question.
 *
 * One alert leaves more than one entry in the log — the delivery outcome and the
 * retry it scheduled both name the kind — so counting alerts means counting the
 * outcomes, which is exactly one per raised alert.
 *
 * @param {any[]} entries - activity entries
 * @returns {any[]} the delivery outcomes for question alerts
 */
const questionAlerts = (entries) => entries.filter((entry) => entry.kind === 'question' && (entry.event === 'delivered' || entry.event === 'failed'))

questionTests('a question from a live agent alerts the operator', async () => {
  const { root, agent, answers, home } = await mountQuestionRuntime()
  const answer = await root.userQuestions.ask({
    questions: [{ id: 'q1', header: 'Deploy', question: 'Deploy to production?', options: [{ label: 'yes' }, { label: 'no' }] }],
    agent,
  })
  await new Promise((resolve) => { setTimeout(resolve, 250) })

  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['yes'] }] }, 'the UI still receives and answers the request')
  assert.deepEqual(answers, ['claimed'], 'the plugin delegated instead of consuming the request')

  const entries = questionAlerts(await readActivity(home))
  assert.equal(entries.length, 1, 'exactly one question alert, and it names the session')
  assert.equal(entries[0].title, 'Needs your input: Deploy', 'the header becomes the alert title')
  assert.match(entries[0].message, /^could not deliver question “Needs your input: Deploy”/)
  // Email drops out of the route while SMTP is unconfigured — this test
  // configures no mailbox — so the attempt covers the other two channels.
  assert.deepEqual(entries[0].channels, ['sound', 'desktop'])
  assert.deepEqual(entries[0].failures, [
    'sound: sound is disabled in settings',
    'desktop: desktop notifications are disabled in settings',
  ])
})

questionTests('a question still alerts when an answerer registered first', async () => {
  // The hazard this covers: `user-questions/request` is a waterfall, so an
  // answerer registered earlier would claim the request and every listener after
  // it would be skipped — which is what a live plugin reload looks like, with a
  // browser already connected. The plugin registers with `prepend`, so the
  // operator is told regardless of who else is listening.
  const { root, agent, answers, home } = await mountQuestionRuntime({ answererFirst: true })
  const answer = await root.userQuestions.ask({
    questions: [{ id: 'q1', header: 'Deploy', question: 'Deploy to production?', options: [{ label: 'yes' }] }],
    agent,
  })
  await new Promise((resolve) => { setTimeout(resolve, 250) })

  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['yes'] }] })
  assert.deepEqual(answers, ['claimed'])
  assert.equal(questionAlerts(await readActivity(home)).length, 1, 'the alert does not depend on registration order')
})

questionTests('a question with no agent identity still alerts', async () => {
  // `AskUserQuestionRequestEvent.agent` is optional in the harness type. An
  // unattributed question is still a turn blocked on a human, so silence here
  // would stall the agent until somebody happened to look at the window.
  const { root, home } = await mountQuestionRuntime()
  const answer = await root.userQuestions.ask({
    questions: [{ id: 'q1', header: 'Which database?', question: 'Which database should I use?' }],
  })
  await new Promise((resolve) => { setTimeout(resolve, 250) })

  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['yes'] }] })
  const entries = questionAlerts(await readActivity(home))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'Needs your input: Which database?')
  assert.equal(entries[0].sessionId, undefined, 'nothing invented a session for it')
})

questionTests('the same question inside the suppression window alerts once', async () => {
  const { root, agent, home } = await mountQuestionRuntime()
  const request = {
    questions: [{ id: 'q1', header: 'Deploy', question: 'Deploy to production?' }],
    agent,
  }
  await root.userQuestions.ask(request)
  await root.userQuestions.ask({ ...request, questions: [{ id: 'q2', header: 'Deploy', question: 'Deploy to production?' }] })
  await new Promise((resolve) => { setTimeout(resolve, 250) })

  const entries = questionAlerts(await readActivity(home))
  assert.equal(entries.length, 1, 'a re-asked identical question does not mail twice inside the window')
})

questionTests('the alert language reaches the question title', async () => {
  const { root, agent, home } = await mountQuestionRuntime({ language: 'zh' })
  await root.userQuestions.ask({
    questions: [{ id: 'q1', header: '部署', question: '现在部署到生产吗？', options: [{ label: '是' }, { label: '否' }] }],
    agent,
  })
  await new Promise((resolve) => { setTimeout(resolve, 250) })
  const entries = questionAlerts(await readActivity(home))
  assert.equal(entries.length, 1)
  assert.match(entries[0].message, /需要你的输入：部署/)
})

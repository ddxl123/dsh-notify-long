/**
 * The version check behind `scripts/link-harness-deps.mjs`.
 *
 * That script links this package's harness peers beside its source so the tests
 * run against a real installation. It used to re-link only when a peer failed to
 * *resolve*, which meant a DSH upgrade left the old links in place and the whole
 * suite quietly kept validating the previous release's API. These cases pin the
 * check that closes that hole — including the exact range/resolution pair an
 * upgrade from 0.1.5 to 0.2.0 produces.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { satisfies } from '../scripts/link-harness-deps.mjs'

test('a caret on a 0.x range pins the minor', () => {
  const range = '^0.2.0-rc.1'
  assert.equal(satisfies(range, '0.2.0-rc.1'), true, 'the floor itself satisfies')
  assert.equal(satisfies(range, '0.2.0'), true, 'the release the prerelease leads to satisfies')
  assert.equal(satisfies(range, '0.2.5'), true, 'the rest of the minor line satisfies')
  assert.equal(satisfies(range, '0.3.0'), false, 'the next minor does not')
  // The exact pair an upgrade produces: linked 0.1.5, declared ^0.2.0-rc.1.
  assert.equal(satisfies(range, '0.1.5-rc.2'), false, 'the release the user upgraded away from is stale')
  assert.equal(satisfies('^0.1.5-rc.1', '0.2.0-rc.1'), false, 'and the reverse: 0.2 does not satisfy the old peer range')
})

test('a caret on a 1.x-or-later range pins the major', () => {
  assert.equal(satisfies('^3.18.2', '3.18.4'), true)
  assert.equal(satisfies('^3.18.2', '4.0.0'), false)
  assert.equal(satisfies('^4.0.2', '4.0.4'), true, 'cordis is declared loosely and linked at the shipped patch')
})

test('a tilde pins the minor and a bare version is exact', () => {
  assert.equal(satisfies('~4.0.4', '4.0.9'), true)
  assert.equal(satisfies('~4.0.4', '4.1.0'), false)
  assert.equal(satisfies('0.2.0-rc.1', '0.2.0-rc.1'), true)
  assert.equal(satisfies('0.2.0-rc.1', '0.2.0'), false)
})

test('a range this checker cannot parse is never called stale', () => {
  // Abstaining matters more than guessing: a false "stale" would re-link a
  // working installation, and a false "current" only restores the old behaviour.
  for (const range of ['^0.1.0-rc.7 || ^0.1.1-rc.2', '1.x', '>=0.1 <0.2', 'latest']) {
    assert.equal(satisfies(range, '0.2.0-rc.1'), true, `${range} must abstain rather than report stale`)
  }
})

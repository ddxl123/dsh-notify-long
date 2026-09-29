#!/usr/bin/env node
/**
 * Make this package's harness peer dependencies resolvable from its own
 * directory.
 *
 * ## Why this is necessary
 *
 * The plugin imports `@deepseek-ai/schemastery` (for the composition-row config
 * schema) and `@deepseek-ai/dsh-tools` (for `defineTool`). Those are peer
 * dependencies: they belong to the harness installation, not to this package.
 *
 * Node resolves a package's bare imports from its **real** path, following
 * symlinks. A harness-managed profile therefore cannot help here: `dsh plugin`
 * links an out-of-tree plugin at `<profile>/node_modules/<name>`, but resolution
 * from the plugin's real directory walks up *that* tree instead and never sees
 * it. Linking the peers in beside the source is what makes them reachable.
 *
 * The plugin is written to survive their absence — `Config` becomes `undefined`
 * so Cordis skips row validation, and tool definitions fall back to a
 * shape-compatible literal — so a deployment that resolves the peers some other
 * way (a published install, a workspace, a bundler) needs nothing from this
 * script, and a missing harness is a warning rather than a failed install.
 *
 * Resolution order:
 *   1. `node_modules/@deepseek-ai/*` inside this package, when already correct;
 *   2. `--from <dir>` or `DSH_NODE_MODULES` — a `node_modules` directory or an
 *      install root to link from;
 *   3. the npx cache (newest first), then the profile fallback directory the
 *      harness maintains.
 *
 * @module dsh-notify-long/scripts/link-harness-deps
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Peer packages this package imports.
 *
 * The plugin itself imports `schemastery` (config schema) and `dsh-tools`
 * (`defineTool`); the settings contract test also imports `dsh-settings` for
 * its secret redaction, which is the same module the running harness injects.
 *
 * `cordis`, `dsh-client-connection` and `dsh-user-questions` are linked for the
 * integration tests: the transport test mounts the real plugin into a real
 * runtime and posts to the route the settings card uses, and the question test
 * asks a real question through the real waterfall service. Nothing in `src/` or
 * `lib/` imports them: a Cordis plugin is handed its context, the card's route
 * is registered through the injected `connection` service, and questions arrive
 * as events.
 *
 * `dsh-llm-retry` is linked for the same reason: the `retry` kind is a claim
 * about an event the harness appends, so the contract test drives the real retry
 * policy and alerts on the payload it produced rather than on a fixture.
 */
export const PEERS = ['schemastery', 'dsh-tools', 'dsh-settings', 'cordis', 'dsh-client-connection', 'dsh-user-questions', 'dsh-llm-retry']

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Read `--from <dir>` from argv.
 *
 * @param {string[]} argv - process arguments
 * @returns {string | undefined} the requested directory
 */
function fromFlag(argv) {
  const index = argv.indexOf('--from')
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--from requires a directory')
  return resolve(value)
}

/**
 * Can this package import its peers already?
 *
 * Imports are attempted from this module, which sits in `scripts/` — one level
 * below the package root the plugin itself resolves from, so a hit here is a hit
 * there too.
 *
 * @param {string[]} packages - package names to check (unscoped)
 * @returns {Promise<string[]>} the names that failed to import
 */
async function unresolvable(packages) {
  /** @type {string[]} */
  const failed = []
  for (const name of packages) {
    try {
      await import(`@deepseek-ai/${name}`)
    } catch {
      failed.push(name)
    }
  }
  return failed
}

/**
 * The version a simple range starts at, with the operator that qualifies it.
 *
 * Only the shapes this package actually declares are understood (`^`, `~`, `>=`,
 * exact), and only when that shape is the *whole* range. A union, a hyphen
 * range, an x-range or a tag returns undefined, and a range that cannot be
 * parsed is never treated as violated: re-linking a working installation
 * because a checker guessed is worse than leaving it alone.
 *
 * @param {string} range - a semver range, or a concrete version
 * @returns {{ operator: string, version: { major: number, minor: number, patch: number, prerelease: string } } | undefined} the floor
 */
function floorOf(range) {
  const match = /^\s*(\^|~|>=|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/.exec(range)
  if (match === null) return undefined
  return {
    operator: match[1] ?? '=',
    version: {
      major: Number(match[2]),
      minor: Number(match[3]),
      patch: Number(match[4]),
      prerelease: match[5] ?? '',
    },
  }
}

/**
 * Parse a concrete version.
 *
 * @param {string} text - the version
 * @returns {{ major: number, minor: number, patch: number, prerelease: string } | undefined} the parsed version
 */
function parseVersion(text) {
  return floorOf(text)?.version
}

/**
 * Order two parsed versions, prerelease-aware: `0.2.0-rc.1 < 0.2.0`.
 *
 * @param {any} a - left version
 * @param {any} b - right version
 * @returns {number} negative, zero, or positive
 */
function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Whether a version falls inside a range, for the range shapes this package uses.
 *
 * @param {string} range - the declared range
 * @param {string} version - the resolved version
 * @returns {boolean} true when it satisfies, or when the range cannot be judged
 */
export function satisfies(range, version) {
  const floor = floorOf(range)
  const got = parseVersion(version)
  if (floor === undefined || got === undefined) return true
  if (compareVersions(got, floor.version) < 0) return false
  if (floor.operator === '^') {
    // A caret on a 0.x range pins the minor: `^0.2.0-rc.1` is the whole 0.2 line.
    return floor.version.major === 0
      ? got.major === 0 && got.minor === floor.version.minor
      : got.major === floor.version.major
  }
  if (floor.operator === '~') return got.major === floor.version.major && got.minor === floor.version.minor
  if (floor.operator === '>=') return true
  return compareVersions(got, floor.version) === 0
}

/**
 * Whether a `node_modules` directory holds versions this package's
 * `peerDependencies` accept.
 *
 * This is what a DSH upgrade breaks: the links keep resolving, so a plain
 * "are the peers importable?" check says yes while every test runs against the
 * previous release's API. Checking the versions is what turns that silent
 * mismatch into a re-link.
 *
 * @param {string} dir - candidate `node_modules` directory
 * @param {Record<string, string>} ranges - peer name to range
 * @returns {boolean} true when every listed peer satisfies its range
 */
function candidateSatisfiesRanges(dir, ranges) {
  for (const [name, range] of Object.entries(ranges)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    /** @type {string} */
    let version
    try {
      version = JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')).version
    } catch {
      return false
    }
    if (!satisfies(range, version)) return false
  }
  return true
}

/**
 * Does a directory look like a place the harness packages live?
 *
 * @param {string} dir - candidate `node_modules` directory
 * @returns {boolean} true when the expected packages are present
 */
function looksLikeHarnessModules(dir) {
  if (!existsSync(dir)) return false
  return PEERS.every((name) => existsSync(join(dir, '@deepseek-ai', name)))
}

/**
 * The `node_modules` tree of the `dsh` on PATH.
 *
 * After an upgrade this is the only candidate that is certainly the release the
 * user runs: a global install lives beside its own `bin/`, and the npx cache and
 * the profile link farm are both older by construction.
 *
 * @returns {string | undefined} the directory, when `dsh` resolves from PATH
 */
function pathDshModules() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    if (!existsSync(join(dir, 'dsh'))) continue
    // <prefix>/bin/dsh → <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules
    const guess = join(dirname(dir), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
    if (looksLikeHarnessModules(guess)) return guess
  }
  return undefined
}

/**
 * Collect candidate `node_modules` directories, most likely first.
 *
 * @returns {string[]} candidates
 */
function candidates() {
  /** @type {string[]} */
  const found = []
  const explicit = fromFlag(process.argv.slice(2)) ?? process.env.DSH_NODE_MODULES
  if (explicit !== undefined) {
    found.push(explicit)
    found.push(join(explicit, 'node_modules'))
  }
  // The harness the user actually runs, when `dsh` is on PATH.
  const installed = pathDshModules()
  if (installed !== undefined) found.push(installed)
  // The npx cache layout: ~/.npm/_npx/<hash>/node_modules — newest first, since
  // a fresh `npx @deepseek-ai/dsh` lands in a new hash directory.
  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    /** @type {Array<{ dir: string, mtime: number }>} */
    const entries = []
    for (const entry of readdirSync(npxRoot)) {
      const dir = join(npxRoot, entry, 'node_modules')
      try {
        entries.push({ dir, mtime: statSync(join(npxRoot, entry)).mtimeMs })
      } catch {
        // A cache directory that vanished mid-scan is simply not a candidate.
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries) found.push(entry.dir)
  }
  // The fallback directory the harness maintains for profile plugins.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  found.push(join(home, 'profiles', 'node_modules'))
  found.push(join(home, 'profiles', 'web', 'node_modules'))
  return found
}

/**
 * The peers whose currently linked version no longer satisfies this package's
 * `peerDependencies`.
 *
 * @param {string[]} packages - peer names to check (unscoped)
 * @returns {Promise<string[]>} the names that are stale or absent
 */
async function stalePeers(packages) {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  /** @type {Record<string, string>} */
  const ranges = manifest.peerDependencies ?? {}
  /** @type {string[]} */
  const stale = []
  for (const name of packages) {
    const range = ranges[`@deepseek-ai/${name}`]
    if (range === undefined) continue
    /** @type {string} */
    let version
    try {
      version = JSON.parse(readFileSync(join(projectRoot, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version
    } catch {
      stale.push(name)
      continue
    }
    if (!satisfies(range, version)) stale.push(name)
  }
  return stale
}

/**
 * Link the peers from the first harness installation that has them.
 *
 * A re-link happens for two different reasons, and the second is the one that
 * matters after a DSH upgrade:
 *
 *   - the peers do not resolve at all; or
 *   - they resolve, but to versions this package's `peerDependencies` reject.
 *
 * The second case is silent by nature — the tests keep running, against the
 * previous release's API — so it is checked on every run rather than assumed
 * away. An explicit `--from` (or `DSH_NODE_MODULES`) overrides both: asking for
 * a specific installation is a statement about which one is correct.
 *
 * @param {object} [options] - options
 * @param {string[]} [options.packages] - packages to link; defaults to the runtime peers
 * @returns {Promise<{ linked: string[], from?: string, missing: string[], stale: string[] }>} the outcome
 */
export async function linkHarnessDeps(options = {}) {
  const packages = options.packages ?? PEERS
  const already = await unresolvable(packages)
  const forced = fromFlag(process.argv.slice(2)) ?? process.env.DSH_NODE_MODULES
  const stale = forced !== undefined ? [] : await stalePeers(packages)
  if (already.length === 0 && stale.length === 0) return { linked: [], missing: [], stale: [] }

  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  /** @type {Record<string, string>} */
  const ranges = manifest.peerDependencies ?? {}
  /** @type {string | undefined} */
  let source
  /** @type {string | undefined} */
  let fallback
  for (const candidate of candidates()) {
    if (!looksLikeHarnessModules(candidate)) continue
    fallback ??= candidate
    // Prefer an installation this package's ranges accept, so an upgrade does
    // not silently link the release the user just moved off.
    if (candidateSatisfiesRanges(candidate, ranges)) {
      source = candidate
      break
    }
  }
  source ??= fallback
  if (source === undefined) return { linked: [], missing: already, stale }

  const target = join(projectRoot, 'node_modules', '@deepseek-ai')
  mkdirSync(target, { recursive: true })
  /** @type {string[]} */
  const linked = []
  /** @type {string[]} */
  const missing = []
  for (const name of packages) {
    const from = join(source, '@deepseek-ai', name)
    if (!existsSync(from)) {
      missing.push(name)
      continue
    }
    const to = join(target, name)
    // Replace rather than nest, so a re-run cannot build a link inside a link.
    if (lstatSync(to, { throwIfNoEntry: false }) !== undefined) rmSync(to, { recursive: true, force: true })
    symlinkSync(from, to, 'dir')
    linked.push(name)
  }
  return { linked, missing, from: source, stale }
}

// Run as a script, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await linkHarnessDeps()
  if (runtime.stale.length > 0) {
    process.stdout.write(`stale:   ${runtime.stale.join(', ')} no longer satisfies peerDependencies\n`)
  }
  if (runtime.linked.length === 0 && runtime.missing.length === 0 && runtime.stale.length === 0) {
    process.stdout.write('harness peers already resolvable; nothing to do\n')
  } else if (runtime.from === undefined) {
    // Not fatal: without the peers the plugin still loads, with row validation
    // off and literal tool definitions. Say so, and do not fail an install.
    process.stderr.write(
      `dsh-notify-long: could not find a dsh installation providing: ${runtime.missing.join(', ')}\n`
      + 'dsh-notify-long: the plugin will load without config validation and with fallback tool definitions.\n'
      + 'dsh-notify-long: point at an installation explicitly to fix that:\n'
      + '  node scripts/link-harness-deps.mjs --from /path/to/node_modules\n',
    )
  } else {
    process.stdout.write(`harness: ${runtime.from}\nlinked:  ${runtime.linked.join(', ')}\n`)
    if (runtime.missing.length > 0) process.stdout.write(`absent:  ${runtime.missing.join(', ')}\n`)
  }
}

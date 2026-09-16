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

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 */
export const PEERS = ['schemastery', 'dsh-tools', 'dsh-settings', 'cordis', 'dsh-client-connection', 'dsh-user-questions']

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
 * Link the peers from the first harness installation that has them.
 *
 * @param {object} [options] - options
 * @param {string[]} [options.packages] - packages to link; defaults to the runtime peers
 * @returns {Promise<{ linked: string[], from?: string, missing: string[] }>} the outcome
 */
export async function linkHarnessDeps(options = {}) {
  const packages = options.packages ?? PEERS
  const already = await unresolvable(packages)
  if (already.length === 0) return { linked: [], missing: [] }

  /** @type {string | undefined} */
  let source
  for (const candidate of candidates()) {
    if (looksLikeHarnessModules(candidate)) {
      source = candidate
      break
    }
  }
  if (source === undefined) return { linked: [], missing: already }

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
  return { linked, missing, from: source }
}

// Run as a script, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await linkHarnessDeps()
  if (runtime.linked.length === 0 && runtime.missing.length === 0) {
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

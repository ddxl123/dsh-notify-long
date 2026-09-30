#!/usr/bin/env node
/**
 * Install dsh-notify-long into a dsh profile.
 *
 * This package declares `dsh.bundle.patch` in its package.json, so `dsh plugin`
 * already knows how to install it: it runs pnpm in the profile directory and
 * appends this package to `dsh.profile.bundles`, which is what makes the plugin
 * row in `cordis.patch.yml` load. This script is therefore a thin wrapper for
 * that one command —
 *
 *   dsh plugin --profile web add /path/to/dsh-notify-long
 *
 * — with `--dry-run` to see it first and `--uninstall` to reverse it.
 *
 * Nothing here edits a profile file by hand, and nothing here links packages
 * into this checkout: the two packages the plugin imports
 * (`@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`) ship with dsh itself,
 * and the launcher's profile resolution serves them from the running
 * installation to every profile plugin — including one linked from outside the
 * profile. Making them resolvable beside this source, which
 * `scripts/link-harness-deps.mjs` does, is only needed to run the test suite
 * under plain Node.
 *
 * Usage:
 *   node scripts/install.mjs [--profile web] [--uninstall] [--dry-run] [--dsh <path>]
 *
 * @module dsh-notify-long/scripts/install
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginName = 'dsh-notify-long'

/**
 * Read and consume the value of a flag, rejecting a missing one.
 *
 * @param {string[]} argv - process arguments
 * @param {number} index - the value's index (the flag's index plus one)
 * @param {string} flag - the flag name, for the error message
 * @returns {string} the value
 */
function valueAt(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv - process arguments
 * @returns {{ profile: string, uninstall: boolean, dryRun: boolean, dsh: string, help: boolean }} parsed flags
 */
function parseArgs(argv) {
  const options = { profile: 'web', uninstall: false, dryRun: false, dsh: process.env.DSH_BIN ?? 'dsh', help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    // `index += 1` both reads and consumes the value, so the loop's own
    // increment lands past it rather than re-reading it as a flag.
    if (token === '--profile' || token === '-p') options.profile = valueAt(argv, index += 1, token)
    else if (token.startsWith('--profile=')) options.profile = token.slice('--profile='.length)
    else if (token === '--dsh') options.dsh = valueAt(argv, index += 1, token)
    else if (token.startsWith('--dsh=')) options.dsh = token.slice('--dsh='.length)
    else if (token === '--uninstall') options.uninstall = true
    else if (token === '--dry-run') options.dryRun = true
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`unknown argument: ${token}`)
  }
  return options
}

/** @type {ReturnType<typeof parseArgs>} */
let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`dsh-notify-long: ${error.message}`)
  console.error('dsh-notify-long: run with --help for usage')
  process.exit(1)
}
if (options.help) {
  console.log(`Usage: node scripts/install.mjs [--profile web] [--uninstall] [--dry-run] [--dsh <path>]

  --profile, -p   dsh profile to install into (default: web)
  --uninstall     remove the dependency, and with it the bundle layer
  --dry-run       print the command that would run, without running it
  --dsh           the dsh executable to use (default: $DSH_BIN, then "dsh")

Equivalent, without this wrapper:
  dsh plugin --profile ${options.profile} add ${repo}`)
  process.exit(0)
}

if (options.profile === '' || options.profile.includes('/') || options.profile === '.' || options.profile === '..') {
  console.error(`dsh-notify-long: invalid profile name: ${JSON.stringify(options.profile)}`)
  process.exit(1)
}

const args = ['plugin', '--profile', options.profile, options.uninstall ? 'remove' : 'add', options.uninstall ? pluginName : repo]

if (options.dryRun) {
  console.log(`${options.dsh} ${args.join(' ')}`)
  console.log('\ndry run: nothing was written')
  process.exit(0)
}

const result = spawnSync(options.dsh, args, { stdio: 'inherit', shell: process.platform === 'win32' })
if (result.error !== undefined) {
  const hint = result.error.code === 'ENOENT'
    ? `${options.dsh} not found on PATH — pass --dsh <path>, or run the equivalent by hand:\n  dsh plugin --profile ${options.profile} ${options.uninstall ? 'remove ' + pluginName : 'add ' + repo}`
    : String(result.error)
  console.error(`dsh-notify-long: could not run ${options.dsh}: ${hint}`)
  process.exit(1)
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

if (options.uninstall) {
  console.log(`\ndsh-notify-long is no longer a dependency of profile "${options.profile}"; restart it to unload the plugin.`)
  process.exit(0)
}

// Nothing to link: the two packages this plugin imports ship with dsh, and the
// launcher's profile resolution serves them from the running installation.
// `node scripts/link-harness-deps.mjs` is only for running this repository's
// tests under plain Node.
console.log(`\nRestart the profile to load the plugin:  ${options.dsh} --profile ${options.profile}`)

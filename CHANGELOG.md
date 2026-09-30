# Changelog

Notable changes to `dsh-notify-long`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A retried model request is now an alert of its own** (`retry`, on by
  default). `llm/retry` — the event the chat card renders as "waiting to retry
  the model request" — carries the provider failure and the delay the harness is
  about to wait, and both are quoted in the alert, together with where the
  attempt sits in its chain (`attempt 2 of 5 · provider: deepseek`). A flapping
  connection is otherwise invisible: the retry usually succeeds, the turn
  finishes, and the completion alert looks perfectly healthy.
- The alert is raised on the *scheduled* retry, not on `llm/retry-started` (the
  same retry a moment later), so one retry is one alert — and it shares the
  per-failure fingerprint cooldown with repeated failures, so a network that
  keeps dropping mails once per window rather than once per attempt. The retry
  fingerprint is a distinct key from the terminal error's, so a turn that gives
  up after its retries still alerts as an error.
- Switch it off or quiet it like any other kind:
  `alerts.kinds.retry.enabled: false`, or
  `retry: { enabled: true, channels: [email] }` to keep the news without the
  tone. `retry` is the chattiest kind on an unreliable network.

### Changed

- **The harness peers are imported the official way** (DSH 0.2 *profile
  resolution*). `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` are
  static imports declared as required `peerDependencies`, and the literal
  `defineTool` fallback is gone. A dsh launcher computes one runtime resolution
  per process and routes a linked plugin's peer-named imports to the running
  installation's own copy, so a `link:` install resolves both without anything
  being linked into this checkout — while a physical copy beside the source
  would *outrank* that routing and shadow the runtime's copy. Consequently
  `scripts/install.mjs` no longer links peers, and
  `dsh plugin --profile <p> add <this package>` is the whole install.
- The packages only the tests import — `@deepseek-ai/dsh-settings`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-connection`,
  `@deepseek-ai/dsh-user-questions`, `@deepseek-ai/dsh-llm-retry` — moved from
  `peerDependencies` to `devDependencies`. `peerDependencies` now names exactly
  what `src/` imports from the runtime.
- An install that cannot resolve the peers now fails its row instead of running
  with row validation off and literal tool definitions; the `notify_*` tools are
  always built by `defineTool`.

### Internal

- `test/retry-contract.test.js` drives the real `@deepseek-ai/dsh-llm-retry`
  policy and alerts on the payload it actually appends, so a harness upgrade that
  renames the event or moves a field fails the suite instead of going quiet in
  production. `dsh-llm-retry` joins the peers `scripts/link-harness-deps.mjs`
  links (186 tests).

## [0.2.0] — 2026-09-29

Compatibility release for **DSH 0.2.0-rc.1**. The 0.1.x line targets
0.1.5-rc.1 and is refused by the 0.2 runtime: the profile loader compares a
bundle's `peerDependencies` against the running harness and skips the whole
bundle — host half and browser half together — when a `@deepseek-ai/dsh-*`
range does not match, which is what made the plugin disappear from the profile
and show as *incompatible* in the plugin list.

Installing this version is the fix. Nothing changes about the alerts
themselves; what changed is the two APIs the plugin's configuration page is
built on, both removed in 0.2.

### Changed

- **Breaking: the plugin now requires DSH 0.2.0-rc.1.** The `@deepseek-ai/dsh-*`
  peers move from `^0.1.5-rc.1` to `^0.2.0-rc.1`, so 0.1.x harnesses will
  refuse this version in turn. There is no build that satisfies both: the
  settings APIs the two releases expose do not overlap.
- **The settings integration is now declared, not installed.**
  `ctx.settings.installSection()` is gone in 0.2. A plugin marks the Config
  fields it may change while the harness runs with `.volatile()`, and that mark
  *is* the registration: `@deepseek-ai/dsh-settings` serves a form for exactly
  the entries that have at least one, and a save rewrites the reference the
  Loader handed `apply` rather than re-mounting the plugin. The host half reads
  its config through those references on every use, so a save still takes effect
  without a restart, and `settings.configure({ auto: false }, ctx.fiber)`
  declines the harness's schema-generated page because this plugin draws its own.
- **The page moved to the Plugins screen.** The client service `settingsScope`
  and the `settings.plugin.item` slot were both removed. The browser half now
  binds its entry through `ctx.configForms` and registers into `plugins.item`,
  inside `configForms.whileServed(...)` so the entry withdraws itself when the
  host stops serving it instead of leaving a dead page behind. It renders the
  one-liner for the list and the form for the page, as that slot asks.
- **Where a save lands.** Editable values live in the `dsh-notify-long` row's
  `config` in the active profile's patch, written through the configuration
  editor's revision-fenced path. `~/.dsh/settings.yaml` is no longer written:
  0.2 imports it once at startup and renames it, so the README now documents the
  profile-patch shape instead.
- The durable state directory is resolved from `ctx.profileContext.home`, which
  replaced the `paths` service in 0.2. An upgraded deployment keeps reading the
  outbox and activity log it already wrote.

### Internal

- The test harness links its peers from the `dsh` on `PATH` and re-links when a
  linked version no longer satisfies `peerDependencies`. It used to re-link only
  when a peer failed to *resolve*, which let a DSH upgrade leave the old links in
  place while the whole suite kept validating the previous release's API — the
  exact failure this release exists to fix (194 tests).
- `test/settings-section.test.js` checks the card's write paths against the
  host's own `volatileForm` and `isVolatilePath`, so a field the card edits but
  the schema does not serve fails the suite rather than producing a control that
  always errors.
- `test/mount.test.js` resolves the real Config schema through Cordis's
  `resolveConfig` and drives a save through the reference the Loader would hand
  over, covering the volatile round trip without a browser.

## [0.1.1] — 2026-09-16

First release on npm (`npm install`-able, not just a GitHub checkout).

### Fixed

- **Question alerts no longer depend on listener order.** A question raised by a
  turn used to replace that turn's completion alert only when the question was
  observed before the turn was classified. The two paths are now independent, so
  a turn that asks something always alerts as a question and never as a
  completion.
- **`Config` is only exported when it is a real schema.** Without
  `@deepseek-ai/schemastery` resolvable, the package exported a non-schema value
  under the name `Config`, which Cordis would treat as a row schema. It is now
  exported as `undefined`, so an unvalidated row is skipped instead of
  mis-parsed; `defaultsFor` and `default` still describe the documented defaults.

### Changed

- Distribution is now npm-first: `dsh plugin --profile web add dsh-notify-long`.
  A `git clone` + `link:` install still works and is documented as the
  source-editing path.
- Installing from npm needs no peer-linking step — the package lands inside the
  profile as a real directory, so Node resolves `@deepseek-ai/schemastery` and
  `@deepseek-ai/dsh-tools` from the harness packages one level above it. Only a
  `link:` install into a checkout needs `scripts/link-harness-deps.mjs`.
- The published tree carries no local or personal leftovers; `npm pack` ships
  31 files with no tests and no `node_modules`.

### Internal

- Replaced the old patch tests with integration tests that mount the real plugin
  against the real Connection channel and the real user-question service
  (173 tests).

## [0.1.0] — 2026-09-12

Initial release, distributed as source on GitHub.

- System sound, desktop banner and email alerts when a turn finishes, fails, or
  needs your input (question / approval request).
- Zero runtime dependencies — Node built-ins only, with a hand-written SMTP
  client (EHLO, STARTTLS, AUTH PLAIN/LOGIN/CRAM-MD5, MAIL, RCPT, DATA).
- Durable outbox: every alert is persisted before any channel is contacted, then
  retried with backoff and resumed after a restart.
- Suppression: per-event deduplication, per-fingerprint error cooldown, sound
  burst collapsing, and quiet hours (email still goes out).
- Live configuration through the settings card, with an activity log and a
  **Send test** button.
- `notify_*` tools the model can call, plus `notify_status`, `notify_test` and
  `notify_flush` for the operator.

[0.1.1]: https://github.com/ddxl123/dsh-notify-long/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ddxl123/dsh-notify-long/releases/tag/v0.1.0

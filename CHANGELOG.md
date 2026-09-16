# Changelog

Notable changes to `dsh-notify-long`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

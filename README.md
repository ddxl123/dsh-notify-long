# dsh-notify-long

[简体中文](README.zh.md) | English

[![npm](https://img.shields.io/npm/v/dsh-notify-long?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-notify-long)
[![release](https://img.shields.io/github/v/release/ddxl123/dsh-notify-long?label=release&color=blue)](https://github.com/ddxl123/dsh-notify-long/releases)
[![test](https://img.shields.io/badge/tests-186%20passing-brightgreen)](https://github.com/ddxl123/dsh-notify-long)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Give [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) an ear and a phone line: **when a task finishes, fails, or needs your answer, you get a system sound, a desktop banner, and an email** — no more babysitting the terminal.

```
task finished   →  🔔 sound + banner + email  "Finished: nightly build"
needs a choice  →  🔔 a different sound + email  "Needs your input: which database?"
failure         →  🔔 alert tone + email  "Error: model route exploded …"
model retry     →  🔔 warning tone + email  "Retrying model request: nightly build"
approval needed →  🔔 sound + email  "Approval needed: bash"
```

- **Zero runtime dependencies** — Node built-ins only, with its own SMTP client. No `nodemailer`, no transitive tree.
- **Zero build step** — plain JavaScript ESM; install it from npm, or clone it and install it into a profile.
- **Nothing gets lost** — every alert is written to a durable outbox before any channel is contacted, then retried with backoff and resumed after a restart.
- **Not noisy** — per-event deduplication, per-fingerprint error cooldown, sound burst collapsing, and quiet hours (email still goes out).
- **Adjustable live** — channel routing, the mailbox and the alert language are declared `.volatile()`, so the plugin's own page edits them while the harness runs and the next alert uses the new value; no restart, no remount.
- **Simple to configure** — the settings card asks for a QQ mailbox and its authorization code; the server, the sender and the recipient all follow from that.
- **You can see what happened** — the same card carries an activity log: every delivery, suppression, retry and plugin log line, plus a **Send test** button.

---

## Contents

- [Install](#install)
- [Configure](#configure)
- [The card's activity log](#the-cards-activity-log)
- [What triggers an alert](#what-triggers-an-alert)
- [Tools the model can call](#tools-the-model-can-call)
- [Full configuration reference](#full-configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Design notes](#design-notes)

---

## Install

Requires Node.js ≥ 20.11 and a working `dsh` (this plugin targets the web profile — the GUI you are probably reading this in).

> Published on npm as [`dsh-notify-long`](https://www.npmjs.com/package/dsh-notify-long) and distributed as source on GitHub.

This package declares `dsh.bundle.patch`, so it installs like any other profile plugin:

```bash
dsh plugin --profile web add dsh-notify-long
```

That is the whole install — no build step and no runtime dependencies. The harness peers this package imports are already reachable one level above the profile, so nothing else is required; see ["Harness peers"](#harness-peers) for the one case that differs.

To work from a checkout instead, clone it and add the path (`link:`, which needs the extra peer step below):

```bash
git clone https://github.com/ddxl123/dsh-notify-long.git
cd dsh-notify-long
dsh plugin --profile web add .
node scripts/link-harness-deps.mjs     # see "Harness peers" below
```

`dsh plugin` runs pnpm in the profile directory and then appends this package to
`dsh.profile.bundles`, which is what puts the plugin row in this repository's
`cordis.patch.yml` onto the profile's layer stack. No profile file is edited by
hand, so installing twice changes nothing.

Then **restart the profile**:

```bash
dsh --profile web
```

> Restart, not reload: `cordis.patch.yml` is hot-reloaded, but a newly added plugin *package* has to be imported by the process before it can register its tools. Configuration changes afterwards do not need one.

To undo it, removing the dependency removes the layer with it:

```bash
dsh plugin --profile web remove dsh-notify-long
```

> **`add .` means this checkout.** `dsh plugin` anchors a relative path to the directory you invoke it from, so it resolves to the repository, not the profile. An absolute path works identically:
> `dsh plugin --profile web add /path/to/dsh-notify-long`.
>
> For another profile (`headless`, …) pass its name. `node scripts/install.mjs` runs both commands above in one step; `--dry-run` previews it and `--uninstall` reverses it.

### Harness peers

`@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` are **peer dependencies**: they belong to your harness installation, not to this package. Node resolves a package's bare imports from its **real** path, following symlinks, so whether they are found depends on how the plugin was installed:

| Install | Peers resolve? | What to do |
| --- | --- | --- |
| `dsh plugin --profile web add dsh-notify-long` (npm) | yes — the package is a real directory inside the profile, and Node walks up to the harness packages one level above it | nothing |
| `git clone` + `add .` (a `link:` symlink into your checkout) | no — resolution starts from the checkout, outside the profile tree | run the link script once |

So only a checkout install needs the extra step:

```bash
node scripts/link-harness-deps.mjs                        # finds your harness automatically
node scripts/link-harness-deps.mjs --from /path/to/node_modules
```

It is safe to re-run, and says so when they already resolve. pnpm runs no lifecycle scripts for a local `link:` dependency, which is why the npm install has nothing to do here and the checkout install does.

Without them the plugin still loads, and only two things change: the composition row goes unvalidated (the documented defaults still apply), and the `notify_*` tools use plain definitions instead of `defineTool`. The same step links the peers that only tests import — `@deepseek-ai/dsh-settings` (the settings contract), and `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-connection` and `@deepseek-ai/dsh-user-questions` (the integration tests that mount the real plugin against the real Connection and user-question services). At runtime those services are injected by the running harness, never imported.

## Configure

Configuration resolves in layers, later wins:

| Layer | Where | Use it for |
| --- | --- | --- |
| Composition row | the row in this package's `cordis.patch.yml`, overridable from `~/.dsh/profiles/web/cordis.patch.yml` | Install-time defaults |
| Live config entry | the `dsh-notify-long` row's `config` in `~/.dsh/profiles/web/cordis.patch.yml`, written by the settings page | Day-to-day changes, applied on save |
| Environment | `DSH_SMTP_PASSWORD`, … | Secrets only |

### 1. In the GUI (recommended)

The plugin ships a browser half, so its page appears in the app you are reading this in:

**Plugins** in the sidebar → **QQ mailbox notifications** (the page lists one entry per configurable plugin; the entry and the form follow the interface language).

The form asks for three things — a **QQ mailbox address**, its **authorization code**, and (optionally) a **recipient** — because that is the whole configuration:

- the address alone selects the QQ provider preset (`smtp.qq.com:465`, implicit TLS) and becomes the sender;
- an empty recipient means "mail me": the alert goes to the address you typed;
- a bare QQ number works too, and is expanded to `<number>@qq.com`.

Save writes the `config` of the plugin's own row in the active profile's patch — through the configuration editor's revision-fenced write path — so it is the same document the YAML route below edits by hand, and neither needs a restart. Everything else (host, port, transport, certificate policy, Cc, subject prefix, the password environment variable and keychain command) still exists, folded into the form's collapsed **Advanced** disclosure.

Two things worth knowing:

- the card **stages** edits and writes them on Save, so nothing is committed as you type;
- the authorization code is a **write-only** control: the host never sends a `role('secret')` value to the browser, so the field always renders blank, writes only when you type something, and reports "configured" / "not configured" from a schema sidecar. **Clear authorization code** removes the stored literal.

Where the code comes from: QQ Mail → **Settings → Account → IMAP/SMTP service** → enable it → **generate an authorization code**. It is 16 characters and it is *not* your QQ password.

Only the switches that decide whether anything is sent at all (`enabled`, `alerts.channels`, `email.enabled`) sit next to those three fields; `quietHours`, per-kind switches, sound names and the outbox stay in the YAML below.

### 2. Email by hand (profile patch)

The page is the easy path; the same values written by hand go in the entry the bundle patch inserts, under `config:`. Patches replace a row's whole `config`, so restate every key you need:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-notify-long
  name: dsh-notify-long
  config:
    language: auto                     # alert language: auto | zh | en (auto follows the system)
    email:
      user: 123456789@qq.com          # a QQ address (or a bare QQ number) selects the QQ preset
      pass: "your-authorization-code"  # or leave this out and export DSH_SMTP_PASSWORD
      # to: [you@example.com]          # optional: empty means "mail the account above"
```

A profile patch replaces ordinary configuration but not a live one: `enabled`, `language`, `alerts.channels` and the `email.*` fields above are the ones the settings page owns, so leave them to the page (or to this patch — both write the same entry).

Every alert a human reads — subject, body, banner title, test alert — is rendered in that language. `auto` (the shipped default) follows the operating system: `Intl` first, then `LANG`/`LC_ALL`, and anything that is not a Chinese locale renders English. An **unset** `language` means English rather than "detect", so a library caller never gets machine-dependent output.

The QQ preset is inferred whenever the account is a QQ address (or a bare QQ number) and neither `preset` nor `host` is configured, and `from` / `to` then default to that account — which is why the block above is complete. Naming another provider still works, and an explicit value always wins:

```yaml
- id: dsh-notify-long
  name: dsh-notify-long
  config:
    email:
      preset: gmail              # fills in host / port / transport, see the list below
      user: you@gmail.com        # login account
      from: "DSH <you@gmail.com>"
      to: [you@gmail.com]        # one or more recipients
```

`preset` accepts `qq`, `qq-exmail`, `163`, `163-enterprise`, `aliyun`, `gmail`, `outlook`, `office365`, `icloud`, `zoho`, `yahoo`, `sendgrid`, `mailgun`, `resend`, `brevo`.
Without a preset, set `host` / `port` / `tls` yourself (`implicit` = TLS from the first byte, port 465; `starttls` = upgrade, port 587; `plain` = cleartext).

Provider gotchas:

- **QQ / 163 mail require an app-specific SMTP code**, not your login password — enable SMTP in the mailbox settings and generate one.
- Gmail needs an App Password; your account password is rejected.
- A dead port falls back to 465 / 587 / 25 automatically (`allowPortFallback: false` disables that).
- `requireTls: true` by default: credentials are never sent over a cleartext link.

### 3. Where the password lives

Resolved in this order — **never commit it**:

```bash
# 1. environment variable (recommended)
export DSH_SMTP_PASSWORD='your-app-password'

# 2. a literal in the composition/settings document (convenient, but plain text)
#    email: { pass: "…" }

# 3. a command whose stdout is the secret (Keychain / pass / 1Password CLI)
#    email: { passCommand: "security find-generic-password -s dsh-smtp -w" }
```

The bundled CLI uses the same layers, so you can verify before restarting:

```bash
node scripts/test-alert.mjs --channel email
node scripts/test-alert.mjs --channel sound --kind error   # audition the failure tone
node scripts/test-alert.mjs --channel sound --kind retry   # …and the retry tone
```

### 4. Verify

In the card, press **Send test**: every configured channel reports its own result (`sound: played (afplay)`, `email: sent (250 queued as …)`), and the outcome is written to the activity log next to it.

Or ask the agent:

> Run notify_status to check the alert setup, then notify_test against every channel.

`notify_status` reports which channels are active, whether email is usable (host/port/sender only — **never the password**), quiet hours, how many alerts are queued, and the five newest activity lines.

### 5. Quiet hours and per-event switches

```yaml
# every value below goes under `config:` in the `dsh-notify-long` row (see "Email by hand")
quietHours:
  start: '23:00'
  end: '07:00'      # inside the window: no sound, no banner, email still sent
alerts:
  channels: [sound, desktop, email]
  kinds:
    completed: { enabled: true }
    question:  { enabled: true, channels: [sound, desktop, email] }  # per-kind override
    error:     { enabled: true }
    retry:     { enabled: true }    # a model request was retried (a flapping connection)
    subagent:  { enabled: false }   # child agents are opt-in (they are chatty)
sound:
  perKind:
    completed: Glass
    error: Basso
    question: Ping
desktop:
  titlePrefix: "[dsh]"   # useful when you run several machines
  sound: none            # banner sound; turn it off when the sound channel already plays
```

## The card's activity log

Configuration cannot answer "did last night's alert actually arrive?", so the card carries a second, read-mostly wire and shows the answer under the form:

- a status line — whether mail is ready, where it goes, how deep the queue is, and when the last delivery succeeded or failed;
- one entry per event: `delivered`, `failed` (with the per-channel reason), `queued` (a retry was scheduled), `skipped` (deduplicated, quiet hours, disabled) and `dropped` (gave up) — plus the plugin's own log lines;
- **Send test** fires a test alert over every configured channel and prints each result; **Retry queue** re-attempts everything the durable outbox is holding; **Clear log** empties the panel.

The panel posts to one exact route, `/api/dsh-notify-long`, which the host half registers on Connection's authenticated `/api` channel when the composition provides `connection`. A deployment without it shows a single line saying the log is unavailable, and the form keeps working. History is durable (`~/.dsh/dsh-notify-long/activity.json`, atomic writes like the outbox) and bounded to the newest 300 entries or one week, whichever comes first. It never contains a secret: configuration values are reported as their *source* (`env:DSH_SMTP_PASSWORD`), never as their value.

## What triggers an alert

| Event | Fires when | Default channels | Contents |
| --- | --- | --- | --- |
| `completed` | a turn that ran work ends and the session goes idle | all | last assistant reply plus tool-call, failure, and turn counts |
| `question` | the agent calls `ask_user_question` (including plan review) | all | the questions and their options |
| `approval` | an action needs your permission | all | tool name and reason |
| `error` | a turn/step failed, or a session-level error | all | the failure message and code, cooled down per fingerprint |
| `retry` | a model request failed and the harness is retrying it | all | failure reason, retry delay and attempt number, cooled down per failure family |
| `subagent` | a child agent settled (off by default) | off | the child's final output |
| `manual` | the model calls `notify_user` | all | your own title and body |
| `test` | `notify_test` self-check | all | per-channel results |

Decision details — each of these is asserted in `test/triggers.test.js`:

- **A question always reaches you.** `user-questions/request` is a Cordis *waterfall*: the first listener that returns an answer claims the request and the rest of the chain never runs — and the browser UI is such an answerer. The plugin registers its observer with `prepend`, so "you are told" holds no matter who else is listening or in what order they registered, and it always delegates with `next()` so the request still reaches the UI. A question the harness sends without an agent identity still alerts.
- **One alert per turn.** If the turn already alerted for a question, approval, or error, the idle transition does not add a "finished" notice.
- **A failure is announced once.** The `agent/error` observer alerts the moment it sees the failure, and the idle assessment that follows reads the same cooldown key, so one failure never mails twice.
- **A failed turn is never "finished".** If a turn ended in failure without an observed error event, the idle assessment still reports it as a failure.
- **A retry is news, even though the harness recovers.** `llm/retry` is appended the moment a model request fails and another attempt is scheduled — the same moment the chat card shows "waiting to retry", with the failure reason and the delay. The alert quotes both, plus where the attempt sits in its chain (`attempt 2 of 5 · provider: deepseek`). It fires on the *scheduled* retry, not on `llm/retry-started` (the same retry a moment later), so one retry is one alert. Recovering does not swallow the turn: a session that retried and then finished alerts twice — once for the retry, once for "task finished".
- **A flapping connection does not mail once per attempt.** Retries of the same failure family share a fingerprint, so they cool down exactly like repeated failures do; a different failure (a rate limit after a connection error) is a different family and still alerts.
- **A retry never silences the failure it preceded.** The retry fingerprint is a distinct key from the terminal error's, so a turn that gives up after three attempts alerts as a retry *and* as an error.
- **Workless turns are skipped.** A turn that entered no step, made no tool call and produced no reply — empty input, an immediately cancelled turn — is not announced, and neither is a session that merely toggled status (a cold or resumed one).
- **A cancelled turn that ran work is announced.** Cancellation after real work is news; cancellation before it is not.
- **Child sessions do not nag.** A subagent child is not a "task finished" unless `subagent.enabled` is on.
- **Never blocks the agent.** Delivery happens in the background; a failure is logged and retried, never thrown back into the loop.

## Tools the model can call

| Tool | Purpose |
| --- | --- |
| `notify_user` | Alert you explicitly: title, message, `urgency` (`info` / `action` / `error`), optional `sound`. |
| `notify_test` | Exercise each configured channel and report the real per-channel result. |
| `notify_status` | Report active channels, redacted email readiness, quiet hours, queue depth, this run's success/failure counts, and the five newest activity lines. |
| `notify_flush` | Retry everything waiting in the outbox (for example after fixing a password). |

State lives in `~/.dsh/dsh-notify-long/`: `outbox.json` (atomic writes, removed on success, at most 5 attempts, abandoned after 6 hours) and `activity.json` (the card's log, newest 300 entries).

## Full configuration reference

Every field is optional; defaults are in parentheses.

```yaml
# every value below goes under `config:` in the `dsh-notify-long` row (see "Email by hand")
enabled: true                # master switch
language: auto               # alert language: auto (system) | en | zh

sound:
  enabled: true
  file:                      # global audio file (empty = per-kind default)
  player:                    # afplay (macOS) / paplay, pw-play, aplay, ffplay (Linux)
  perKind: {}                # kind → sound name or file path
  timeoutMs: 10000

desktop:
  enabled: true
  titlePrefix:
  sound:                     # macOS banner sound name; `none` to stay silent

email:
  enabled: true
  preset:                    # qq / gmail / outlook / sendgrid / … (fills host, port, tls;
                             # inferred as qq from a QQ account when unset)
  host:
  port: 465
  tls:                       # implicit | starttls | plain (inferred from the port otherwise)
  user:
  pass:                      # literal secret (not recommended)
  passEnv: DSH_SMTP_PASSWORD # environment variable holding the secret
  passCommand:               # command whose stdout is the secret
  from:                      # defaults to `user`
  to: []                     # defaults to `from` ("mail me")
  cc: []
  subjectPrefix: "[DSH]"
  html: true                 # attach an HTML alternative
  requireTls: true           # never authenticate over cleartext
  verifyCert: true
  preferPlain: true          # prefer AUTH PLAIN, else LOGIN / CRAM-MD5
  allowPortFallback: true    # try 465/587/25 when the configured port fails
  heloName:                  # EHLO name, defaults to this host
  timeoutMs: 20000

quietHours:
  start:                     # 'HH:MM'
  end:                       # 'HH:MM' (midnight wrap handled: 23:00 → 07:00)

alerts:
  channels: [sound, desktop, email]
  dedupeWindowMs: 300000     # same event alerts once per 5 minutes
  errorCooldownMs: 600000    # same failure fingerprint cools down for 10 minutes
  channelCooldownMs: 15000   # sound burst collapse window
  kinds: {}                  # { <kind>: { enabled, channels } }

outbox:
  path:                      # default ~/.dsh/dsh-notify-long/outbox.json
  flushOnStart: true         # deliver anything left over at boot

tools:
  enabled: true              # register the notify_* tools

log:
  delivered: true

debug: false                 # log the state directory and queue recovery
```

## Troubleshooting

**A configuration change did nothing.** The fields the settings page owns (`enabled`, `language`, `alerts.channels`, `email.*`) apply on save; anything else in the row's `config` is ordinary composition configuration and needs a restart. `notify_status` shows what is actually in effect.

**No sound.** `node scripts/test-alert.mjs --channel sound` prints the exact command it runs. macOS needs `/System/Library/Sounds/*.aiff` (shipped); Linux needs one of `paplay` / `pw-play` / `aplay` / `ffplay`; containers and remote hosts usually have no audio device — use email there.

**Email is not arriving.** Open the card's activity log first: it names the failing channel, the server's own reason, and — for an envelope rejection — the exact command it refused (`… for MAIL FROM:<you@qq.com>`). **Send test** reproduces it on demand, and `notify_status` / `notify_flush` report the same thing to the model. To see the whole conversation, run the bundled CLI:

```bash
node scripts/test-alert.mjs --channel email --trace   # the SMTP exchange, credentials redacted
```

Usual causes: a login password instead of an app password, port 465 blocked by a firewall (try `port: 587` with `tls: starttls`), a sender outside the authenticated domain, or a self-signed certificate (`verifyCert: false` temporarily).

**Too many alerts.** Raise `alerts.dedupeWindowMs`, disable `alerts.kinds.subagent.enabled` or `alerts.kinds.retry.enabled` (model retries are the chattiest kind on a flaky network), or set `quietHours`. A retry can be kept but made silent with `retry: { enabled: true, channels: [email] }`.

**Does it slow the agent down?** No: every channel is an async subprocess or socket call with a hard timeout, failures are queued rather than raised, and nothing blocks the turn.

## Development

```bash
npm run link-deps          # link the harness peers so the boot-level tests run
node --test test/          # 186 tests: policy, rendering, SMTP (local fake server), queue, engine,
                           # activity log, card endpoints, message catalogue, boot-level mount,
                           # browser-bundle card, the trigger spec, a real Cordis/Connection
                           # transport integration, and real user-question notifications
node scripts/test-alert.mjs --channel all --json
node scripts/test-alert.mjs --channel email --trace   # SMTP conversation, credentials redacted
```

Layout:

```
src/index.js                 Cordis plugin entry: read services, subscribe, register tools (thin wiring)
client/index.js              Browser half: the Plugins page for the SMTP fields
lib/core/                    Harness-free decisions: policy, text, i18n, event folding, queue, engine, activity log
lib/channels/                The three delivery channels: sound, desktop, email
lib/email/                   Hand-written SMTP client plus RFC 5322 / MIME construction
lib/runtime/handlers.js      Harness events → alert decisions (pure, unit-tested)
lib/runtime/api.js           The settings card's route: status, activity log, test, flush, clear
lib/runtime/selftest.js      One channel self-test shared by `notify_test` and the card's button
cordis.patch.yml             The bundle patch `dsh plugin` puts on the profile's layer stack
scripts/install.mjs          Wrapper: `dsh plugin --profile add` plus the harness-peer link
scripts/link-harness-deps.mjs  Makes the harness peers resolvable from this package
scripts/test-alert.mjs       Channel self-check outside the harness
test/                        Unit tests, a fake SMTP server, a fake-harness mount test, the browser bundle's card
                             tests, the trigger spec, and integration tests against the real harness
                             packages (Connection transport, user-question waterfall, the retry policy)
```

## Design notes

- **Why not a dynamic Cordis plugin?** A dynamic plugin lives in one session's process memory, disappears on restart, and runs under a restricted capability surface. "Tell me when the task is done" must cover every session and survive a restart, so this is a real npm package mounted in the host plane.
- **Why a hand-written SMTP client?** Zero runtime dependencies means no install step and no transitive surprises. The submission subset actually needed (EHLO, STARTTLS, AUTH PLAIN/LOGIN/CRAM-MD5, MAIL, RCPT, DATA) is a few hundred lines, fully covered by tests against a local server.
- **Why write to disk before sending?** An alert is only useful if it arrives. The outbox is written first and the record is removed only after a channel succeeds, so a crash, a reload, or a network drop cannot swallow "your task finished".
- **Why is the log a second wire instead of more settings?** A settings namespace carries configuration, and configuration is all it carries — a card cannot learn from it whether an alert arrived. So the log rides one exact Fetch route the host half registers on Connection's `/api` channel, and the card degrades to "log unavailable" on a deployment that does not provide `connection` rather than failing to render. The route goes through `connection.fetch.register` rather than the more obvious `connection.rpc.handle`: the RPC registry mounts a channel with the *provider's* fiber, where `webServer` is not visible, so `handle()` throws `cannot get property "webServer" without inject` from any consumer plugin and the channel is never mounted.
- **Why infer the QQ preset?** The overwhelmingly common configuration is a QQ mailbox and an authorization code, and asking for `smtp.qq.com`, `465` and `implicit` on top of that is three questions with one answer. The inference only fires when the account is a QQ one *and* the user configured no preset and no host, so an explicit choice is never overwritten.
- **How does a save reach a running plugin?** A field marked `.volatile()` in the Config schema does not arrive in `apply` as a value: the Loader hands over a *reference* (`get()`, rewritten in place on a save), and signing up for that is the whole mechanism. It is also what makes the entry configurable at all — `@deepseek-ai/dsh-settings` serves a form for exactly the entries that have at least one volatile field — and `settings.configure({ auto: false }, ctx.fiber)` declines the schema-generated page because this plugin draws its own. The claim is made from an `inject` child, since the settings service finishes its own async init after this plugin activates, and the plugin reads its composition entry regardless, so a deployment with no settings domain still alerts.
- **Why does the page live on the Plugins screen?** Because that is where a plugin's own configuration belongs in 0.2: the card binds its entry through the client `configForms` service and registers into the `plugins.item` slot, and withdraws itself when the host stops serving the entry rather than leaving a dead page behind.

---

MIT License.

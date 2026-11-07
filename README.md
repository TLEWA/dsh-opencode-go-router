# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

A DeepSeek Harness (DSH) host plugin that gives an OpenCode Go conversation using a DeepSeek-series model a fresh routing id when billion-context compression loses the reusable prompt cache **and** recent requests are slow. With the optional pre-fold patch for billion-context, the switch happens at the next fold rebuild itself, before the rebuilt request is forwarded, so it adds no cache miss of its own. Without the patch the plugin falls back to a request that is already cold (a system-prompt rewrite) or very likely cold (a request after a long idle gap).

This is the npm package for the DSH plugin whose internal id is `opencode-router`. It only rotates the OpenCode Go routing header; it is not a model adapter.

## Why

OpenCode Go pins a conversation to one upstream backend with the `x-opencode-session` request header. After billion-context rebuilds the context, the next request normally warms a new prefix on that same backend. If the first request after a rebuild reports a low cache hit (25% or less by default), and the last few requests are also slow, the backend is probably a bad place for this conversation.

Rotating after that rebuild would add a second cold request: the rebuild's follow-up is cold on the old backend, and the first request on the new backend is cold again. billion-context writes a fold record only after the rebuild request has completed, so a plugin watching the ledger is always one request late. Its proxy, however, knows just before it forwards a rebuild that a fold is happening.

The optional pre-fold patch adds a loopback callback at exactly that point. The plugin publishes a local endpoint with a random bearer token, the proxy asks it whether this session has a pending switch, and if so writes the returned `x-opencode-session` onto the rebuilt request before forwarding it. The rebuild is cold on any backend; with the new route it becomes the first cold request on the new backend instead of being followed by a second one. This is the only reliable way to remove the extra miss, because the ledger cannot provide a pre-request signal.

Without the patch the plugin remembers the decision and applies it just before a request that is going to be cold anyway: a system-prompt rewrite (its prefix changes regardless of the backend), or the first request after `foldDeferIdleMs` of inactivity, when the upstream prefix cache has very likely expired. The decision and the switch can then be separated by several requests; a later healthy fold clears a pending switch.

Only OpenCode Go DeepSeek-series conversations are eligible. Other models are never routed by this plugin, even when a route exists.

A system-prompt rewrite invalidates the reusable prefix by itself. The request that carries the rewrite is cold on any backend, so when such a rewrite is detected and recent requests are slow, the plugin rotates for that same request: the route switch and the rewrite share one unavoidable cache miss. The last fold's cache condition is ignored in this path because its hit rate cannot be healthy after a rewrite; the performance condition still applies. If a fold-triggered switch is already pending, the rewrite consumes it: the route keeps the fold's cache evidence but uses the current performance window, and records `reason: "fold-deferred"`.

If consecutive switches still land on backends that miss the base targets, the plugin widens the next trigger instead of repeating equivalent switches: each completed post-switch window that remains slower than `ttftThresholdMs` or `throughputThresholdTps` adds one step, giving the next decision `stepTtftGraceMs` (2 s by default) more TTFT room and `stepThroughputGraceTps` (5 tok/s by default) less required throughput. A post-switch window that meets the base targets resets the step to zero. Failure is always judged against the base targets, never the already-widened ones.

The plugin does not compress anything itself and does not change the prompt or the conversation log. It only changes one routing header and keeps local timing counters.

## How it works

- **Cache evidence.** It reads billion-context's per-session state file (`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`) and looks at `metadata.cacheLedger.folds`. billion-context derives `conversationId` from the highest-priority conversation header. In a DSH setup that is `x-bili-plugin-conversation` (the DSH session id); `x-opencode-session` ranks below it, so rotating that header does **not** change the file or open a new one. A fold record's `hPct` is the cache-hit percentage of the first request sent after that rebuild.
- **Eligibility.** Only requests from a configured provider (`opencode-go` by default) whose model id starts with `deepseek` (case-insensitive) are considered. `models` can narrow this to exact DeepSeek ids. Other models are ignored, and a rotation is skipped if the latest ordinary conversation request used a non-eligible model. Auxiliary requests that declare a `purpose` do not change that state.
- **Performance evidence.** It wraps `llm/stream` only for eligible requests, timestamps the first content chunk, and records output tokens per second at the finish chunk. It keeps the last `sampleSize` valid samples per DSH session.
- **Decision.** On a new fold, it evaluates the folds *before* that fold. It records a pending switch only when the latest `foldsWindow` fold(s) all have `hPct <= cacheHitThresholdPct` **and** the recent samples are slow (average TTFT `>=` 12000 ms by default, or average throughput `<=` 60 tokens/second by default). The performance target can be widened by the failure step described above. `foldRotationMode: "immediate"` restores the 0.2.1 behavior of rotating at that fold; `"off"` disables fold-triggered switching.
- **Pre-fold hook (optional patch).** When `preFoldHook` is enabled, the plugin listens on a random port bound to `127.0.0.1` and writes a descriptor to `$DSH_HOME/storages/opencode-router/pre-fold-hook.json` with the URL and a random bearer token. The optional patch to billion-context reads that descriptor and calls `POST /pre-fold` right after it has built the rebuilt body and before it forwards that body. The endpoint accepts only loopback POST requests with the token and only consumes an already pending fold decision. If the patch is absent, nothing calls the hook and the plugin falls back to the deferred path below.
- **Applying a switch.** With the pre-fold hook active, the next fold rebuild consumes a pending decision: the plugin rotates the route, returns the new value, and the rebuilt request itself is sent on the new route. Otherwise the plugin applies the pending switch before a request that is already going to be cold: the system-prompt-rewrite path, or the first eligible request after `foldDeferIdleMs` (5 minutes by default) of session inactivity. `foldDeferMaxMs` and `foldDeferMaxRequests` can force a pending switch after a limit; both default to `0` (never force), because forcing without a cold request may recreate the extra miss. A later fold whose evidence is healthy clears the pending switch.
- **System-prompt rewrite.** From `llm/stream` it extracts the initial system prompt the same way pi-ai does (`options.system` plus leading `system` messages) and fingerprints it per session. When the fingerprint changes, it writes a route before the request headers are assembled, so the same request that carries the rewrite also carries the new routing id. This path uses only the performance condition (the fold cache condition is bypassed); without a pending fold switch the route records `reason: "system-rewrite"`. A later fold caused by that rewrite is guarded from rotating a second time for the same miss.
- **Routing.** A persisted route maps the DSH session id to a generated `ses_...` value. The `llm-pi-ai/request-headers` waterfall runs after pi-ai assembles its header set and before the request is sent, so setting `x-opencode-session` there reaches the wire. In the reference setup a companion injector such as `dsh-opencode-ip-guard` supplies a baseline value equal to the DSH session id; when a route exists this plugin replaces it, and the injector's no-overwrite fallback leaves the value alone.
- **No billion-context, no effect.** If the sessions directory or the session state file is absent, the monitor stays idle. The header hook has no route and does nothing. No exception is thrown into DSH.

The first fold seen after a plugin start is a baseline and never causes rotation; this baseline rule applies to the fold path only. A later fold that meets both conditions becomes a **pending** switch rather than an immediate one. The system-prompt-rewrite path is independent of any fold: even when the session has never recorded a fold, a changed system prompt with slow samples can rotate on the rewrite request itself (the fold cache condition is bypassed). The first system prompt seen in a session is only a fingerprint baseline; a rewrite rotation requires a subsequent observed change. The current session is considered eligible only while its latest ordinary conversation request is an OpenCode Go DeepSeek-series request.

A rotation changes only the upstream routing id. billion-context keeps writing the same state file for the DSH session, so the monitor keeps following it; after recording the fold that made a switch pending it advances its fold cursor. The same rebuild cannot make a second switch pending, but a later rebuild can. A pending switch survives ordinary healthy warm requests; it is applied at the next fold rebuild when the pre-fold hook is active, at a request treated as cold (a system-prompt rewrite) or expected to be cold (the first request after a long idle gap) otherwise, forced by a safety valve, or cleared when a later fold no longer meets the cache/performance conditions.

## Requirements

- DSH with the `llm-pi-ai` adapter and an OpenCode Go provider (default `opencode-go`) configured with at least one DeepSeek-series model (model id starts with `deepseek`).
- billion-context installed and actively saving session state.
- Optional but recommended for the exact seam: a billion-context bundle the patch script recognizes. Without the patch the plugin still works with the deferred fallback.
- DSH 0.2.1-rc.5 or newer, below 0.3.0.
- Node.js 20 or newer.

## Install from npm

```bash
dsh plugin add dsh-opencode-go-router --profile <profile>
```

Or add `dsh-opencode-go-router` from the DSH plugin manager's add-plugin box. The package declares `dsh.bundle.patch`, so a normal install creates the `opencode-router` row; do not add a separate profile row for it.

## Pre-fold patch (optional)

The patch is what makes the rebuild request itself use the new route. It edits billion-context's bundled proxy, so npm install does not and should not apply it automatically. Run it once per billion-context installation, then restart or reload the billion-context proxy process.

From the DSH profile directory:

```bash
cd "$DSH_HOME/profiles/<profile>"
node node_modules/dsh-opencode-go-router/scripts/patch-billion-context.mjs --check
node node_modules/dsh-opencode-go-router/scripts/patch-billion-context.mjs --apply
```

From this repository:

```bash
node scripts/patch-billion-context.mjs --check
node scripts/patch-billion-context.mjs --apply
```

The script searches every profile under `$DSH_HOME/profiles/*/node_modules/billion-context/dist/index.js`; use `--file <path>` or `--profile <name>` to narrow it. `--check` exits `0` when already patched, `1` when unpatched, and `4` when the bundle has no unique `outbound=rebuilt;` anchor and is therefore unsupported. `--apply` keeps a `.opencode-router.bak` next to the bundle and is idempotent. `--revert` restores that backup. A billion-context upgrade replaces `dist/index.js`, so re-run `--check` and `--apply` after upgrading.

The patched proxy calls only the loopback URL and bearer token in the plugin's descriptor. If the plugin is disabled or the descriptor is missing, the callback quietly does nothing and the request follows the unpatched path.

## Install from a local checkout (development)

1. Keep this repository somewhere stable, for example `C:/Users/me/DSHs/opencode-router`.
2. In the profile's `package.json`:
   - add `dsh-opencode-go-router` to `dsh.profile.bundles`;
   - add `"dsh-opencode-go-router": "link:C:/Users/me/DSHs/opencode-router"` to `dependencies`.
3. Make the profile's `node_modules/dsh-opencode-go-router` point at the repository (a directory junction/symlink is enough on Windows).
4. Do **not** add a standalone row for this plugin to the profile's `cordis.patch.yml`. The package declares `dsh.bundle.patch: ./cordis.patch.yml`, which inserts the plugin row itself. A profile row added without an `insert` is only an override and cannot create the row.
5. Restart DSH. In the plugin manager, `dsh-opencode-go-router` should appear as a profile bundle with one row (`include:opencode-router`). If the host was already running before the bundle declaration existed, reload it through the plugin manager or restart DSH.
6. Read the live state at `http://127.0.0.1:<DSH-web-port>/opencode-router/status`.

To change defaults, add an override by row id to the profile's `cordis.patch.yml`:

```yaml
- id: opencode-router
  config:
    cacheHitThresholdPct: 25
```

Because the plugin entry point reloads `lib/impl.js` with a cache-busting query on every `apply`, editing the implementation and touching the plugin config is usually enough to try new code. In a running host, toggling the profile bundle off and on through the plugin manager also reloads the static imports (`lib/core.js`, `lib/store.js`, `lib/monitor.js`); the 0.1.2 -> 0.1.3 threshold change was verified that way. If the host keeps reporting the old version, restart DSH.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false, hooks pass through and the monitor does not run. |
| `providers` | `["opencode-go"]` | Providers eligible for routing; the model must still be a `deepseek*` id. |
| `models` | `[]` | Optional exact DeepSeek model allow-list; empty means any `deepseek*` model of the provider. |
| `cacheHitThresholdPct` | `25` | A fold counts as "cache lost" when `hPct <= this`. Not applied to a system-prompt rewrite rotation. |
| `systemRewriteBypassCache` | `true` | Rotate on a system-prompt change even when the last fold's cache hit is healthy; the performance condition must still be slow. |
| `foldsWindow` | `1` | How many recent folds must all be below the cache threshold. |
| `foldRotationMode` | `"defer"` | `defer` applies a fold-triggered switch only before a request that is already cold; `immediate` rotates right after the fold (0.2.1 behavior); `off` disables fold-triggered switches (system-prompt rewrites still rotate). |
| `foldDeferIdleMs` | `300000` | In `defer` mode, rotate before the first eligible request after this much session idle time. `0` disables the idle trigger. |
| `foldDeferMaxMs` | `0` | Force a pending switch once it is this old. `0` disables the safety valve. |
| `foldDeferMaxRequests` | `0` | Force a pending switch before the request after this many eligible requests have gone out. `0` disables the safety valve. |
| `preFoldHook` | `true` | Serve the loopback `POST /pre-fold` endpoint used by the optional billion-context patch. `false` disables the seam and leaves only the deferred path. |
| `preFoldHookPath` | `$DSH_HOME/storages/opencode-router/pre-fold-hook.json` | Descriptor file written for the patched proxy. Override only when the proxy reads it from a custom path. |
| `ttftThresholdMs` | `12000` | Base average time to first content token at or above this is slow. |
| `throughputThresholdTps` | `60` | Base average output tokens/second at or below this is slow. |
| `stepTtftGraceMs` | `2000` | Each consecutive failed switch widens the next TTFT target by this much. |
| `stepThroughputGraceTps` | `5` | Each consecutive failed switch lowers the next throughput target by this much (floor `0.01`). |
| `sampleSize` | `5` | Number of recent requests used for the performance decision. |
| `requireFullSamples` | `true` | Require all `sampleSize` samples before rotating. |
| `routingIdPrefix` | `"ses_"` | Prefix of generated routing ids. |
| `statePath` | `$DSH_HOME/storages/opencode-router/state.json` | Persisted routes and timing samples. |
| `dryRun` | `false` | Log rotations without selecting the new header value. |
| `debug` | `false` | Extra info logs. |
| `overrideExistingHeader` | `true` | Replace an already present `x-opencode-session`. Set false to preserve it. |
| `pollIntervalMs` | `2000` | Poll interval while a session is active. |
| `requestCheckDelaysMs` | `[400, 1500]` | Extra state-file checks after a request finishes. |
| `biliSessionsDir` | `null` | Override billion-context's sessions root. |
| `biliProtocol` | `"openai"` | State subdirectory. |
| `biliUpstreamHost` | `"opencode.ai"` | Host label used in the state filename. |
| `maxSamples` | `20` | Maximum samples kept per session. |
| `sessionActiveMs` | `600000` | Stop polling a session after this idle time. |
| `minRotationGapMs` | `0` | Minimum time between rotations for one session. |

## Status route

`GET /opencode-router/status` returns JSON with the effective config, persisted routes, rotation history, and per-session monitor state:

- `history` — recent silent switches, newest first, with `sessionId`, `at`, `reason`, `foldSeq`, `cacheHitPct`, `step`, the routing `value`, before/after TTFT and throughput, sample progress, and a `backfilled` marker; a deferred fold switch records `reason: "fold-deferred"`, and one applied by the pre-fold hook records `reason: "fold-preflight"`;
- `eligibility` — the configured providers and the fixed `deepseek` model prefix;
- `baselineReady` and `lastFoldSeq` — fold cursor;
- `latestFold` — latest fold record (including `hPct`);
- `watchingId` — DSH session id whose billion-context state file is being followed;
- `route` — current rotated routing id, or `null`; its `reason` is `cache-and-performance`, `fold-deferred`, `fold-preflight`, or `system-rewrite`, and `step` is the failure step used for that switch;
- `targetActive` — whether the latest ordinary conversation request was an eligible OpenCode Go DeepSeek request; `false` blocks rotation;
- `systemPromptFp` — fingerprint of the latest observed initial system prompt, or `null`;
- `systemRewriteBypassCache`, `systemRewriteRotations`, `lastSystemRewriteAt` — rewrite-rotation settings and counters;
- `foldRotationMode`, `pendingRotation`, `deferredRotations`, `lastDeferredAt` — fold-switch mode, the pending switch (age, fold number, cache hit, step, requests seen, and trigger averages), how many pending switches have been created, and when the latest one was created;
- `preFoldHook` — loopback endpoint state: `enabled`, `listening`, `path`, `url`, `port`, request/rejection/rotation counters, `lastRequestAt`, `lastError`, and `lastDecision`;
- `preflightRotations`, `lastPreflightAt` — switches consumed by the pre-fold hook and when the latest one happened;
- `stepping` — `step`, `consecutiveFailures`, base and effective TTFT/throughput thresholds, and the per-step grace values;
- `samples` — count, average TTFT, average throughput;
- `rotations`, `lastRequestAt`, `lastTickAt`, `lastError`;
- `routing` — header-hook counters and the latest decision: `checks`, `applications`, `lastCheckedAt`, `lastCheckedSessionId`, `lastAppliedAt`, `lastAppliedSessionId`, `lastAppliedValue`, `lastReason`. `lastReason` is `applied`, `no-route`, `existing-header`, `no-headers`, `disabled`, or `not-target`.

The route is localhost-only when the host's web server is bound to localhost. Treat the JSON as diagnostics.

## Settings page

In the DSH Web client, open the plugin manager and select this bundle. Its detail page renders a **Silent switch performance log** above the bundle configuration rows.

For each silent switch it shows the time, a short session id, the trigger (`Fold + speed`, including a deferred fold switch, `Fold rebuild seam` for a pre-fold switch, or `System rewrite`), the fold number and cache hit behind the decision, the failure step if it was above zero, average TTFT and throughput before the switch, the first `sampleSize` eligible samples after it, and the percentage change. The header also shows the most recently active session's step and effective thresholds, and the panel explains the per-step grace. Rows refresh every five seconds from `GET /opencode-router/status`. The after window is frozen once it has `sampleSize` samples, so later traffic does not rewrite history.

Routes created before 0.2.0 are backfilled as one row per still-known route and marked `Reconstructed`; their after values come from samples retained after that rotation. The panel lives in the Web client and does not affect host routing.

## Privacy and safety

- Stored data is limited to DSH session ids, generated routing ids, fold numbers, cache percentages, TTFT, throughput, rotation history, and timestamps. No prompts, messages, tool output, or API keys are stored.
- Every host callback catches its own errors. A missing or malformed billion-context state file only produces a log entry.
- The pre-fold endpoint binds only to `127.0.0.1`, accepts only POST, and requires a 32-byte random bearer token from the descriptor. The descriptor is written with user-only permissions where the platform supports them and is removed on dispose. The patch refuses any callback URL that is not loopback HTTP.
- Rotating a header is a routing hint, not a guarantee that the gateway picks a different physical backend. If the gateway ignores unknown or new session values, the plugin cannot force a move.
- billion-context's state file is an internal format. If its layout changes, the monitor may see no folds and stay idle; the plugin will not corrupt anything.

## Development

```bash
node --test
```

The suite covers fold parsing, the cache/performance decision, the consecutive-failure stepping rule, deferred fold switches and their safety valves, the pre-fold seam and its loopback endpoint authentication, the billion-context patch idempotency/backup/restore, system-prompt extraction/fingerprinting, the system-rewrite decision, DeepSeek-only eligibility, state persistence, rotation history, the monitor state machine, header routing, stream measurement, and the client bundle registration.

## License

MIT

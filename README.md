# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

A DeepSeek Harness (DSH) host plugin that gives an OpenCode Go conversation using a DeepSeek-series model a fresh routing id when the **next** request is predicted to miss the upstream prompt cache **and** recent requests are slow. The prediction runs before the request is sent, so the switch applies to that very request and does not add a cache miss of its own.

This is the npm package for the DSH plugin whose internal id is `opencode-router`. It only rotates the OpenCode Go routing header; it is not a model adapter.

## Why

OpenCode Go pins a conversation to one upstream backend with the `x-opencode-session` request header, and that backend serves most of a repeated prompt prefix from its cache. The cache is lost when the prefix changes: billion-context compaction rewrites the context, and a system-prompt change rewrites the prompt itself. After a rebuild the rebuild request is cold, but the request right after it is warm again, because the rebuild just cached the new prefix on that backend.

So the only useful moment to move is *before* a request that is going to be cold anyway. This plugin predicts the cache hit of every outgoing eligible request from the signals it has at that moment — prefix changes, idle time, the last measured hit, and whether the last request just fully prefilled a large prompt — and rotates the routing id when the prediction is at or below `cacheHitThresholdPct` (25% by default) **and** recent requests are slow. Because the prediction is made in the `llm/stream` hook, before the request headers are assembled, the new routing id applies to the request that was predicted cold: the new backend builds the cache for that request, and no extra cold request is added.

Only OpenCode Go DeepSeek-series conversations are eligible. Other models are never routed by this plugin, even when a route exists.

A system-prompt rewrite and a compacted message history are the two cases where the prefix certainly changes, so a request carrying either is always predicted cold. A cold prediction alone never rotates: the recent requests must also be slow.

If consecutive switches still land on backends that miss the base targets, the plugin widens the next trigger instead of repeating equivalent switches: each completed post-switch window that remains slower than `ttftThresholdMs` or `throughputThresholdTps` adds one step, giving the next decision `stepTtftGraceMs` (2 s by default) more TTFT room and `stepThroughputGraceTps` (5 tok/s by default) less required throughput. A post-switch window that meets the base targets resets the step to zero. Failure is always judged against the base targets, never the already-widened ones.

The plugin does not compress anything itself and does not change the prompt or the conversation log. It only changes one routing header and keeps local timing counters.

## How it works

- **Measured cache evidence.** It wraps `llm/stream` for eligible requests and reads the final `usage` chunk. A request's cache-hit percentage is `cacheReadTokens / (inputTokens + cacheReadTokens)`; the fresh input plus the cached reads is the prompt the upstream billed. Samples keep TTFT, output tokens/second, prompt tokens, cache reads, and the hit percentage, and the last `sampleSize` valid samples per DSH session are used.
- **Fold ledger (diagnostics only).** It also reads billion-context's per-session state file (`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`) and follows `metadata.cacheLedger.folds`. billion-context derives `conversationId` from the highest-priority conversation header, which in a DSH setup is `x-bili-plugin-conversation` (the DSH session id); `x-opencode-session` ranks below it, so rotating that header does not change the file. The latest fold is evidence that a large cold request was a rebuild; it no longer triggers a rotation by itself. Nothing outside the plugin is modified: 0.5.0 removed the 0.4.0 pre-fold seam that had to patch billion-context.
- **Eligibility.** Only requests from a configured provider (`opencode-go` by default) whose model id starts with `deepseek` (case-insensitive) are considered. `models` can narrow this to exact DeepSeek ids. Other models are ignored, and a rotation is skipped if the latest ordinary conversation request used a non-eligible model. Auxiliary requests that declare a `purpose` do not change that state.
- **Prediction.** Immediately before an eligible request is sent, the plugin predicts that request's cache hit in this order: a changed system prompt or a shrank message history → 0%; no measured request yet → unknown, never rotate; an idle gap of at least `cacheTtlMs` (1 hour by default) → 0%; a last hit of 80% or more → carry over; a last request that fully prefilled a large prompt (`>=` `prefillMinTokens`, low hit) → assumed warm (measured 95–99%), because that prefill just cached the prefix (this is the fold-rebuild case); it is a probability, not a guarantee — if that request still misses, the next one is predicted cold and rotates; otherwise the last measured hit carries over and a hit `<=` `cacheHitThresholdPct` is cold.
- **Decision.** It rotates only when the prediction is cold, the recent samples are slow (average TTFT `>=` 12000 ms by default, or average throughput `<=` 60 tokens/second by default, widened by the failure step), the latest ordinary request was eligible, and `minRotationGapMs` has passed. The record keeps the prediction basis (`system-rewrite`, `history-compacted`, `idle-expired`, `cache-miss-persists`, and so on) and the expected hit percentage.
- **Routing.** A persisted route maps the DSH session id to a generated `ses_...` value. The `llm-pi-ai/request-headers` waterfall runs after pi-ai assembles its header set and before the request is sent, so setting `x-opencode-session` there reaches the wire, and the route written by the prediction applies to the same request. In the reference setup a companion injector such as `dsh-opencode-ip-guard` supplies a baseline value equal to the DSH session id; when a route exists this plugin replaces it, and the injector's no-overwrite fallback leaves the value alone.
- **No billion-context, no effect.** If the sessions directory or the session state file is absent, the fold diagnostics stay idle. The prediction uses only measured samples, so it never rotates without them, and no exception is thrown into DSH.

The first request of a session has no measured sample, so it never rotates on a prediction; the first fold seen after a plugin start is only a baseline for the diagnostics. A rotation changes only the upstream routing id, and billion-context keeps writing the same state file for the DSH session, so the monitor keeps following it.

## Requirements

- DSH with the `llm-pi-ai` adapter and an OpenCode Go provider (default `opencode-go`) configured with at least one DeepSeek-series model (model id starts with `deepseek`).
- billion-context installed and actively saving session state (for the fold diagnostics; the prediction itself uses measured samples).
- DSH 0.2.1-rc.5 or newer, below 0.3.0.
- Node.js 20 or newer.

## Install from npm

```bash
dsh plugin add dsh-opencode-go-router --profile <profile>
```

Or add `dsh-opencode-go-router` from the DSH plugin manager's add-plugin box. The package declares `dsh.bundle.patch`, so a normal install creates the `opencode-router` row; do not add a separate profile row for it.

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
| `cacheHitThresholdPct` | `25` | Rotate only when the predicted cache hit of the next request is at or below this. |
| `predictiveRotation` | `true` | Predict the next request's cache hit and rotate before it. Set false to disable switching entirely. |
| `cacheTtlMs` | `3600000` | An idle gap of at least this is predicted cold. Measured data shows 15–60 minutes still hits, so the default is one hour; `0` disables the idle rule. |
| `prefillMinTokens` | `4000` | A cold request that billed at least this many prompt tokens is treated as a full prefill, so the next request is predicted warm (an assumption; a measured miss on that request corrects the following one). |
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

- `history` — recent silent switches, newest first, with `sessionId`, `at`, `reason` (`predicted-cold`), `basis`, `foldSeq`, `cacheHitPct` (the expected hit), `step`, the routing `value`, before/after TTFT and throughput, sample progress, and a `backfilled` marker;
- `eligibility` — the configured providers and the fixed `deepseek` model prefix;
- `baselineReady` and `lastFoldSeq` — fold cursor for the diagnostics;
- `latestFold` — latest fold record (including `hPct`);
- `watchingId` — DSH session id whose billion-context state file is being followed;
- `route` — current rotated routing id, or `null`; its `reason` is `predicted-cold`, its `basis` is the prediction basis, and `step` is the failure step used for that switch;
- `targetActive` — whether the latest ordinary conversation request was an eligible OpenCode Go DeepSeek request; `false` blocks rotation;
- `lastPrediction` — the latest pre-request prediction: basis, expected and last hit, cold flag, idle gap, sample count, performance summary, step, `rotated`, and `skipReason` (`predictive-rotation-off`, `cache-expected-warm`, `not-target`, `cooldown`, `performance-ok`);
- `predictions`, `predictiveRotation`, `cacheHitThresholdPct`, `cacheTtlMs` — how many predictions were made and the prediction settings;
- `systemPromptFp`, `messageCount`, `lastSample` — the latest prefix inputs the prediction compared;
- `stepping` — `step`, `consecutiveFailures`, base and effective TTFT/throughput thresholds, and the per-step grace values;
- `samples` — count, average TTFT, average throughput;
- `rotations`, `lastRequestAt`, `lastTickAt`, `lastError`;
- `routing` — header-hook counters and the latest decision: `checks`, `applications`, `lastCheckedAt`, `lastCheckedSessionId`, `lastAppliedAt`, `lastAppliedSessionId`, `lastAppliedValue`, `lastReason`. `lastReason` is `applied`, `no-route`, `existing-header`, `no-headers`, `disabled`, or `not-target`.

The route is localhost-only when the host's web server is bound to localhost. Treat the JSON as diagnostics.

## Settings page

In the DSH Web client, open the plugin manager and select this bundle. Its detail page renders a **Silent switch performance log** above the bundle configuration rows.

For each silent switch it shows the time, a short session id, the trigger (`Predicted cold` or `System rewrite`), the prediction basis with the fold number and expected cache hit, the failure step if it was above zero, average TTFT and throughput before the switch, the first `sampleSize` eligible samples after it, and the percentage change. The header also shows the most recently active session's step and effective thresholds, and the panel explains the per-step grace. Rows refresh every five seconds from `GET /opencode-router/status`. The after window is frozen once it has `sampleSize` samples, so later traffic does not rewrite history.

Routes created before 0.2.0 are backfilled as one row per still-known route and marked `Reconstructed`; their after values come from samples retained after that rotation. The panel lives in the Web client and does not affect host routing.

## Privacy and safety

- Stored data is limited to DSH session ids, generated routing ids, fold numbers, cache percentages, TTFT, throughput, rotation history, and timestamps. No prompts, messages, tool output, or API keys are stored.
- Every host callback catches its own errors. A missing or malformed billion-context state file only produces a log entry.
- Rotating a header is a routing hint, not a guarantee that the gateway picks a different physical backend. If the gateway ignores unknown or new session values, the plugin cannot force a move.
- billion-context's state file is an internal format. If its layout changes, the fold diagnostics may see no folds and stay idle; the plugin will not corrupt anything.

## Development

```bash
node --test
```

The suite covers fold parsing, cache-hit measurement, the prediction rules and their bases, the performance condition and consecutive-failure stepping, DeepSeek-only eligibility, state persistence, rotation history, the monitor, header routing, stream measurement, and the client bundle registration.

## Other DSH projects I work on

Prompt-cache routing is only one corner of DSH. These are the other plugins I maintain — take what fits.

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** — right-click menus for sidebar rows: workspace rows, session rows and the conversation body each get their own menu, with "Open with" and "More actions" submenus.
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** — a layout organizer for seven regions: sidebar, sidebar footer, conversation tabs, composer, session header, right panel, and settings navigation all support long-press drag to reorder, and panels can be tucked into "More".
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** — an `ask_user_question` enhancement: right-click an option to add a note, or ask the model a side question with the same context before choosing.
- **[dsh-if](https://github.com/TLEWA/dsh-if)** — the `/if` command: let the model judge a condition from prior context, then send the instruction below it as a user message only when it holds.
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** — fixes GBK/CP936/CP932 mojibake from DSH subprocess output on Windows.

## License

MIT

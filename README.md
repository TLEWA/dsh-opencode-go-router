# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

A DeepSeek Harness (DSH) host plugin that gives an OpenCode Go conversation using a DeepSeek-series model a fresh routing id when the **next** request is predicted to miss the upstream prompt cache **and** recent requests are slow. The prediction runs before the request is sent, so the switch applies to that very request and does not add a cache miss of its own.

It also keeps a two-tier pool of warm routing ids, so a new conversation with a similar prompt prefix can start on a backend that already has that prefix cached instead of paying a cold start.

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
- **Fold ledger (diagnostics only, optional).** It also reads billion-context's per-session state file (`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`) and follows `metadata.cacheLedger.folds`. billion-context derives `conversationId` from the highest-priority conversation header, which in a DSH setup is `x-bili-plugin-conversation` (the DSH session id); `x-opencode-session` ranks below it, so rotating that header does not change the file. The latest fold is evidence that a large cold request was a rebuild; it no longer triggers a rotation by itself. Nothing outside the plugin is modified: 0.5.0 removed the 0.4.0 pre-fold seam that had to patch billion-context.
- **Eligibility.** Only requests from a configured provider (`opencode-go` by default) whose model id starts with `deepseek` (case-insensitive) are considered. `models` can narrow this to exact DeepSeek ids. Other models are ignored, and a rotation is skipped if the latest ordinary conversation request used a non-eligible model. Auxiliary requests that declare a `purpose` do not change that state.
- **Prediction.** Immediately before an eligible request is sent, the plugin predicts that request's cache hit in this order: a changed system prompt or a shrank message history → 0%; no measured request yet → unknown, never rotate; an idle gap of at least `cacheTtlMs` (1 hour by default) → 0%; a last hit of 80% or more → carry over; a last request that fully prefilled a large prompt (`>=` `prefillMinTokens`, low hit) → assumed warm (measured 95–99%), because that prefill just cached the prefix (this is the fold-rebuild case); it is a probability, not a guarantee — if that request still misses, the next one is predicted cold and rotates; otherwise the last measured hit carries over and a hit `<=` `cacheHitThresholdPct` is cold.
- **Decision.** It rotates only when the prediction is cold, the recent samples are slow (average TTFT `>=` 12000 ms by default, or average throughput `<=` 60 tokens/second by default, widened by the failure step), the latest ordinary request was eligible, and `minRotationGapMs` has passed. The record keeps the prediction basis (`system-rewrite`, `history-compacted`, `idle-expired`, `cache-miss-persists`, and so on) and the expected hit percentage.
- **Routing.** A persisted route maps the DSH session id to a generated `ses_...` value. The `llm-pi-ai/request-headers` waterfall runs after pi-ai assembles its header set and before the request is sent, so setting `x-opencode-session` there reaches the wire, and the route written by the prediction applies to the same request. In the reference setup a companion injector such as `dsh-opencode-ip-guard` supplies a baseline value equal to the DSH session id; when a route exists this plugin replaces it, and the injector's no-overwrite fallback leaves the value alone.
- **Works without billion-context.** If the sessions directory or the session state file is absent, the fold diagnostics stay idle and the settings page says so. Everything else — measured cache hits, TTFT/throughput statistics, pool swaps, and rotation history — comes from the plugin's own request sampling, so the prediction still works, no exception is thrown into DSH, and the page keeps its statistics.

The first request of a session has no measured sample, so it never rotates on a prediction; the first fold seen after a plugin start is only a baseline for the diagnostics. A rotation changes only the upstream routing id, and billion-context keeps writing the same state file for the DSH session, so the monitor keeps following it.

## Warm routing-id pool

A routing id is tied to one upstream backend and its cache. When a conversation stops, its id can still be useful to another conversation whose prefix overlaps. The pool exists for that handoff.

**Pooling.** A conversation's code enters the pool after `poolIdleMs` (three minutes by default) without a meaningful session event, provided no turn, tool call, approval, or background job is pending and the host reports the agent as idle. Passive events such as a title change, a request-header write, or an LLM retry do not reset that timer. Archiving a session pools its code immediately. A code that stays pooled beyond `poolExpireMs` is dropped from the pool and can never be handed to a new conversation; its owner may still reclaim it on revival while it stays idle.

**Prefix digest.** Before each eligible request the plugin builds a digest of the system prompt, tool definitions, and message text, tool arguments, and tool results. It stores only chunked SHA-256 hashes, never the text. The match percentage is the number of common leading digest chunks divided by the new conversation's chunk count. A tier-1 donor must cover at least `poolMatchPct` (60% by default) of the new prefix; tier 2 has no match floor.

**Two tiers.** Tier 1 holds codes inactive for less than `poolTier1Ms` (one hour by default); tier 2 holds codes inactive for one to twenty-four hours. A candidate must also have at least `poolSampleSize` measured samples bound to that code, an average TTFT at most `poolMaxTtftMs` (8 s), and an average throughput above `poolMinTps` (80 tok/s). Among tier-1 candidates the plugin picks the largest prefix match (ties: higher throughput, lower TTFT, more recent activity). Tier 2 is considered only when no tier-1 candidate qualifies, and it must actually be faster: the donor's average throughput has to reach the session baseline (the session's own bound samples when it has at least `poolSpeedMinSamples`, otherwise the median of the last 200 requests) times `poolSpeedGainRatio` (1.1 by default), and both sides need at least `poolSpeedMinSamples` (5) samples. With no measurable baseline the gate stays open. Tier 2 has no prefix-match floor: a code with a lower match is still preferred over generating a fresh code once it passes the sample and speed gates.

**Exchange.** A new conversation first generates a fresh code. If a candidate qualifies, the two swap: the new conversation takes the donor's code together with its digest and code-bound samples, and the donor receives the fresh code with an empty digest and no samples. The donor is marked sleeping and can rejoin the pool after its next request goes idle. No qualified candidate means the new conversation keeps its fresh code. Revival is not an adoption: a returning conversation always reclaims its own routing id while that id is still idle, with no match, sample, tier, or speed test. If its id was already handed to another session, it keeps the fresh replacement and never borrows another code.

Only codes that already have a prefix digest, at least `poolSampleSize` bound samples, and an average TTFT and throughput inside the donor targets (at most 8 s, above 80 tok/s), are not expired, and are not sleeping enter the pool; a code with too little evidence or one that proved slow stays active so its owner can keep using it.

**Effect.** The pool page compares the first request after an adoption with the first request of a fresh (`pool-initial`) session. The comparison uses a persisted first-request marker; for an adopted event it also uses the first-request snapshot stored on the pool event, so a first request that has left the 200-entry request log is still measured from that snapshot. An adopted event recorded before snapshots existed whose first request has also left the log, or a baseline whose first request left the log, is skipped instead of being replaced by a later warm request. It reports adopted and baseline counts, average first-request hit, average match, and `deltaPct` in percentage points. A route created before 0.6 without a digest stays active until its session sends its next request. `poolMaxEntries` caps the pool; the least recently active pooled code is evicted first, and an evicted code stays out until its session becomes active again.

With the pool enabled, the first eligible request of a session creates a persisted route even when no rotation is needed. That route is what the pool later owns and hands over. Set `poolEnabled: false` to keep the pre-0.6 behavior, where only a rotation created a route and unrotated sessions kept the header supplied by the host or a companion injector.

## Requirements

- DSH with the `llm-pi-ai` adapter and an OpenCode Go provider (default `opencode-go`) configured with at least one DeepSeek-series model (model id starts with `deepseek`).
- billion-context is optional: when installed and actively saving session state, its fold ledger feeds the fold diagnostics. Without it the plugin still measures every request, keeps statistics, and logs pool swaps and cache hits.
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
| `poolEnabled` | `true` | Enable the warm routing-id pool. |
| `poolIdleMs` | `180000` | Idle time with no pending work before a code enters the pool. |
| `poolMatchPct` | `60` | Minimum prefix-digest match for a tier-1 donor code (tier 2 has no floor). |
| `poolSpeedGainRatio` | `1.1` | Minimum throughput gain over the session baseline for a tier-2 donor. |
| `poolSpeedMinSamples` | `5` | Bound samples required on the donor and on the baseline before the tier-2 speed gate decides. |
| `poolMinTps` | `80` | Minimum average throughput of a donor code's samples (strictly above). |
| `poolMaxTtftMs` | `8000` | Maximum average TTFT of a donor code's samples (8 s inclusive). |
| `poolSampleSize` | `5` | Code-bound samples required before a code can be a donor. |
| `poolTier1Ms` | `3600000` | Codes inactive for less than this are tier 1. |
| `poolExpireMs` | `86400000` | Drop a pooled code after this inactivity; it is never handed out again. |
| `poolMaxEntries` | `50` | Maximum pooled codes; the least recently active is evicted first. |
| `poolDigestChunkChars` | `512` | Characters per prefix-digest chunk. |
| `poolDigestMaxChars` | `262144` | Maximum prefix characters hashed into a digest. |

## Status route

`GET /opencode-router/status` returns JSON with the effective config, persisted routes, pool contents, rotation history, and per-session monitor state:

- `history` — recent routing records, newest first, with `sessionId`, `at`, `reason` (`predicted-cold`, `pool-adopted`, or `pool-donated`), `basis`, `foldSeq`, `cacheHitPct` (the expected hit), `step`, the routing `value`, before/after TTFT and throughput, sample progress, and a `backfilled` marker. New rows also carry `version` and `thresholds` (base and effective TTFT/throughput targets plus the failure step); pool rows have `thresholds: null`, the pool fields `poolMatchPct`, `poolTier`, `poolScore`, `poolSourceSessionId`, `poolRole`, and the first-request marker `firstRequestAt`;
- `routes` — persisted routes with the prefix digest redacted to `digestChunks` (count) and code-bound samples summarized as `poolSamples`;
- `pool` — `enabled`, `speedGainRatio`, `speedMinSamples`, limits, `total`, `tier1`, `tier2`, `eligible`, `lastAdoption`, `lastRevival`, `effect` (`adopted`/`baseline` first-request hit summaries plus `deltaPct` and recent `samples`), and per-entry summaries with `sessionId`, `code`, `tier`, `eligible`, `samples`, `avgTtftMs`, `avgTps`, `score`, `digestChunks`, `digestChars`, `ageMs`, `pooledAt`, and `lastActiveAt`;
- `activity` — per-session open turns, tool calls, approvals, background jobs, and last activity time; these gate pooling;
- `eligibility` — the configured providers and the fixed `deepseek` model prefix;
- `baselineReady` and `lastFoldSeq` — fold cursor for the diagnostics;
- `latestFold` — latest fold record (including `hPct`);
- `watchingId` — DSH session id whose billion-context state file is being followed;
- `route` — current rotated routing id, or `null`; its `reason` is `predicted-cold`, `pool-adopted`, or `pool-donated`, its `basis` is the prediction or pool basis, and `step` is the failure step used for that switch;
- `targetActive` — whether the latest ordinary conversation request was an eligible OpenCode Go DeepSeek request; `false` blocks rotation;
- `lastPrediction` — the latest pre-request prediction: basis, expected and last hit, cold flag, idle gap, sample count, performance summary, step, `rotated`, and `skipReason` (`predictive-rotation-off`, `cache-expected-warm`, `not-target`, `cooldown`, `performance-ok`, `pool-adopted`, `pool-revived`);
- `predictions`, `predictiveRotation`, `cacheHitThresholdPct`, `cacheTtlMs` — how many predictions were made and the prediction settings;
- `systemPromptFp`, `messageCount`, `lastSample` — the latest prefix inputs the prediction compared;
- `stepping` — `step`, `consecutiveFailures`, base and effective TTFT/throughput thresholds, and the per-step grace values;
- `samples` — count, average TTFT, average throughput;
- `billionContext` — `{ detected, root }`: whether billion-context's sessions directory exists (probed at most every 30 s) and which root was checked;
- `statistics` — request totals for the settings header: `window.requests`, `window.poolEvents`, `requests.total/measured/avgHitPct/warm/cold/avgTtftMs/avgTps`, and `pool.swaps/revivals/lastSwapAt`;
- `requests` — the latest 100 measured requests, newest first: `sessionId`, `at`, hit percentage, TTFT, throughput, input and cache-read tokens;
- `poolEvents` — the latest 100 pool swaps and revivals, newest first: `role` (`adopted`/`revived`), session ids, code and donor code, match percentage, tier, score, donor TTFT/throughput/sample count, and for adoptions the persisted `firstRequest` snapshot (time, hit, TTFT, throughput, input and cache-read tokens);
- `rotations`, `lastRequestAt`, `lastTickAt`, `lastError`;
- `routing` — header-hook counters and the latest decision: `checks`, `applications`, `lastCheckedAt`, `lastCheckedSessionId`, `lastAppliedAt`, `lastAppliedSessionId`, `lastAppliedValue`, `lastReason`. `lastReason` is `applied`, `no-route`, `existing-header`, `no-headers`, `disabled`, or `not-target`.

The route is localhost-only when the host's web server is bound to localhost. Treat the JSON as diagnostics.

## Settings page

In the DSH Web client, open the plugin manager and select this bundle. Its detail page renders a **Silent switch performance log** above the bundle configuration rows.

For each routing record it shows the time, a short session id, the trigger (`Predicted cold`, `System rewrite`, `Pool reuse`, or `Pool donation`), the prediction basis with the fold number and expected cache hit, the failure step if it was above zero, average TTFT and throughput before the switch, the first `sampleSize` eligible samples after it, and the percentage change. A pool-reuse row has no baseline of its own: its before column is the borrowed code's history in the source session, so its percentage is same-code drift rather than an adoption gain, and those rows are excluded from the header's average change; the Pool effect block above carries the adoption comparison. Every row also names the thresholds that were active when it was written; rows from versions that did not record thresholds are marked as legacy records rather than being judged against today's defaults. The header shows the pool size, tier counts, eligible count, the most recently active session's step and effective thresholds, and the per-step grace. Below it, a two-tier session-code list shows each pooled code with its tier, eligibility, TTFT, throughput, samples, score, idle time, digest size, and pool time; an ineligible row also states why it cannot be swapped. Rows refresh every five seconds from `GET /opencode-router/status`. The after window is frozen once it has `sampleSize` samples, so later traffic does not rewrite history.

The page also shows a one-line summary of recent requests (average hit, warm and cold counts, average TTFT and throughput) and two logs below the history: **Pool swaps** (which code moved, from which session, match percentage, tier, and donor speed) and **Cache-hit records** (only the first request after each pooled code reuse; a session reclaiming its own code is not a pool replacement and is not shown; the first request is persisted with the pool event, so it remains visible after the 200-entry request log evicts it; each row carries its hit percentage, TTFT, throughput, prompt and cache-read tokens). When billion-context is not detected, a notice says the fold diagnostics are unavailable and that the statistics come from the plugin's own sampling; the fold chip is hidden.

Routes created before 0.2.0 are backfilled as one row per still-known route and marked `Reconstructed`; their after values come from samples retained after that rotation. The panel lives in the Web client and does not affect host routing.

## Privacy and safety

- Stored data is limited to DSH session ids, generated routing ids, fold numbers, cache percentages, TTFT, throughput, routing history, per-request cache-hit and pool-event logs, timestamps, and chunked SHA-256 prefix hashes for pool matching. No prompts, messages, tool output, or API keys are stored; the digest cannot be reversed into the prompt text.
- Every host callback catches its own errors. A missing billion-context installation only switches the fold diagnostics off; a malformed state file only produces a log entry.
- Rotating a header is a routing hint, not a guarantee that the gateway picks a different physical backend. If the gateway ignores unknown or new session values, the plugin cannot force a move.
- billion-context's state file is an internal format. If its layout changes, the fold diagnostics may see no folds and stay idle; the plugin will not corrupt anything.

## Development

```bash
node --test
```

The suite covers fold parsing, cache-hit measurement, the prediction rules and their bases, the performance condition and consecutive-failure stepping, DeepSeek-only eligibility, state persistence, rotation history, request and pool-event logs, the statistics summary, the tightened pool entry gate, the monitor, header routing, stream measurement, the client bundle registration and two-tier code list, prefix digests, both pool tiers, pool exchange and revival, the first-request marker, persisted first-request snapshot, and pool-effect attribution, idle/archive pooling, and the activity tracker.

## Other DSH projects I work on

Prompt-cache routing is only one corner of DSH. These are the other plugins I maintain — take what fits.

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** — right-click menus for sidebar rows: workspace rows, session rows and the conversation body each get their own menu, with "Open with" and "More actions" submenus.
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** — a layout organizer for seven regions: sidebar, sidebar footer, conversation tabs, composer, session header, right panel, and settings navigation all support long-press drag to reorder, and panels can be tucked into "More".
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** — an `ask_user_question` enhancement: right-click an option to add a note, or ask the model a side question with the same context before choosing.
- **[dsh-if](https://github.com/TLEWA/dsh-if)** — the `/if` command: let the model judge a condition from prior context, then send the instruction below it as a user message only when it holds.
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** — fixes GBK/CP936/CP932 mojibake from DSH subprocess output on Windows.

## License

MIT

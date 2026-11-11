# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

## [0.7.1] - 2026-11-11

- An unknown cache-hit rate is no longer treated as 0%: a sample's hit rate is used only when it is actually present (a measured 0% still counts as 0%), otherwise it falls back to token usage. The request list and statistics skip unknown values too, so "not measurable" is not shown as 0% or averaged in as a miss.
- The first request after a restart restores the previous request time from persisted routes and samples: after an overnight or long idle gap the cache TTL expires and rotation happens as usual, instead of assuming the cache is still warm.
- Shutdown waits for `state.json` to reach disk before tearing down: dispose returns a Promise the host can await, and a failed flush is retried once inline, reducing the chance of losing the last request or rotation record.
- The runtime version is now read from `package.json`: the hand-maintained `VERSION` in `lib/core.js` was stuck at 0.6.1, so 0.7.0 reported a stale version in the status endpoint, the settings header and rotation history; those places now follow the released version.
- Docs: the cross-repo index now describes `dsh-utf8-output` as `GBK/CP936/GB18030` (previously CP932 by mistake).

## [0.7.0] - 2026-11-11

- Adopt shared Codex PR review rules and repository-specific review guidance; preserve existing CI, human approval, and release behavior.

### Fixed

- Session monitors no longer grow without bound: new `monitorTtlMs` (one hour by default) and `monitorLimit` (200 by default). A monitor idle beyond the TTL is dropped and its timers are cleared; when the map is over the cap, the least recently active idle sessions are evicted first, and a session inside the active window is never evicted, so eviction cannot change a live route's fold baseline or prediction history. The `sessions` array of `/opencode-router/status` lists only retained monitors.
- Sample windows are cross-checked at startup: when `maxSamples` is below `sampleSize` or `poolSampleSize` it is raised to the larger of the two with a warning, so rotation and pool gates cannot wait forever on a truncated sample ring; when `poolSpeedMinSamples` exceeds `poolSampleSize` a warning states that the tier-2 speed gate can never be satisfied (the gate is not weakened automatically, and valid configurations behave exactly as before).
- A failed `state.json` write no longer only marks the state dirty: each flush makes up to three immediate attempts, and a persistent failure schedules an exponential-backoff retry (starting at 250 ms, capped at 60 s) until the write succeeds; every failed attempt unlinks its tmp file, so no `.tmp-*` debris is left in the state directory.

## [0.6.2] - 2026-11-10

> 0.6.1 was published to npm without a GitHub Release; this is the first GitHub Release that also contains 0.6.1's pool-effect metrics and first-request snapshots.

### Changed

- Docs: README is now the Chinese primary document, and the English edition moved to `README.en.md`; synced the documentation contract in `ci.config.json`, `package.json` and AGENTS.md.
- Removed `poolCrossTierFallback`. When tier 1 has no qualified candidate, tier-1 codes that missed `poolMatchPct` no longer join the tier-2 ranking; they stay with their own session. Tier 2 still has no prefix-match floor.
- Tier 2 gains a speed gate: the donor's average throughput must reach the session baseline times `poolSpeedGainRatio` (1.1 by default), and both the donor and the baseline need at least `poolSpeedMinSamples` (5 by default) bound samples. The baseline prefers the session's own bound samples and falls back to the median throughput of the last 200 requests; when no baseline can be measured the gate stays open. An older code slower than the baseline is no longer swapped in, so a prefix match cannot cost the new session throughput.
- The status route and settings page replace `crossTierFallback` in the `pool` summary with `speedGainRatio` and `speedMinSamples`.
- Settings page: pool-reuse rows now label their before column **Source-session history** (the borrowed code's record in its source session) and their change **Same-code drift**, with an inline note; these rows no longer feed the header's average change, so code drift is not reported as an adoption gain.

## [0.6.1] - 2026-11-09

### Added

- Statistics without billion-context: the status route adds `billionContext`, `statistics`, `requests`, and `poolEvents`. The plugin samples every eligible request itself, and the settings page shows the average hit, warm/cold counts, average TTFT, and throughput; when the fold diagnostics are unavailable the page says so and hides the fold chip.
- The settings page adds **Pool swaps** and **Cache-hit records**. The first shows code reuse/return, source session, match percentage, tier, and donor TTFT/throughput/sample count; the second shows only the first request after each pooled code reuse; a session reclaiming its own code is not a pool replacement and is not shown; the first request is persisted with the pool event, so it remains visible after the 200-entry request log evicts it. Each row carries its hit percentage, TTFT, throughput, prompt tokens, and cache-read tokens.
- The settings page adds a **Two-tier pool session codes** list: each pooled code is grouped under tier 1 or tier 2 with its session, full code, eligibility, TTFT, throughput, sample progress, score, idle time, digest size, and pool time; an ineligible row also states why it cannot be swapped.
- The state file keeps the latest 200 requests and 100 pool events (`requests`, `poolEvents`), sanitized and length-capped on load.
- The settings page adds **Pool effect (first-request hit)**: it compares the first request of a session that borrowed a code with the first request of a fresh-code session, showing sample counts, average match, and the difference in percentage points; events whose first request has left the request log are skipped.

### Changed

- The pool entry gate is tighter: a donor code's average throughput must be strictly above `poolMinTps` (80 tok/s by default), and its average TTFT must not exceed `poolMaxTtftMs` (8000 ms by default; 8 s is inclusive). Codes that miss either target stay active instead of entering the pool, so a slow code is not handed to a new session.
- Tier 2 no longer requires the prefix-match percentage to reach `poolMatchPct`; that floor now applies to tier 1 only. Tier 2 still requires valid samples, TTFT, throughput, and age, and is ranked by speed.
- Revival no longer goes through either pool tier or matching: a returning session reclaims its own code whenever that code is still idle, with no match, tier, sample, or speed check. If the code was already handed to another session, the fresh replacement is kept instead of borrowing another code.
- Pool adoption and revival events are written to both the route state and history, which is what the settings page renders.

### Fixed

- Fixed the pool-effect metric treating the earliest request still in the ring as the first request. Each route now records the first request time of its code window (`firstRequestAt`), and the first-request snapshot is stored on the adoption pool event; when that request has fallen out of the 200-entry ring the metric uses the snapshot instead of skipping the session or promoting a later warm request (c726e104's 0% was previously reported as 99.1%).

### Tests

- Added coverage for the entry gate, request and pool-event logs, the statistics summary, the status payload without billion-context, the client notice plus the two log sections (the cache log keeps only the first request after a pool reuse), and the two-tier code list; new tests cover the tier-2 match floor removal, direct revival, the first-request marker, the first-request snapshot, ring eviction, and the client pool-effect display; all 79 tests pass.

## [0.6.0] - 2026-11-09

### Added

- **Two-tier warm routing-id pool** (enabled by default). When an eligible session has been idle for `poolIdleMs` (3 minutes by default) with no active turn, tool call, approval, or background job, or when the session is archived, its `x-opencode-session` code is pooled. When a new session needs a code and an older pooled session's prefix match reaches `poolMatchPct` (60% by default), while that code's recent samples average TTFT `<=` `poolMaxTtftMs` (10 seconds) and throughput `>` `poolMinTps` (70 tok/s), the two codes are swapped: the new session receives the older code, digest, and samples, and the older session receives a freshly generated code and sleeps, avoiding a cold start for the new session. Among qualified candidates, the highest match wins.
- Prefix matching stores only chunked SHA-256 digests, never prompt text; the match is the number of shared prefix chunks divided by the new session's chunk count. Chunk size is `poolDigestChunkChars` (512 characters), capped at `poolDigestMaxChars` (262144 characters).
- Tier 1 holds codes inactive for less than `poolTier1Ms` (1 hour); tier 2 (1–24 hours) is consulted only when tier 1 has no qualified candidate, and ranks by `score = -(TTFT seconds × 10) + throughput`. Codes inactive beyond `poolExpireMs` (24 hours) are removed from both tiers and cannot be pooled again.
- A returning session tries the pool first: it reclaims its own code when that code is still pooled and matches it, otherwise it tries other candidates, and with no candidate it falls back to a fresh code (`pool-fallback`) instead of reusing the sleeping one.
- Eleven new pool settings: `poolEnabled`, `poolIdleMs`, `poolMatchPct`, `poolMinTps`, `poolMaxTtftMs`, `poolSampleSize`, `poolTier1Ms`, `poolExpireMs`, `poolMaxEntries`, `poolDigestChunkChars`, and `poolDigestMaxChars`. `poolMaxEntries` caps the pool and evicts the least recently active code first; an evicted code stays out until its session becomes active again, so a full pool does not churn on every idle scan.

### Changed

- With the pool enabled, a session's first eligible request creates a persisted route even when no rotation is needed; that route is what the pool later owns and hands over. Set `poolEnabled: false` to keep the pre-0.6 behavior, where only a rotation created a route and unrotated sessions kept the header supplied by the host or a companion injector. A route created before 0.6 has no prefix digest and is not pooled until its session sends another request to fill it in.
- Every performance record now carries `version` and `thresholds` (base and effective TTFT/throughput targets and the failure step). The settings page explains each switch with the thresholds in force at the time; records without thresholds are marked as legacy records, so today's defaults are not used to second-guess a historical switch.
- The status route adds `pool` and `activity`; `routes` exposes only `digestChunks` and `poolSamples` summaries instead of digest arrays; `skipReason` adds `pool-adopted` and `pool-revived`; routes and history add the `pool-adopted` and `pool-donated` reasons plus `poolMatchPct`, `poolTier`, `poolScore`, `poolSourceSessionId`, and `poolRole`.
- The settings page shows the pool size, tier counts, qualified count, last adoption, and each record's pool match and tier.

### Fixed

- A code with fewer than `poolSampleSize` bound samples no longer enters the pool. Such a code could occupy a pool slot but was skipped by selection for lack of samples, forcing its owner to fall back to a freshly generated code on revival and losing a routing id that was still usable.
- Legacy records are no longer presented as a switch that the current thresholds would have made: records with `thresholds` show the trigger thresholds, and records without them are labeled **Legacy record, trigger thresholds not recorded**.

### Tests

- Added coverage for activity tracking (turns, tools, approvals, background jobs), prefix digests, two-tier selection, code swapping, session revival and fallback, expiry, idle and archived pooling, and the client's pool display.

## [0.5.0] - 2026-11-08

### Changed

- Rotation is now a **pre-request cache prediction**. Before every eligible `llm/stream` request is sent, the plugin predicts that request's upstream prefix-cache hit from the signals known at that moment; when the prediction is `<=` `cacheHitThresholdPct` (25% by default) and recent requests are slow, it rotates the routing id immediately so the new route applies to that very request. The decision happens before the request goes out, so there is no longer a cold request followed by a second cold one on the new backend.
- Prediction inputs, in priority order: a system-prompt rewrite or a compacted message history means 0%; no measured request yet means unknown (never rotate); an idle gap of at least `cacheTtlMs` (1 hour by default) means 0%; a last hit `>=` 80% carries over; a last request that fully prefilled a large prompt with a low hit (the fold-rebuild signature) means warm (measured 95–99%), because that prefill just cached the new prefix upstream; otherwise the last measured hit carries over and a hit `<=` the threshold is cold.
- Measured evidence behind this: a fold-rebuild request is itself cold (0–82% hit), but the request right after it hits 95–99%; a 15–60 minute idle gap still mostly hits, and only multi-hour gaps go cold broadly. Rotating right after a fold, as 0.2.x did, threw away a warm request; the prediction treats those cases as warm.
- New `predictiveRotation` (`true`), `cacheTtlMs` (`3600000`), and `prefillMinTokens` (`4000`). Removed `foldsWindow`, `systemRewriteBypassCache`, `foldRotationMode`, `foldDeferIdleMs`, `foldDeferMaxMs`, and `foldDeferMaxRequests`; the fold ledger stays as diagnostic evidence and no longer triggers rotation by itself.
- Switch records and routes now use `reason: "predicted-cold"` and add `basis` (`system-rewrite` / `history-compacted` / `no-history` / `no-cache-data` / `idle-expired` / `warm-history` / `fold-rebuild-prefilled` / `prefilled` / `cache-miss-persists` / `partial-cache`). Samples add `inputTokens`, `cacheReadTokens`, and `hitPct`.

### Removed

- Removed the 0.4.0 pre-fold seam: the `POST /pre-fold` endpoint, the `preFoldHook` / `preFoldHookPath` settings, the `preflightRotations` / `lastPreflightAt` status fields, and `scripts/patch-billion-context.mjs`. billion-context's `dist` no longer needs patching; older `fold-preflight` records still show as **Cache + speed** on the settings page. If billion-context was patched before, restore `index.js` from `index.js.opencode-router.bak` (or reinstall billion-context) and restart DSH.

### Status

- The status route adds `lastPrediction`, `predictions`, `predictiveRotation`, `cacheHitThresholdPct`, `cacheTtlMs`, `messageCount`, and `lastSample`; it drops `foldRotationMode`, `pendingRotation`, `deferredRotations`, `lastDeferredAt`, `systemRewriteRotations`, and `lastSystemRewriteAt`.
- The settings-page performance log labels the trigger as **Predicted cold** or **System rewrite**.

## [0.4.0] - 2026-11-08

### Added

- **Pre-fold seam.** The plugin serves `POST /pre-fold` on `127.0.0.1` and publishes a descriptor. The optional billion-context patch calls it after the rebuilt body exists but before that body is forwarded, so the pending switch is applied to the rebuild request itself. The rebuild is cold anyway; the route change and that cold prefill share one miss instead of adding a second one.
- The patch covers both rebuild paths: explicit compression through the initial `runPrepare`, and automatic folding through `preflightCompressIfNeeded`; both ask the plugin before forwarding.
- New patch script `scripts/patch-billion-context.mjs` with `--check` / `--apply` / `--revert`, automatic discovery under the DSH profiles, idempotent patching, and a `.opencode-router.bak` backup.
- New `preFoldHook` (default `true`) and `preFoldHookPath` settings. Without the patch, or with the seam disabled, the plugin keeps the 0.3.0 deferred path and does not fail.

### Status

- The status route adds `preFoldHook`, `preflightRotations`, and `lastPreflightAt`; rotation history and routes add `reason: "fold-preflight"`.
- The settings-page log shows a pre-fold switch as **Fold rebuild seam**.

## [0.3.0] - 2026-11-08

### Changed

- Fold-triggered rotation now defaults to **deferred**. billion-context writes a fold record only after its rebuild request has completed, so by the time the plugin sees the fold that request has already gone out; rotating immediately added a second cold prefill after it. The plugin now stores the decision and switches before a request that is expected to be cold: a system-prompt rewrite, or the first eligible request after `foldDeferIdleMs` (5 minutes by default) of session inactivity.
- New `foldRotationMode` (`defer` / `immediate` / `off`), `foldDeferIdleMs`, `foldDeferMaxMs`, and `foldDeferMaxRequests`. `immediate` restores the 0.2.1 behavior of rotating at the fold; `off` disables fold-triggered switches without affecting system-prompt rewrites.
- A pending switch is cleared when a later fold no longer meets the cache/performance conditions. The safety valves are disabled by default, so the plugin does not force a switch (and its extra cold request) unless configured.

### Status

- The status route adds `foldRotationMode`, `pendingRotation`, `deferredRotations`, and `lastDeferredAt`; rotation history and routes add the `fold-deferred` reason.
- The settings-page performance log shows a deferred fold switch under the **Fold + speed** trigger.

## [0.2.1] - 2026-11-08

### Added

- Consecutive-failure stepping: when a complete post-switch window is still slower than the base targets, the next TTFT target widens by 2 seconds and the throughput target drops by 5 tok/s; a window that meets the base targets resets the step. Failure is always judged against the base targets.
- New `stepTtftGraceMs` / `stepThroughputGraceTps` settings; the status route and switch records expose `step`, and `sessions.stepping` exposes the current step and effective thresholds.
- The settings-page panel shows each switch's step, the most recently active session's effective thresholds, and the per-step grace rule.

## [0.2.0] - 2026-11-08

### Added

- Persists one performance record per silent switch: the slow trigger samples plus the average TTFT and throughput of the first `sampleSize` requests after the switch. The window freezes once full.
- Adds a settings-page performance panel in the DSH Web host showing before/after speed, percentage change, and sampling progress, refreshed every five seconds.
- Exposes a top-level `history` array from the status route; routes written by older versions are backfilled as `backfilled` rows.
- Adds the client bundle (`dsh.client`) and a registration test.

### Fixed

- The settings-page trigger summary no longer shows the throughput threshold as `?`.
- The `cordis.patch.yml` insert name now matches the npm package name so the Host does not skip the client `dsh.client` declaration.

## [0.1.6] - 2026-11-08

### Fixed

- Fixed path portability in the test suite on Linux CI and wait for pending state writes before removing temporary directories.

## [0.1.5] - 2026-11-08

First public release.

### Added

- Tracks billion-context fold records and rotates `x-opencode-session` after the next rebuild when the last rebuild's cache hit is at or below the configured threshold (25% by default) and the last five requests are slow by TTFT or throughput.
- Detects system-prompt rewrites before request headers are assembled, bypasses the fold cache condition for the rewrite request, still requires slow samples, and merges the route switch with the rewrite's unavoidable cache miss.
- Applies only to OpenCode Go conversations using a `deepseek*` model; non-target requests never trigger a rotation or create a monitor.
- Stays idle without billion-context and exposes live state at `GET /opencode-router/status`.
- Persists routes, avoids rotating twice for the same fold, and guards against a fold rotation right after a system-rewrite rotation.

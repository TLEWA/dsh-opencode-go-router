# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-11-08

### Changed

- Rotation is now a **pre-request cache prediction**. Before every eligible `llm/stream` request is sent, the plugin predicts that request's upstream prefix-cache hit from the signals known at that moment; when the prediction is `<=` `cacheHitThresholdPct` (25% by default) and recent requests are slow, it rotates the routing id immediately so the new route applies to that very request. The decision happens before the request goes out, so there is no longer a cold request followed by a second cold one on the new backend.
- Prediction inputs, in priority order: a system-prompt rewrite or a compacted message history means 0%; no measured request yet means unknown (never rotate); an idle gap of at least `cacheTtlMs` (1 hour by default) means 0%; a last hit `>=` 80% carries over; a last request that fully prefilled a large prompt with a low hit (the fold-rebuild signature) means 100%, because that prefill just cached the new prefix upstream; otherwise the last measured hit carries over and a hit `<=` the threshold is cold.
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

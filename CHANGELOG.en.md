# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-08

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

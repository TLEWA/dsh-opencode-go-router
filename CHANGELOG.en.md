# Changelog

All notable changes to this project are documented here. Versioning follows
[Semantic Versioning](https://semver.org/).

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

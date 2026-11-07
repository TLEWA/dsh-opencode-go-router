# opencode-router

A DeepSeek Harness (DSH) host plugin that gives an OpenCode Go conversation a fresh routing id when billion-context compression loses the reusable prompt cache **and** recent requests are slow.

[中文说明](./README.zh-CN.md)

## Why

OpenCode Go pins a conversation to one upstream backend with the `x-opencode-session` request header. After billion-context rebuilds the context, the next request normally warms a new prefix on that same backend. If the first request after a rebuild reports an extremely low cache hit, and the last few requests are also slow, the backend is probably a bad place for this conversation. At the **next** compression rebuild this plugin rotates `x-opencode-session`, so the next request is sent to a different backend.

The plugin does not compress anything itself and does not change the prompt or the conversation log. It only changes one routing header and keeps local timing counters.

## How it works

- **Cache evidence.** It reads billion-context's per-session state file (`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`) and looks at `metadata.cacheLedger.folds`. Before any rotation `conversationId` is the DSH session id; after one it is the generated `ses_...` value, because billion-context then starts a new conversation. A fold record's `hPct` is the cache-hit percentage of the first request sent after that rebuild.
- **Performance evidence.** It wraps `llm/stream`, timestamps the first content chunk, and records output tokens per second at the finish chunk. It keeps the last `sampleSize` valid samples per DSH session.
- **Decision.** On a new fold, it evaluates the folds *before* that fold. Rotation happens only when the latest `foldsWindow` fold(s) all have `hPct <= cacheHitThresholdPct` **and** the recent samples are slow (average TTFT `>=` threshold, or average throughput `<=` threshold).
- **Routing.** A persisted route maps the DSH session id to a generated `ses_...` value. The `llm-pi-ai/request-headers` waterfall runs after pi-ai assembles its header set and before the request is sent, so setting `x-opencode-session` there reaches the wire. In the reference setup a companion injector such as `dsh-opencode-ip-guard` supplies a baseline value equal to the DSH session id; when a route exists this plugin replaces it, and the injector's no-overwrite fallback leaves the value alone.
- **No billion-context, no effect.** If the sessions directory or the session state file is absent, the monitor stays idle. The header hook has no route and does nothing. No exception is thrown into DSH.

The first fold seen after a plugin start is a baseline and never causes rotation. Rotation happens on a later fold, matching "at the next fold rebuild".

A rotation changes the upstream conversation id, so billion-context opens a new state file for the same DSH session. The monitor immediately re-targets to that file and takes a fresh baseline, which lets later folds rotate again instead of watching a conversation that is no longer in use.

## Requirements

- DSH with the `llm-pi-ai` adapter and an OpenCode Go provider (default `opencode-go`).
- billion-context installed and actively saving session state.
- Node.js 20 or newer.

## Install into a DSH profile (local development)

1. Keep this repository somewhere stable, for example `C:/Users/me/DSHs/opencode-router`.
2. In the profile's `package.json`:
   - add the package to `dsh.profile.bundles`;
   - add `"opencode-router": "link:C:/Users/me/DSHs/opencode-router"` to `dependencies`.
3. Make the profile's `node_modules/opencode-router` point at the repository (a directory junction/symlink is enough on Windows).
4. Do **not** add a standalone row for this plugin to the profile's `cordis.patch.yml`. The package declares `dsh.bundle.patch: ./cordis.patch.yml`, which inserts the plugin row itself. A profile row added without an `insert` is only an override and cannot create the row.
5. Restart DSH. In the plugin manager, `opencode-router` should appear as a profile bundle with one row (`include:opencode-router`). If the host was already running before the bundle declaration existed, reload it through the plugin manager or restart DSH.
6. Read the live state at `http://127.0.0.1:<DSH-web-port>/opencode-router/status`.

To change defaults, add an override by row id to the profile's `cordis.patch.yml`:

```yaml
- id: opencode-router
  config:
    cacheHitThresholdPct: 5
```

Because the plugin entry point reloads `lib/impl.js` with a cache-busting query on every `apply`, editing the implementation and touching the plugin config is usually enough to try new code. Changes to `lib/core.js`, `lib/store.js`, or `lib/monitor.js` still need a full DSH restart, because those imports are cached by Node.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false, hooks pass through and the monitor does not run. |
| `providers` | `["opencode-go"]` | Providers eligible for routing. |
| `models` | `[]` | Optional model allow-list; empty means all models of the provider. |
| `cacheHitThresholdPct` | `5` | A fold counts as "cache lost" when `hPct <= this`. |
| `foldsWindow` | `1` | How many recent folds must all be below the cache threshold. |
| `ttftThresholdMs` | `20000` | Average time to first content token at or above this is slow. |
| `throughputThresholdTps` | `60` | Average output tokens/second at or below this is slow. |
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

`GET /opencode-router/status` returns JSON with the effective config, persisted routes, and per-session monitor state:

- `baselineReady` and `lastFoldSeq` — fold cursor;
- `latestFold` — latest fold record (including `hPct`);
- `watchingId` — upstream conversation id of the state file being followed;
- `route` — current rotated routing id, or `null`;
- `samples` — count, average TTFT, average throughput;
- `rotations`, `lastRequestAt`, `lastTickAt`, `lastError`.

The route is localhost-only when the host's web server is bound to localhost. Treat the JSON as diagnostics.

## Privacy and safety

- Stored data is limited to DSH session ids, generated routing ids, fold numbers, cache percentages, TTFT, throughput, and timestamps. No prompts, messages, tool output, or API keys are stored.
- Every host callback catches its own errors. A missing or malformed billion-context state file only produces a log entry.
- Rotating a header is a routing hint, not a guarantee that the gateway picks a different physical backend. If the gateway ignores unknown or new session values, the plugin cannot force a move.
- billion-context's state file is an internal format. If its layout changes, the monitor may see no folds and stay idle; the plugin will not corrupt anything.

## Development

```bash
node --test
```

The suite covers fold parsing, the cache/performance decision, state persistence, the monitor state machine, header routing, and stream measurement.

## License

MIT

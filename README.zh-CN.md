# opencode-router

一个 DeepSeek Harness（DSH）宿主插件：当 billion-context 压缩上下文后丢失了可复用的前缀缓存，**并且**最近几次请求很慢时，在**下一次压缩重建**时给 OpenCode Go 会话换一个新的路由 id。

[English](./README.md)

## 为什么需要它

OpenCode Go 通过请求头 `x-opencode-session` 把一条会话固定到一个上游后端。billion-context 重建上下文后，重建后的第一次请求本应在同一个后端重新预热前缀；如果这次请求的缓存命中率极低，同时最近几次请求又很慢，说明当前后端对该会话很可能不合适。插件会在**下一次**折叠重建时轮换 `x-opencode-session`，让后续请求换一个后端。

插件本身不压缩上下文，也不修改提示词或会话日志；它只改一个路由请求头，并在本地记录耗时统计。

## 工作方式

- **缓存证据。** 读取 billion-context 的会话状态文件（`sessions/openai/<host>_<sha256(sessionId).slice(0,24)>.json`）里的 `metadata.cacheLedger.folds`。每条折叠记录的 `hPct` 就是该次压缩重建后第一条请求的缓存命中率。
- **性能证据。** 包裹 `llm/stream`，记录首个内容 chunk 的时间，并在 finish chunk 计算输出 tok/s；每个 DSH 会话保留最近 `sampleSize` 条有效样本。
- **判定。** 出现新折叠时，只评估**这次新折叠之前**的折叠。最近 `foldsWindow` 次折叠的 `hPct` 都 `<=` 阈值，**并且**最近样本的平均 TTFT `>=` 阈值或平均吞吐 `<=` 阈值，才轮换。
- **路由。** 持久化 "DSH 会话 id -> 生成的 `ses_...` 值" 的映射；`llm-pi-ai/request-headers` 瀑布把 `x-opencode-session` 设为该值。pi-ai 只在请求头不存在时才补自己的值，所以我们的值会生效。
- **没有 billion-context 也能安全存在。** 找不到 sessions 目录或会话状态文件时，监控器保持空闲；请求头钩子没有可用路由时什么也不做；不会向 DSH 抛异常。

插件启动后看到的第一次折叠只作为基线，绝不触发轮换；轮换发生在之后的折叠，符合"在下一次折叠重建时轮换"。

## 依赖

- DSH 使用 `llm-pi-ai` 适配器，并配置了 OpenCode Go provider（默认 `opencode-go`）。
- 已安装并正在写会话状态的 billion-context。
- Node.js 20 及以上。

## 安装到 DSH profile（本地开发）

1. 把本仓库放在稳定位置，例如 `C:/Users/me/DSHs/opencode-router`。
2. 在 profile 的 `package.json` 里：
   - 把包加入 `dsh.profile.bundles`；
   - 在 `dependencies` 里加入 `"opencode-router": "link:C:/Users/me/DSHs/opencode-router"`。
3. 让 profile 的 `node_modules/opencode-router` 指向本仓库（Windows 下目录 junction 或 symlink 均可）。
4. 在 profile 的 `cordis.patch.yml`（顶层 YAML 数组）里加入：

```yaml
- id: opencode-router
  name: "opencode-router"
  config:
    enabled: true
    providers:
      - opencode-go
    cacheHitThresholdPct: 5
    foldsWindow: 1
    ttftThresholdMs: 20000
    throughputThresholdTps: 60
    sampleSize: 5
```

5. 重启 DSH。
6. 访问 `http://127.0.0.1:<DSH Web 端口>/opencode-router/status` 查看实时状态。

插件入口在每次 `apply` 时用带时间戳的查询串重新加载 `lib/impl.js`，所以改实现并碰一下插件配置通常就能生效；但 `lib/core.js`、`lib/store.js`、`lib/monitor.js` 的改动仍需要完整重启 DSH（Node 会缓存这些静态 import）。

## 配置项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；false 时钩子直接透传，监控器不启动。 |
| `providers` | `["opencode-go"]` | 参与路由的 provider。 |
| `models` | `[]` | 可选模型白名单；空表示该 provider 的所有模型。 |
| `cacheHitThresholdPct` | `5` | 折叠的 `hPct <= 该值` 视为丢缓存。 |
| `foldsWindow` | `1` | 最近多少次折叠都必须低于缓存阈值。 |
| `ttftThresholdMs` | `20000` | 平均首内容 token 时间达到该值算慢。 |
| `throughputThresholdTps` | `60` | 平均输出 tok/s 低于等于该值算慢。 |
| `sampleSize` | `5` | 性能判定使用的最近请求数。 |
| `requireFullSamples` | `true` | 必须凑满 `sampleSize` 条样本才轮换。 |
| `routingIdPrefix` | `"ses_"` | 生成路由 id 的前缀。 |
| `statePath` | `$DSH_HOME/storages/opencode-router/state.json` | 持久化路由与耗时样本。 |
| `dryRun` | `false` | 只记录轮换日志，不真正改用新请求头。 |
| `debug` | `false` | 额外 info 日志。 |
| `overrideExistingHeader` | `true` | 是否覆盖已存在的 `x-opencode-session`；false 时保留原值。 |
| `pollIntervalMs` | `2000` | 会话活跃时的轮询间隔。 |
| `requestCheckDelaysMs` | `[400, 1500]` | 请求结束后额外检查状态文件的时间点。 |
| `biliSessionsDir` | `null` | 覆盖 billion-context 的 sessions 根目录。 |
| `biliProtocol` | `"openai"` | 状态文件子目录。 |
| `biliUpstreamHost` | `"opencode.ai"` | 状态文件名里的 host 标签。 |
| `maxSamples` | `20` | 每个会话最多保留的样本数。 |
| `sessionActiveMs` | `600000` | 会话空闲超过该时长后停止轮询。 |
| `minRotationGapMs` | `0` | 同一会话两次轮换的最小间隔。 |

## 状态路由

`GET /opencode-router/status` 返回 JSON：生效配置、已持久化路由、每个会话的监控状态：

- `baselineReady` 与 `lastFoldSeq` —— 折叠游标；
- `latestFold` —— 最新折叠记录（含 `hPct`）；
- `route` —— 当前轮换后的路由 id，或 `null`；
- `samples` —— 样本数、平均 TTFT、平均吞吐；
- `rotations`、`lastRequestAt`、`lastTickAt`、`lastError`。

如果宿主 Web 服务只监听 localhost，该路由也只在 localhost 可达。JSON 仅供诊断。

## 隐私与安全

- 只保存 DSH 会话 id、生成的路由 id、折叠序号、缓存百分比、TTFT、吞吐和时间戳；不保存提示词、消息、工具输出或 API key。
- 所有宿主回调都自行捕获异常。billion-context 状态文件缺失或损坏只会产生日志。
- 轮换请求头只是路由提示，不保证网关一定换到另一台物理后端。如果网关忽略新的会话值，插件无法强制迁移。
- billion-context 的状态文件是内部格式。若其结构变化，监控器可能看不到折叠并保持空闲，但不会破坏任何数据。

## 开发

```bash
node --test
```

测试覆盖折叠解析、缓存/性能判定、状态持久化、监控状态机、请求头路由和流式耗时测量。

## 许可证

MIT

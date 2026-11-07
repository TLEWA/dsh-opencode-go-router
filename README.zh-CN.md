# opencode-router

一个 DeepSeek Harness（DSH）宿主插件：当使用 OpenCode Go 的 DeepSeek 系列模型的会话，在 billion-context 压缩上下文后丢失了可复用的前缀缓存，**并且**最近几次请求很慢时，在**下一次压缩重建**时给 OpenCode Go 会话换一个新的路由 id。

[English](./README.md)

## 为什么需要它

OpenCode Go 通过请求头 `x-opencode-session` 把一条会话固定到一个上游后端。billion-context 重建上下文后，重建后的第一次请求本应在同一个后端重新预热前缀；如果这次请求的缓存命中率偏低（默认 ≤25%），同时最近几次请求又很慢，说明当前后端对该会话很可能不合适。插件会在**下一次**折叠重建时轮换 `x-opencode-session`，让后续请求换一个后端。

只有 OpenCode Go 的 DeepSeek 系列会话会被处理；其他模型即使已有路由值，也不会被本插件改写。

插件本身不压缩上下文，也不修改提示词或会话日志；它只改一个路由请求头，并在本地记录耗时统计。

## 工作方式

- **缓存证据。** 读取 billion-context 的会话状态文件（`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`）里的 `metadata.cacheLedger.folds`。billion-context 按优先级最高的会话请求头推导 `conversationId`：DSH 场景下是 `x-bili-plugin-conversation`（即 DSH 会话 id），`x-opencode-session` 的优先级更低，所以轮换它**不会**改变这个文件，也不会新开文件。每条折叠记录的 `hPct` 就是该次压缩重建后第一条请求的缓存命中率。
- **资格。** 只处理配置的 provider（默认 `opencode-go`）中模型 id 以 `deepseek` 开头（不区分大小写）的请求；`models` 可进一步收窄到具体 DeepSeek 模型。其他模型会被忽略；如果会话最近一次普通对话请求不是合格模型，也会跳过轮换。带 `purpose` 的辅助请求不会改变这个状态。
- **性能证据。** 只包裹合格请求的 `llm/stream`，记录首个内容 chunk 的时间，并在 finish chunk 计算输出 tok/s；每个 DSH 会话保留最近 `sampleSize` 条有效样本。
- **判定。** 出现新折叠时，只评估**这次新折叠之前**的折叠。最近 `foldsWindow` 次折叠的 `hPct` 都 `<=` 阈值，**并且**最近样本的平均 TTFT `>=` 阈值（默认 12000ms）或平均吞吐 `<=` 阈值（默认 60 tok/s），才轮换。
- **路由。** 持久化 "DSH 会话 id -> 生成的 `ses_...` 值" 的映射；`llm-pi-ai/request-headers` 瀑布在 pi-ai 组装完请求头之后、真正发请求之前执行，所以在这里设置 `x-opencode-session` 能到达线上请求。参考配置里由伴生插件（如 `dsh-opencode-ip-guard`）提供兜底值（等于 DSH 会话 id）；有路由时本插件覆盖它，伴生插件的"已有头不覆盖"规则则保证原值不被二次改动。
- **没有 billion-context 也能安全存在。** 找不到 sessions 目录或会话状态文件时，监控器保持空闲；请求头钩子没有可用路由时什么也不做；不会向 DSH 抛异常。

插件启动后看到的第一次折叠只作为基线，绝不触发轮换；轮换发生在之后的折叠，符合"在下一次折叠重建时轮换"。只有会话最近一次普通对话请求仍是 OpenCode Go 的 DeepSeek 系列请求时，该会话才处于合格状态。

轮换只改变上游路由 id。billion-context 仍在同一个状态文件里记录这个 DSH 会话，监控器继续跟踪该文件；记录完触发轮换的那次折叠后，它会把折叠游标推进到该处。同一次重建不会触发两次轮换，但之后的另一次重建仍可再次轮换。

## 依赖

- DSH 使用 `llm-pi-ai` 适配器，并配置了 OpenCode Go provider（默认 `opencode-go`），且至少配置一个 DeepSeek 系列模型（模型 id 以 `deepseek` 开头）。
- 已安装并正在写会话状态的 billion-context。
- Node.js 20 及以上。

## 安装到 DSH profile（本地开发）

1. 把本仓库放在稳定位置，例如 `C:/Users/me/DSHs/opencode-router`。
2. 在 profile 的 `package.json` 里：
   - 把包加入 `dsh.profile.bundles`；
   - 在 `dependencies` 里加入 `"opencode-router": "link:C:/Users/me/DSHs/opencode-router"`。
3. 让 profile 的 `node_modules/opencode-router` 指向本仓库（Windows 下目录 junction 或 symlink 均可）。
4. **不要**再往 profile 的 `cordis.patch.yml` 里手动加本插件的独立行。包内已声明 `dsh.bundle.patch: ./cordis.patch.yml`，由它插入插件行；不带 `insert` 的 profile 行只是覆盖项，创建不了插件行。
5. 重启 DSH。插件管理器里 `opencode-router` 应显示为 profile bundle，并有一行 `include:opencode-router`。如果宿主在 bundle 声明存在之前就已经启动，用插件管理器重新加载，或重启 DSH。
6. 访问 `http://127.0.0.1:<DSH Web 端口>/opencode-router/status` 查看实时状态。

要改默认值，在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: opencode-router
  config:
    cacheHitThresholdPct: 25
```

插件入口在每次 `apply` 时用带时间戳的查询串重新加载 `lib/impl.js`，所以改实现并碰一下插件配置通常就能生效。运行中的宿主里，用插件管理器把 profile bundle 关掉再打开，也会重新加载静态 import（`lib/core.js`、`lib/store.js`、`lib/monitor.js`）；0.1.2 -> 0.1.3 的阈值改动就是这样验证生效的。如果状态仍显示旧版本，再完整重启 DSH。

## 配置项

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；false 时钩子直接透传，监控器不启动。 |
| `providers` | `["opencode-go"]` | 参与路由的 provider；模型仍必须是 `deepseek*`。 |
| `models` | `[]` | 可选的 DeepSeek 精确模型白名单；空表示该 provider 的任意 `deepseek*` 模型。 |
| `cacheHitThresholdPct` | `25` | 折叠的 `hPct <= 该值` 视为丢缓存。 |
| `foldsWindow` | `1` | 最近多少次折叠都必须低于缓存阈值。 |
| `ttftThresholdMs` | `12000` | 平均首内容 token 时间达到该值算慢。 |
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

- `eligibility` —— 配置的 provider 与固定的 `deepseek` 模型前缀；
- `baselineReady` 与 `lastFoldSeq` —— 折叠游标；
- `latestFold` —— 最新折叠记录（含 `hPct`）；
- `watchingId` —— 当前跟踪的 billion-context 状态文件所属的 DSH 会话 id；
- `route` —— 当前轮换后的路由 id，或 `null`；
- `targetActive` —— 会话最近一次普通对话请求是否为合格的 OpenCode Go DeepSeek 请求；false 时禁止轮换；
- `samples` —— 样本数、平均 TTFT、平均吞吐；
- `rotations`、`lastRequestAt`、`lastTickAt`、`lastError`；
- `routing` —— 请求头钩子的计数与最近一次判定：`checks`、`applications`、`lastCheckedAt`、`lastCheckedSessionId`、`lastAppliedAt`、`lastAppliedSessionId`、`lastAppliedValue`、`lastReason`。`lastReason` 取值为 `applied`、`no-route`、`existing-header`、`no-headers`、`disabled` 或 `not-target`。

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

测试覆盖折叠解析、缓存/性能判定、仅 DeepSeek 资格、状态持久化、监控状态机、请求头路由和流式耗时测量。

## 许可证

MIT

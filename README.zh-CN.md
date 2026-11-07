# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](./README.zh-CN.md) · [English](./README.md)

一个 DeepSeek Harness（DSH）宿主插件：当使用 OpenCode Go 的 DeepSeek 系列模型的会话，在 billion-context 压缩上下文后丢失了可复用的前缀缓存，**并且**最近几次请求很慢时，为会话换一个新的路由 id。安装可选的 billion-context 折叠前补丁后，切换发生在下一次折叠重建本身、重建请求转发之前，因此不会因为换路由再增加一次缓存未命中。没有补丁时回退到本来就会冷的请求（系统提示词改写）或很可能已经变冷的请求（长时间空闲后的第一条请求）上。

这是内部插件 id 为 `opencode-router` 的 DSH 插件的 npm 包。它只轮换 OpenCode Go 的路由请求头，不是模型适配器。

## 为什么需要它

OpenCode Go 通过请求头 `x-opencode-session` 把一条会话固定到一个上游后端。billion-context 重建上下文后，重建后的第一次请求本应在同一个后端重新预热前缀；如果这次请求的缓存命中率偏低（默认 ≤25%），同时最近几次请求又很慢，说明当前后端对该会话很可能不合适。

在重建后轮换会多出第二次冷请求：重建后的第一条请求在旧后端是冷的，换到新后端后的第一条请求又冷一次。billion-context 是在重建请求完成后才写入折叠记录，所以只看记录文件的插件总是慢一条请求。但它的代理在转发重建请求之前，已经知道这次要重建。

可选的折叠前补丁就在这个位置加一个本机回调：插件发布一个带随机 Bearer token 的本地端点，代理在发出重建请求前询问该会话是否有一个待切换；如果有，就把返回的 `x-opencode-session` 写到重建请求上再转发。重建请求在哪个后端都是冷的；换到新路由后，它成为新后端上的第一条冷请求，而不是后面再补一次冷请求。由于折叠记录不可能提供请求发生前的信号，这是唯一能真正消除额外未命中的可靠方式。

没有补丁时，插件先记住判定，等到本来就会冷的请求再应用：系统提示词改写（前缀无论如何都会变），或空闲超过 `foldDeferIdleMs` 后的第一条请求（上游前缀缓存很可能已过期）。判定与切换之间可能隔着若干条请求；之后出现健康的折叠会清除待切换。

只有 OpenCode Go 的 DeepSeek 系列会话会被处理；其他模型即使已有路由值，也不会被本插件改写。

系统提示词改写本身就会使可复用前缀失效。携带改写的请求无论发到哪个后端都是冷请求，因此检测到这种改写且最近请求很慢时，插件会为同一个请求轮换：把换路由的冷请求和改写本身的冷请求合并为一次不可避免的未命中。这条路径忽略上一次折叠的缓存条件（改写后的命中率本来就不会健康），但仍要求性能条件成立。如果已经有一个折叠触发的待切换，改写会消费它：路由保留折叠的缓存证据，但使用当前性能窗口，并记录 `reason: "fold-deferred"`。

如果连续切换后仍然落在达不到基础目标的后端上，插件会把下一次触发条件放宽，而不是重复等价切换：每次切换后窗口仍然慢于 `ttftThresholdMs` 或 `throughputThresholdTps`，就累计一步，下一次判定获得 `stepTtftGraceMs`（默认 2 秒）的额外 TTFT 宽限和 `stepThroughputGraceTps`（默认 5 tok/s）的吞吐下调。某个切换后窗口达到基础目标后，步进归零。失败始终按基础目标认定，不按已经放宽的目标认定。

插件本身不压缩上下文，也不修改提示词或会话日志；它只改一个路由请求头，并在本地记录耗时统计。

## 工作方式

- **缓存证据。** 读取 billion-context 的会话状态文件（`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`）里的 `metadata.cacheLedger.folds`。billion-context 按优先级最高的会话请求头推导 `conversationId`：DSH 场景下是 `x-bili-plugin-conversation`（即 DSH 会话 id），`x-opencode-session` 的优先级更低，所以轮换它**不会**改变这个文件，也不会新开文件。每条折叠记录的 `hPct` 就是该次压缩重建后第一条请求的缓存命中率。
- **资格。** 只处理配置的 provider（默认 `opencode-go`）中模型 id 以 `deepseek` 开头（不区分大小写）的请求；`models` 可进一步收窄到具体 DeepSeek 模型。其他模型会被忽略；如果会话最近一次普通对话请求不是合格模型，也会跳过轮换。带 `purpose` 的辅助请求不会改变这个状态。
- **性能证据。** 只包裹合格请求的 `llm/stream`，记录首个内容 chunk 的时间，并在 finish chunk 计算输出 tok/s；每个 DSH 会话保留最近 `sampleSize` 条有效样本。
- **判定。** 出现新折叠时，只评估**这次新折叠之前**的折叠。最近 `foldsWindow` 次折叠的 `hPct` 都 `<=` 阈值，**并且**最近样本的平均 TTFT `>=` 阈值（默认 12000ms）或平均吞吐 `<=` 阈值（默认 60 tok/s），才记录为待切换。性能目标会被上文的连续失败步进放宽。`foldRotationMode: "immediate"` 恢复 0.2.1 的“在折叠时立即切换”行为；`"off"` 关闭折叠触发的切换。
- **折叠前衔接（可选补丁）。** 启用 `preFoldHook` 时，插件在 `127.0.0.1` 上监听一个随机端口，并把 URL 与随机 Bearer token 写入 `$DSH_HOME/storages/opencode-router/pre-fold-hook.json`。可选的 billion-context 补丁读取该描述文件，在重建请求体已经生成、尚未转发时调用 `POST /pre-fold`。端点只接受带 token 的本机 POST，并且只消费已经存在的待切换判定。没有补丁时不会有人调用这个钩子，插件走下面的延后路径。
- **应用切换。** 有折叠前衔接时，下一次折叠重建会消费待切换：插件轮换路由并返回新值，重建请求本身直接发到新路由。没有衔接时，插件在本来就会冷的请求之前应用待切换：系统提示词改写路径，或会话空闲达到 `foldDeferIdleMs`（默认 5 分钟）后的第一条合格请求。`foldDeferMaxMs` 和 `foldDeferMaxRequests` 可以在超过限制后强制切换；两者默认都是 `0`（不强制），因为不在冷请求上强制仍可能多出那次未命中。之后出现证据健康的折叠会清除待切换。
- **系统提示词改写。** 在 `llm/stream` 中按 pi-ai 的方式提取初始系统提示词（`options.system` 加上开头的 `system` 消息）并按会话计算指纹。指纹变化时，在请求头组装之前写入路由，使携带改写的同一个请求也携带新路由 id。该路径只使用性能条件（绕过折叠缓存条件）；没有待切换时路由记录 `reason: "system-rewrite"`。这次改写随后引发的折叠会被保护，不会为同一次未命中二次轮换。
- **路由。** 持久化 "DSH 会话 id -> 生成的 `ses_...` 值" 的映射；`llm-pi-ai/request-headers` 瀑布在 pi-ai 组装完请求头之后、真正发请求之前执行，所以在这里设置 `x-opencode-session` 能到达线上请求。参考配置里由伴生插件（如 `dsh-opencode-ip-guard`）提供兜底值（等于 DSH 会话 id）；有路由时本插件覆盖它，伴生插件的"已有头不覆盖"规则则保证原值不被二次改动。
- **没有 billion-context 也能安全存在。** 找不到 sessions 目录或会话状态文件时，监控器保持空闲；请求头钩子没有可用路由时什么也不做；不会向 DSH 抛异常。

插件启动后看到的第一次折叠只作为基线，绝不触发轮换；这条基线规则只约束折叠路径。之后满足两项条件的折叠会变成**待切换**，而不是立即切换。系统提示词改写路径不依赖任何折叠：即使会话从未记录过折叠，只要系统提示词发生变化且最近样本性能慢，也可以在改写请求本身上轮换（折叠缓存条件被绕过）。会话中第一次看到的系统提示词只作为指纹基线；改写轮换需要之后观察到实际变化。只有会话最近一次普通对话请求仍是 OpenCode Go 的 DeepSeek 系列请求时，该会话才处于合格状态。

轮换只改变上游路由 id。billion-context 仍在同一个状态文件里记录这个 DSH 会话，监控器继续跟踪该文件；记录完让切换挂起的那次折叠后，它会把折叠游标推进到该处。同一次重建不会让切换挂起两次，但之后的另一次重建仍可再次挂起。待切换会跨过普通的热请求继续保留；有折叠前衔接时在下一次折叠重建应用，否则只在自然冷请求、安全阀强制时应用，或当之后的折叠不再满足缓存/性能条件时清除。

## 依赖

- DSH 使用 `llm-pi-ai` 适配器，并配置了 OpenCode Go provider（默认 `opencode-go`），且至少配置一个 DeepSeek 系列模型（模型 id 以 `deepseek` 开头）。
- 已安装并正在写会话状态的 billion-context。
- 可选但推荐：能被补丁脚本识别的 billion-context 包，用于精确消除额外冷请求。不装补丁时插件仍可用延后路径。
- DSH 0.2.1-rc.5 及以上、0.3.0 以下。
- Node.js 20 及以上。

## 从 npm 安装

```bash
dsh plugin add dsh-opencode-go-router --profile <profile>
```

也可以在 DSH 插件管理器的「添加插件」框里填入 `dsh-opencode-go-router`。包内声明了 `dsh.bundle.patch`，正常安装会创建 `opencode-router` 行；不要再往 profile 里手动加一条独立行。

## 折叠前补丁（可选）

补丁才会让重建请求本身使用新路由。它修改 billion-context 的打包代理，所以 npm 安装不会、也不应该自动应用。每个 billion-context 安装运行一次，然后重启或重载 billion-context 代理进程。

在 DSH profile 目录中：

```bash
cd "$DSH_HOME/profiles/<profile>"
node node_modules/dsh-opencode-go-router/scripts/patch-billion-context.mjs --check
node node_modules/dsh-opencode-go-router/scripts/patch-billion-context.mjs --apply
```

在本仓库中：

```bash
node scripts/patch-billion-context.mjs --check
node scripts/patch-billion-context.mjs --apply
```

脚本默认搜索 `$DSH_HOME/profiles/*/node_modules/billion-context/dist/index.js`；可以用 `--file <path>` 或 `--profile <name>` 指定。`--check` 在已打补丁时退出码为 `0`，未打补丁为 `1`，包内没有唯一的 `outbound=rebuilt;` 锚点时视为不支持并返回 `4`。`--apply` 会在包旁边保留 `.opencode-router.bak`，重复执行是幂等的；`--revert` 从该备份恢复。升级 billion-context 会覆盖 `dist/index.js`，升级后需要重新执行 `--check` 和 `--apply`。

打过补丁的代理只会调用插件描述文件里的本机 URL 和 Bearer token。插件被禁用或描述文件不存在时，回调静默失败，请求走未打补丁的路径。

## 从本地仓库安装（开发）

1. 把本仓库放在稳定位置，例如 `C:/Users/me/DSHs/opencode-router`。
2. 在 profile 的 `package.json` 里：
   - 把 `dsh-opencode-go-router` 加入 `dsh.profile.bundles`；
   - 在 `dependencies` 里加入 `"dsh-opencode-go-router": "link:C:/Users/me/DSHs/opencode-router"`。
3. 让 profile 的 `node_modules/dsh-opencode-go-router` 指向本仓库（Windows 下目录 junction 或 symlink 均可）。
4. **不要**再往 profile 的 `cordis.patch.yml` 里手动加本插件的独立行。包内已声明 `dsh.bundle.patch: ./cordis.patch.yml`，由它插入插件行；不带 `insert` 的 profile 行只是覆盖项，创建不了插件行。
5. 重启 DSH。插件管理器里 `dsh-opencode-go-router` 应显示为 profile bundle，并有一行 `include:opencode-router`。如果宿主在 bundle 声明存在之前就已经启动，用插件管理器重新加载，或重启 DSH。
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
| `cacheHitThresholdPct` | `25` | 折叠的 `hPct <= 该值` 视为丢缓存；系统提示词改写轮换不适用。 |
| `systemRewriteBypassCache` | `true` | 系统提示词变化时，即使上一次折叠的缓存命中健康也轮换；仍要求性能变慢。 |
| `foldsWindow` | `1` | 最近多少次折叠都必须低于缓存阈值。 |
| `foldRotationMode` | `"defer"` | `defer` 只在本来就会冷的请求前应用折叠触发的切换；`immediate` 在折叠时立即切换（0.2.1 行为）；`off` 关闭折叠触发的切换（系统提示词改写仍会轮换）。 |
| `foldDeferIdleMs` | `300000` | `defer` 模式下，会话空闲达到该时长后，在第一条合格请求前轮换；`0` 关闭空闲触发。 |
| `foldDeferMaxMs` | `0` | 待切换存在超过该时长后强制切换；`0` 关闭该安全阀。 |
| `foldDeferMaxRequests` | `0` | 待切换之后已经过去这么多条合格请求时，在下一条请求前强制切换；`0` 关闭该安全阀。 |
| `preFoldHook` | `true` | 提供可选的 billion-context 补丁调用的本机 `POST /pre-fold` 端点；`false` 关闭衔接，只保留延后路径。 |
| `preFoldHookPath` | `$DSH_HOME/storages/opencode-router/pre-fold-hook.json` | 写给补丁代理的描述文件路径；只有代理读取自定义路径时才需要改。 |
| `ttftThresholdMs` | `12000` | 基础平均首内容 token 时间达到该值算慢。 |
| `throughputThresholdTps` | `60` | 基础平均输出 tok/s 低于等于该值算慢。 |
| `stepTtftGraceMs` | `2000` | 每次连续失败切换，下一次 TTFT 目标放宽这么多。 |
| `stepThroughputGraceTps` | `5` | 每次连续失败切换，下一次吞吐目标下调这么多（下限 `0.01`）。 |
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

`GET /opencode-router/status` 返回 JSON：生效配置、已持久化路由、轮换性能记录、每个会话的监控状态：

- `history` —— 最近的静默切换记录，最新在前，字段包括 `sessionId`、`at`、`reason`、`foldSeq`、`cacheHitPct`、`step`、路由 `value`、切换前后 TTFT/吞吐、样本进度和 `backfilled` 标记；延后应用的折叠切换记录 `reason: "fold-deferred"`，由折叠前衔接应用的记录 `reason: "fold-preflight"`；
- `eligibility` —— 配置的 provider 与固定的 `deepseek` 模型前缀；
- `baselineReady` 与 `lastFoldSeq` —— 折叠游标；
- `latestFold` —— 最新折叠记录（含 `hPct`）；
- `watchingId` —— 当前跟踪的 billion-context 状态文件所属的 DSH 会话 id；
- `route` —— 当前轮换后的路由 id，或 `null`；其 `reason` 为 `cache-and-performance`、`fold-deferred`、`fold-preflight` 或 `system-rewrite`，`step` 为该次切换使用的失败步进；
- `targetActive` —— 会话最近一次普通对话请求是否为合格的 OpenCode Go DeepSeek 请求；false 时禁止轮换；
- `systemPromptFp` —— 最近观察到的初始系统提示词指纹，或 `null`；
- `systemRewriteBypassCache`、`systemRewriteRotations`、`lastSystemRewriteAt` —— 改写轮换的配置与计数；
- `foldRotationMode`、`pendingRotation`、`deferredRotations`、`lastDeferredAt` —— 折叠切换模式、待切换（存在时长、折叠序号、缓存命中、步进、已错过的请求数和触发时均值）、创建过多少次待切换，以及最近一次创建时间；
- `preFoldHook` —— 本机端点状态：`enabled`、`listening`、`path`、`url`、`port`、请求/拒绝/轮换计数、`lastRequestAt`、`lastError` 与 `lastDecision`；
- `preflightRotations`、`lastPreflightAt` —— 由折叠前衔接消费的切换次数与最近一次时间；
- `stepping` —— 当前步进 `step`、连续失败数 `consecutiveFailures`、基础与生效的 TTFT/吞吐阈值，以及每步宽限值；
- `samples` —— 样本数、平均 TTFT、平均吞吐；
- `rotations`、`lastRequestAt`、`lastTickAt`、`lastError`；
- `routing` —— 请求头钩子的计数与最近一次判定：`checks`、`applications`、`lastCheckedAt`、`lastCheckedSessionId`、`lastAppliedAt`、`lastAppliedSessionId`、`lastAppliedValue`、`lastReason`。`lastReason` 取值为 `applied`、`no-route`、`existing-header`、`no-headers`、`disabled` 或 `not-target`。

如果宿主 Web 服务只监听 localhost，该路由也只在 localhost 可达。JSON 仅供诊断。

## 设置页

在 DSH Web 客户端打开插件管理器，选中本插件。详情页会在 bundle 配置行上方显示 **静默切换性能记录**。

每条记录展示切换时间、短会话 id、触发原因（`折叠 + 性能`，包括延后应用的折叠切换；折叠前衔接应用时显示 `折叠重建衔接`；或 `系统提示词改写`）、触发时的折叠序号与缓存命中率、失败步进（大于 0 时）、切换前的平均 TTFT/吞吐、切换后首批 `sampleSize` 条合格样本，以及变化百分比。面板顶部还会显示最近活跃会话的步进与生效阈值，并说明每步宽限规则。数据来自 `GET /opencode-router/status`，每五秒刷新一次。切换后的采样窗口凑满 `sampleSize` 条后即冻结，之后的流量不会改写历史。

0.2.0 之前已经写入的路由会按“每个仍保留的路由一行”补录，并标记为 `补录`；其切换后数值来自该次轮换之后仍保留的样本。面板只存在于 Web 客户端，不影响宿主侧路由。

## 隐私与安全

- 只保存 DSH 会话 id、生成的路由 id、折叠序号、缓存百分比、TTFT、吞吐、轮换性能记录和时间戳；不保存提示词、消息、工具输出或 API key。
- 所有宿主回调都自行捕获异常。billion-context 状态文件缺失或损坏只会产生日志。
- 折叠前端点只绑定 `127.0.0.1`、只接受 POST，并要求描述文件中的 32 字节随机 Bearer token。描述文件在平台支持时以仅当前用户可读的权限写入，插件卸载时删除。补丁拒绝任何非本机 HTTP 的回调地址。
- 轮换请求头只是路由提示，不保证网关一定换到另一台物理后端。如果网关忽略新的会话值，插件无法强制迁移。
- billion-context 的状态文件是内部格式。若其结构变化，监控器可能看不到折叠并保持空闲，但不会破坏任何数据。

## 开发

```bash
node --test
```

测试覆盖折叠解析、缓存/性能判定、连续失败步进规则、延后折叠切换及其安全阀、折叠前衔接与 localhost 端点鉴权、billion-context 补丁的幂等/备份/恢复、系统提示词提取与指纹、系统提示词改写判定、仅 DeepSeek 资格、状态持久化、轮换性能记录、监控状态机、请求头路由、流式耗时测量和客户端 bundle 注册。

## 许可证

MIT

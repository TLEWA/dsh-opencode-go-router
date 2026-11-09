# 更新日志

本项目的所有重要变更都记录在这里，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.1] - 2026-11-09

### 新增

- 未安装 billion-context 时也能统计：状态路由新增 `billionContext`、`statistics`、`requests`、`poolEvents`。插件自行采样每条合格请求，设置页显示平均命中率、热/冷次数、平均 TTFT 与吞吐；折叠诊断不可用时页面会明确提示，并隐藏折叠标记。
- 设置页新增「池替换记录」和「缓存命中记录」。前者显示 code 复用/收回、来源会话、匹配率、层级、借出方 TTFT/吞吐与样本数；后者只显示每次从池中复用 code 后的第一条请求；同一会话收回自己的 code 不算池替换，不显示；首请求快照随池事件持久化，200 条请求记录淘汰后仍可查看。每条显示命中率、TTFT、吞吐、提示词与缓存读取 token 数。
- 设置页新增「两级池 session code」列表：按一级/二级分组显示池中每个 code 的会话、code 原文、是否合格、TTFT、吞吐、样本进度、评分、空闲时长、摘要大小与入池时间；不合格条目会说明原因。
- 状态文件新增最近 200 条请求和 100 条池事件（`requests`、`poolEvents`），加载时清洗字段并限制长度。
- 设置页新增「池效果（首请求命中）」：对比借入 code 的会话与全新 code 会话的首条请求命中率，显示样本数、平均匹配率与差值（百分点）；首请求已离开请求记录的事件会被跳过。

### 变更

- 入池门槛收紧：老 code 的平均吞吐必须严格高于 `poolMinTps`（默认 80 tok/s），平均 TTFT 不得超过 `poolMaxTtftMs`（默认 8000 ms，8 秒含边界）。不达标的 code 保持活跃，不再进入池，避免把慢 code 借给新会话。
- 二级池不再要求前缀匹配率达到 `poolMatchPct`；该门槛只保留在一级池。二级池仍要求样本、TTFT、吞吐与年龄合格，并按速度评分排序。
- 会话复苏不再走一二级池或匹配：只要自己的 code 仍空闲就直接收回，不检查匹配率、层级、样本或速度；如果 code 已经借给别的会话，则保留换回来的新 code，不再借入其他 code。
- 池的复用/收回事件同时写入状态路由与历史，设置页据此展示。

### 修复

- 修复池效果指标把「环里最早的一条请求」当成首请求的问题。路由现在记录该 code 窗口的第一条请求时间（`firstRequestAt`），并把首请求快照写入借入池事件；请求记录被 200 条环淘汰后仍按快照计入，而不是跳过或把后来的热请求误记为首请求（c726e104 的 0% 曾被误报成 99.1%）。

### 测试

- 新增入池门槛、请求/池事件日志、统计汇总、无 billion-context 时的状态负载，以及客户端提示、两个日志区（缓存日志只保留池复用后的首请求）、两级池 code 列表的测试；新增二级池无匹配门槛、复苏直取、首请求标记、首请求快照、环淘汰回归测试与客户端池效果显示测试；全套 79 项通过。

## [0.6.0] - 2026-11-09

### 新增

- **两级热路由 id 池**（默认开启）。合格会话空闲达到 `poolIdleMs`（默认 3 分钟）且没有进行中的回合、工具调用、确认或后台任务，或者会话被归档时，它的 `x-opencode-session` code 入池。新会话需要 code 时，若池中老会话的前缀匹配达到 `poolMatchPct`（默认 60%），且老会话最近样本的平均 TTFT `<=` `poolMaxTtftMs`（默认 10 秒）、平均吞吐 `>` `poolMinTps`（默认 70 tok/s），就把两边的 code 交换：新会话直接拿到老会话的 code、摘要和样本，老会话拿到新生成的 code 并休眠，避免新会话冷启动。多个合格候选取匹配率最高者。
- 前缀匹配只保存分块 SHA-256 摘要，不保存提示词原文；匹配率 = 两个摘要的共同前缀块数 / 新会话的块数。块大小 `poolDigestChunkChars`（默认 512 字符），最多 `poolDigestMaxChars`（默认 262144 字符）。
- 一级池是不活跃时间小于 `poolTier1Ms`（默认 1 小时）的 code；只有一级池没有合格候选时才使用二级池（1–24 小时），二级池按 `score = -(TTFT 秒 × 10) + 吞吐` 取最大。不活跃超过 `poolExpireMs`（默认 24 小时）的 code 从两级池中剔除，也不能再入池。
- 会话复苏先取池：自己的 code 仍在池中且前缀匹配自己时直接回收；否则尝试其他候选；没有候选就退回新生成（`pool-fallback`），不会继续使用已休眠的旧 code。
- 新增 11 项池配置：`poolEnabled`、`poolIdleMs`、`poolMatchPct`、`poolMinTps`、`poolMaxTtftMs`、`poolSampleSize`、`poolTier1Ms`、`poolExpireMs`、`poolMaxEntries`、`poolDigestChunkChars`、`poolDigestMaxChars`。`poolMaxEntries` 限制池大小，超出时淘汰最久不活跃的 code；被淘汰的 code 在会话重新活跃前不会再次入池，避免池满时空闲扫描反复入池/淘汰。

### 变更

- 池开启时，会话的第一条合格请求就会创建持久化路由，即使当次不需要轮换；这个路由是之后入池、交给别人的对象。把 `poolEnabled` 设为 `false` 可保留 0.6 之前的行为：只有发生轮换才创建路由，未轮换会话沿用宿主或配套注入器提供的请求头。0.6 之前创建的路由没有前缀摘要，不会被扫描入池，直到会话发出下一条请求补齐摘要。
- 每条性能记录新增 `version` 与 `thresholds`（基础/生效 TTFT 与吞吐目标、失败步进）。设置页按当时生效的阈值解释每次切换；没有阈值的旧记录标记为旧版记录，不再让用户拿今天的默认值去质疑一次历史切换。
- 状态路由新增 `pool` 与 `activity`；`routes` 只暴露摘要块数 `digestChunks` 和样本摘要 `poolSamples`，不返回摘要数组；`skipReason` 新增 `pool-adopted`、`pool-revived`；路由与历史新增 `pool-adopted`、`pool-donated` 原因及 `poolMatchPct`、`poolTier`、`poolScore`、`poolSourceSessionId`、`poolRole` 字段。
- 设置页显示池大小、两级数量、合格数、最近复用，以及每条记录的池匹配率与层级。

### 修复

- 绑定样本少于 `poolSampleSize` 的 code 不再入池。此前这类 code 会占住池位却在选择时因样本不足被跳过，会话复苏时只能退回新生成 code，反而丢失原本可继续使用的路由 id。
- 旧版本记录不再被当作“按当前阈值发生的一次切换”展示：有 `thresholds` 时显示触发阈值，没有时明确标注“旧版记录，未记录触发阈值”。

### 测试

- 新增活动跟踪（回合、工具、确认、后台任务）、前缀摘要、两级池选择、code 交换、会话复苏与回退、过期剔除、空闲与归档入池，以及客户端池显示的测试。

## [0.5.0] - 2026-11-08

### 变更

- 轮换改为**请求前预测缓存命中**：每条合格的 `llm/stream` 请求在发出前，插件用当时已知的信号预测这次请求的上游前缀缓存命中率；预测 `<=` `cacheHitThresholdPct`（默认 25%）且最近请求很慢时，立刻换路由 id，让新路由作用于这条请求本身。判定发生在请求发出之前，因此不会再出现“先冷一次、换路由后再冷一次”。
- 预测依据按优先级排列：系统提示词改写、消息历史被压缩 → 0%；还没有任何样本 → 未知（不轮换）；空闲达到 `cacheTtlMs`（默认 1 小时）→ 0%；上次命中 `>=` 80% → 沿用；上次是“大前缀 + 低命中”的完整 prefill（折叠重建的特征）→ 按热处理（实测 95–99%），因为那次 prefill 已经把新前缀写进上游缓存；其余情况沿用上次命中，`<=` 阈值即判冷。
- 实测依据：折叠重建请求本身是冷的（命中 0–82%），但紧随其后的请求命中 95–99%；15–60 分钟空闲仍多数命中，只有数小时级空闲才普遍变冷。0.2.x 在折叠后立即轮换确实丢掉了一次热请求，0.5.0 的预测把这些情形判为热。
- 新增 `predictiveRotation`（默认 `true`）、`cacheTtlMs`（默认 `3600000`）、`prefillMinTokens`（默认 `4000`）。删除 `foldsWindow`、`systemRewriteBypassCache`、`foldRotationMode`、`foldDeferIdleMs`、`foldDeferMaxMs`、`foldDeferMaxRequests`；折叠账本保留为诊断证据，不再直接触发轮换。
- 切换记录与路由的 `reason` 统一为 `predicted-cold`，并新增 `basis`（`system-rewrite` / `history-compacted` / `no-history` / `no-cache-data` / `idle-expired` / `warm-history` / `fold-rebuild-prefilled` / `prefilled` / `cache-miss-persists` / `partial-cache`）。样本新增 `inputTokens`、`cacheReadTokens`、`hitPct`。

### 移除

- 移除 0.4.0 的折叠前衔接：`POST /pre-fold` 端点、`preFoldHook` / `preFoldHookPath` 配置、`preflightRotations` / `lastPreflightAt` 状态，以及 `scripts/patch-billion-context.mjs`。不再需要修改 billion-context 的 `dist`；旧记录里的 `fold-preflight` 原因在设置页显示为「缓存 + 性能」。之前给 billion-context 打过补丁的机器，用同目录下的 `index.js.opencode-router.bak` 还原 `index.js`（或重装 billion-context）后重启 DSH 即可。

### 状态

- 状态路由新增 `lastPrediction`、`predictions`、`predictiveRotation`、`cacheHitThresholdPct`、`cacheTtlMs`、`messageCount`、`lastSample`；删除 `foldRotationMode`、`pendingRotation`、`deferredRotations`、`lastDeferredAt`、`systemRewriteRotations`、`lastSystemRewriteAt`。
- 设置页性能记录把触发原因显示为「预测冷请求」或「系统提示词改写」。

## [0.4.0] - 2026-11-08

### 新增

- **折叠前衔接**：插件在 `127.0.0.1` 上启动 `POST /pre-fold` 端点并发布描述文件；可选的 billion-context 补丁在重建请求体生成后、转发前回调，插件把待切换应用到这条重建请求本身。重建本来就要冷一次，换路由与这次冷 prefill 合并，不再额外多一次冷请求。
- 补丁同时挂接两条重建路径：显式压缩走初始 `runPrepare`，自动折叠走 `preflightCompressIfNeeded`；两者都会在转发前询问插件。
- 新增补丁脚本 `scripts/patch-billion-context.mjs`，支持 `--check` / `--apply` / `--revert`、自动发现 profile 内的 billion-context、幂等打补丁，并保留 `.opencode-router.bak` 备份。
- 新增 `preFoldHook`（默认 `true`）与 `preFoldHookPath` 配置。未打补丁或关闭衔接时，插件仍使用 0.3.0 的延后路径，不会报错。

### 状态

- 状态路由新增 `preFoldHook`、`preflightRotations`、`lastPreflightAt`；切换历史与路由新增 `reason: "fold-preflight"`。
- 设置页把折叠前衔接应用的切换显示为「折叠重建衔接」。

## [0.3.0] - 2026-11-08

### 变更

- 折叠触发的轮换默认改为**延后应用**：billion-context 在重建请求完成后才写入折叠记录，插件看到折叠时重建请求已经发出；立即轮换会在这次冷请求之后再增加一次冷 prefill。现在插件先保存判定，等到预计会冷的请求再切换：系统提示词改写，或会话空闲达到 `foldDeferIdleMs`（默认 5 分钟）后的第一条合格请求。
- 新增 `foldRotationMode`（`defer` / `immediate` / `off`）、`foldDeferIdleMs`、`foldDeferMaxMs`、`foldDeferMaxRequests`。`immediate` 恢复 0.2.1 的折叠时立即切换行为；`off` 关闭折叠触发切换，系统提示词改写路径不受影响。
- 待切换会在之后的折叠不再满足缓存/性能条件时清除；安全阀默认关闭，除非显式配置，否则不会强制切换并制造额外冷请求。

### 状态

- 状态路由新增 `foldRotationMode`、`pendingRotation`、`deferredRotations`、`lastDeferredAt`；切换历史与路由的 `reason` 新增 `fold-deferred`。
- 设置页性能记录把延后应用的折叠切换归入「折叠 + 性能」触发显示。

## [0.2.1] - 2026-11-08

### 新增

- 连续失败切换步进：每次切换后的完整采样窗口仍慢于基础目标时，下一次 TTFT 阈值放宽 2 秒、吞吐阈值下调 5 tok/s；某个窗口达到基础目标后步进归零。失败始终按基础目标判定。
- 新增 `stepTtftGraceMs` / `stepThroughputGraceTps` 配置，状态路由和切换记录新增 `step`，并在 `sessions.stepping` 暴露当前步进与生效阈值。
- 设置页性能面板显示每次切换的步进、最近活跃会话的生效阈值和每步宽限规则。

## [0.2.0] - 2026-11-08

### 新增

- 持久化每次静默切换的性能记录：切换前的触发样本，以及切换后首批 `sampleSize` 条请求的平均 TTFT/吞吐；采样窗口满后冻结。
- 在 DSH Web 宿主中新增插件设置页性能面板，展示每次切换的前后速度、变化百分比和采样进度；每五秒刷新。
- 状态路由新增顶层 `history` 数组；旧版本留下的路由会补录为历史行并标记 `backfilled`。
- 新增客户端 bundle（`dsh.client`）及注册测试。

### 修复

- 插件设置页的触发条件不再把吞吐阈值显示成 `?`。
- `cordis.patch.yml` 的插入名与 npm 包名保持一致，避免客户端的 `dsh.client` 声明被宿主跳过。

## [0.1.6] - 2026-11-08

### 修复

- 修复测试在 Linux CI 上的路径可移植性问题，并在清理临时目录前等待状态文件写入完成。

## [0.1.5] - 2026-11-08

首个公开版本。

### 新增

- 监控 billion-context 的折叠记录：当最近一次重建后的缓存命中不高于配置阈值（默认 25%），且最近 5 次请求的 TTFT 或吞吐达到慢速条件时，在下一个折叠重建后轮换 `x-opencode-session`。
- 系统提示词改写检测：在 `llm/stream` 的请求头生成前比较初始 system prompt 指纹；改写请求跳过折叠缓存条件，但仍要求最近请求变慢，并把换路由的冷请求与改写本身的冷请求合并。
- 仅对 OpenCode Go 的 `deepseek*` 模型会话生效；非目标请求不会触发轮换，也不会创建监控。
- 无 billion-context 时保持空闲；状态可通过 `GET /opencode-router/status` 查看。
- 自动轮换、手动/持久化路由、同一折叠不重复轮换、系统改写后的折叠防重。

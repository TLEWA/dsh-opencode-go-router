# 更新日志

本项目的所有重要变更都记录在这里，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

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

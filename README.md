# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**简体中文** · [English](./README.en.md)

一个 DeepSeek Harness（DSH）宿主插件：当一条 OpenCode Go 的 DeepSeek 系列会话请求**即将**打不中上游前缀缓存、并且最近的请求很慢时，为这条请求换一个新的路由 id。预测发生在请求发出之前，所以切换正好作用于这条请求本身，不会额外增加一次缓存 miss。

它还维护一个两级热路由 id 池：前缀相似的新会话可以接手已有缓存的 id，从而省掉冷启动。

这是 DSH 插件（内部 id 为 `opencode-router`）的 npm 包。它只修改 OpenCode Go 的路由请求头，不是模型适配器。

## 为什么需要它

OpenCode Go 用 `x-opencode-session` 请求头把一条会话钉在某个上游后端上，由该后端为重复的提示词前缀提供缓存。前缀变化时缓存就会失效：billion-context 的上下文折叠会改写上下文，系统提示词变化会改写提示词本身。折叠重建之后，重建请求本身是冷的，但紧随其后的请求马上又变热，因为重建刚刚把新前缀写进了那个后端的缓存。

因此唯一有意义的切换时机，是在一条**本来就会冷**的请求发出之前。本插件在每条合格的请求发出前，用当时已知的信号预测它的缓存命中率——前缀是否变化、空闲了多久、上一次实测命中、上一次请求是否刚刚完整 prefill 了大前缀——当预测值 `<=` `cacheHitThresholdPct`（默认 25%）**且**最近的请求很慢时，就换路由 id。由于预测发生在 `llm/stream` 钩子里、请求头组装之前，新的路由 id 就作用于这条被判冷的请求：新后端为它建立缓存，不会再额外多出一条冷请求。

只有 OpenCode Go 的 DeepSeek 系列会话符合条件。即使状态文件里存在路由，其他模型也不会被本插件路由。

系统提示词改写和消息历史被压缩，是前缀一定变化的两种情况，所以携带这两种变化的请求总是被判为冷。但“判冷”本身不足以触发切换：最近的请求必须同时很慢。

如果连续切换后仍落到打不中基础目标的会话上，插件会放宽下一次的触发条件，而不是重复等价切换：每个“切换后窗口仍然慢于 `ttftThresholdMs` 或 `throughputThresholdTps`”的完整窗口都会让步进加一，使下一次判定多出 `stepTtftGraceMs`（默认 2 秒）的 TTFT 余量、少要求 `stepThroughputGraceTps`（默认 5 tok/s）的吞吐。切换后窗口达到基础目标，步进归零。失败永远按基础目标判定，不会按已经放宽后的目标判定。

插件本身不压缩任何内容，也不改动提示词或会话日志。它只改一个路由请求头，并在本地保存计时计数。

## 工作方式

- **实测缓存证据。** 它包装合格请求的 `llm/stream`，读取最后一个 `usage` 块。一次请求的缓存命中率是 `cacheReadTokens / (inputTokens + cacheReadTokens)`；新输入加缓存读取量就是上游实际计费的提示词长度。样本保存 TTFT、输出吞吐（token/秒）、提示词 token 数、缓存读取量和命中率；每个 DSH 会话使用最近 `sampleSize` 个有效样本。
- **折叠账本（仅作诊断，可选）。** 它同时读取 billion-context 的会话状态文件（`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`），跟踪 `metadata.cacheLedger.folds`。billion-context 的 `conversationId` 取自优先级最高的会话请求头，在 DSH 里是 `x-bili-plugin-conversation`（DSH 会话 id）；`x-opencode-session` 的优先级更低，所以轮换它不会改变文件名。最新的折叠只作为“刚才那次大冷请求是重建”的证据，不再直接触发轮换。插件不修改自身之外的任何文件：0.5.0 移除了 0.4.0 那个需要给 billion-context 打补丁的折叠前衔接。
- **适用范围。** 只处理来自已配置 provider（默认 `opencode-go`）且模型 id 以 `deepseek` 开头（大小写不敏感）的请求。`models` 可以收窄到具体的 DeepSeek id。其他模型被忽略；如果最近一次普通会话请求用的是不合格的模型，则跳过轮换。声明了 `purpose` 的辅助请求不会改变这一状态。
- **预测。** 在合格请求发出前，插件按以下顺序预测它的缓存命中：系统提示词变化或消息历史变短 → 0%；还没有任何实测请求 → 未知，绝不轮换；空闲达到 `cacheTtlMs`（默认 1 小时）→ 0%；上次命中 `>=` 80% → 沿用；上次请求完整 prefill 了大前缀（`>=` `prefillMinTokens` 且命中低）→ 按热处理（实测 95–99%），因为那次 prefill 已经把前缀写进缓存（即折叠重建的情形）；这是概率判断，不是保证——若那条请求实际仍冷，下一条会按 cache-miss-persists 判冷并轮换；其余情况沿用上次实测命中，命中 `<=` `cacheHitThresholdPct` 即判冷。
- **判定。** 只有在预测为冷、最近样本很慢（平均 TTFT `>=` 默认 12000 ms，或平均吞吐 `<=` 默认 60 token/秒，会按失败步进放宽）、最近一次普通请求合格、且 `minRotationGapMs` 已过时才轮换。记录里保留预测依据（`system-rewrite`、`history-compacted`、`idle-expired`、`cache-miss-persists` 等）和预期命中率。
- **路由。** 一个持久化的路由把 DSH 会话 id 映射到生成的 `ses_...` 值。`llm-pi-ai/request-headers` 瀑布流在 pi-ai 组装好请求头之后、请求发出之前执行，因此在那里设置 `x-opencode-session` 会真正上线，预测写入的路由也作用于同一条请求。在参考配置里，`dsh-opencode-ip-guard` 之类的配套注入器会提供等于 DSH 会话 id 的基线值；路由存在时本插件替换它，注入器的“不覆盖”回退则会保留新值。
- **没有 billion-context 也能工作。** 如果会话目录或会话状态文件不存在，折叠诊断保持空闲，设置页会明确说明。其余功能——实测缓存命中、TTFT/吞吐统计、池替换记录和轮换历史——都来自插件自身的请求采样，所以预测照常工作，不会把异常抛进 DSH，页面上的统计也不会消失。

会话的第一个请求没有实测样本，因此不会因预测而轮换；插件启动后看到的第一个折叠只作为诊断基线。轮换只改变上游路由 id，billion-context 仍为同一个 DSH 会话写同一个状态文件，所以监视器可以一直跟踪下去。

## 热路由 id 池

一个路由 id 绑定一个上游后端及其缓存。会话结束之后，这个 id 对前缀重叠的新会话仍然有价值。池就是为这种交接准备的。

**入池。** 会话连续 `poolIdleMs`（默认 3 分钟）没有产生有意义的事件，且没有进行中的回合、工具调用、确认或后台任务，宿主也报告 agent 空闲时，它的 code 进入池。改标题、写请求头、LLM 重试这类被动事件不会重置计时。会话被归档时立即入池。入池后不活跃超过 `poolExpireMs` 的 code 会被剔出池，之后不会再交给新会话；只要它仍然空闲，所属会话复苏时仍可收回。

**前缀摘要。** 每条合格请求发出前，插件为系统提示词、工具定义、消息文本、工具参数和工具结果生成摘要；只保存分块的 SHA-256，不保存原文。命中率等于共同的前缀块数除以新会话的块数。一级池的老 code 至少要覆盖新前缀的 `poolMatchPct`（默认 60%）；二级池没有命中率下限。

**两级池。** 一级池是不活跃时间小于 `poolTier1Ms`（默认 1 小时）的 code；二级池是 1–24 小时的 code。候选还必须满足：绑定该 code 的实测样本不少于 `poolSampleSize` 条、平均 TTFT 不超过 `poolMaxTtftMs`（8 秒）、平均吞吐高于 `poolMinTps`（80 tok/s）。一级候选按前缀命中率取最大（并列时取吞吐更高、TTFT 更低、最近更活跃者）。只有一级没有任何合格候选时才下落到二级，而且要求换入确实能提速：借出 code 的平均吞吐必须达到会话基线（会话自身已绑定样本不少于 `poolSpeedMinSamples` 时用它，否则取最近 200 条请求吞吐的中位数）的 `poolSpeedGainRatio` 倍（默认 1.1），两边的样本都不少于 `poolSpeedMinSamples`（5）；测不出基线时门槛放行。二级没有前缀命中率下限：只要通过样本与速度门槛，即使命中率更低也会优先于新生成 code。

**交换。** 新会话先新生成一个 code。若有合格候选，两者交换：新会话拿到老 code，连同它的摘要和绑定样本；老会话拿到新生成的 code，摘要与样本清空，并进入休眠，下次请求后空闲再重新入池。没有合格候选时，新会话保留自己的新 code。复苏不是借入：老会话只要自己的 code 还空闲，就一定拿回自己的 code，不参与 match、样本、层级或速度判定；如果 code 已经交给别的会话，就保留交换时得到的新 code，绝不改借其他 code。

只有已经生成前缀摘要、绑定样本不少于 `poolSampleSize`、平均 TTFT 与吞吐落在借出目标内（不超过 8 秒、高于 80 tok/s）、未过期且不在休眠的会话 code 才会入池；样本不足或实测偏慢的 code 会保持活跃，让所属会话继续使用。

**效果。** 池页面会把借入 code 后的首条请求与全新（`pool-initial`）会话的首条请求做对比。对比使用持久化的首请求标记；借入事件还会使用池事件里保存的首请求快照，所以即使首请求已经离开 200 条请求记录，仍按快照计入。早于快照机制、且首请求也已离开记录的借入事件，或首请求已离开记录的全新会话，会被跳过，而不会拿后面某条热请求顶替。页面显示借入/全新的样本数、首请求平均命中率、平均匹配率，以及以百分点表示的 `deltaPct`。0.6 之前创建、还没有摘要的旧路由会保持活跃，直到会话发出下一条请求。`poolMaxEntries` 限制池大小，超出时淘汰最久不活跃的 code；被淘汰的 code 在会话重新活跃前不会再次入池。

池开启时，会话的第一条合格请求就会创建持久化路由，即使当次不需要轮换。这个路由就是之后入池、交给别人的对象。把 `poolEnabled` 设为 `false` 可保留 0.6 之前的行为：只有发生轮换才创建路由，未轮换会话沿用宿主或配套注入器提供的请求头。

## 环境要求

- DSH 带 `llm-pi-ai` 适配器，并配置了 OpenCode Go provider（默认 `opencode-go`），其中至少有一个 DeepSeek 系列模型（模型 id 以 `deepseek` 开头）。
- billion-context 是可选的：安装并持续保存会话状态时，它的折叠账本会喂给折叠诊断；没有它，插件仍会测量每条请求、保留统计，并记录池替换与缓存命中。
- DSH 0.2.1-rc.5 或更新，且低于 0.3.0。
- Node.js 20 或更新。

## 从 npm 安装

```bash
dsh plugin add dsh-opencode-go-router --profile <profile>
```

也可以在 DSH 插件管理器的“添加插件”输入框里填 `dsh-opencode-go-router`。包内声明了 `dsh.bundle.patch`，正常安装会自己创建 `opencode-router` 行；不要为它再加一条独立的 profile 行。

## 从本地仓库安装（开发）

1. 把本仓库放在稳定位置，例如 `C:/Users/me/DSHs/opencode-router`。
2. 在 profile 的 `package.json` 里：
   - 把 `dsh-opencode-go-router` 加入 `dsh.profile.bundles`；
   - 把 `"dsh-opencode-go-router": "link:C:/Users/me/DSHs/opencode-router"` 加入 `dependencies`。
3. 让 profile 的 `node_modules/dsh-opencode-go-router` 指向本仓库（Windows 上目录联接/符号链接即可）。
4. **不要**在 profile 的 `cordis.patch.yml` 里为这个插件加独立行。包内声明了 `dsh.bundle.patch: ./cordis.patch.yml`，会自己插入插件行。没有 `insert` 的 profile 行只是覆盖，无法创建行。
5. 重启 DSH。插件管理器里应出现 `dsh-opencode-go-router` 这个 profile bundle，带一行 `include:opencode-router`。如果声明 bundle 之前宿主已经在运行，需要通过插件管理器重新加载它，或重启 DSH。
6. 访问 `http://127.0.0.1:<DSH Web 端口>/opencode-router/status` 查看实时状态。

要改默认值，在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: opencode-router
  config:
    cacheHitThresholdPct: 25
```

插件的入口每次 `apply` 都会带缓存破坏参数重新加载 `lib/impl.js`，所以改实现后通常只要触碰一次插件配置就能试新代码。在运行中的宿主里，通过插件管理器把 profile bundle 关掉再打开，也会重新加载静态导入（`lib/core.js`、`lib/store.js`、`lib/monitor.js`）；0.1.2 -> 0.1.3 的阈值改动就是这样验证的。如果宿主一直报告旧版本号，就重启 DSH。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭时钩子直接放行，监视器不运行。 |
| `providers` | `["opencode-go"]` | 有资格被路由的 provider；模型仍必须是 `deepseek*` id。 |
| `models` | `[]` | 可选的精确 DeepSeek 模型白名单；为空表示该 provider 下任意 `deepseek*` 模型。 |
| `cacheHitThresholdPct` | `25` | 只有下一条请求的预测缓存命中率低于或等于此值才轮换。 |
| `predictiveRotation` | `true` | 预测下一条请求的缓存命中并在其发出前轮换。设为 false 则完全不做切换。 |
| `cacheTtlMs` | `3600000` | 空闲达到该值即预测为冷。实测显示 15–60 分钟仍会命中，所以默认取 1 小时；`0` 关闭空闲规则。 |
| `prefillMinTokens` | `4000` | 一次冷请求如果计费提示词不少于该值，就视为完整 prefill，下一条请求预测为热（属于假设；该请求实测若仍冷，会在再下一条纠正）。 |
| `ttftThresholdMs` | `12000` | 平均首内容 token 时间达到该值即视为慢（基础目标）。 |
| `throughputThresholdTps` | `60` | 平均输出吞吐低于或等于该值即视为慢（基础目标）。 |
| `stepTtftGraceMs` | `2000` | 每连续失败一次，下一次 TTFT 目标放宽这么多。 |
| `stepThroughputGraceTps` | `5` | 每连续失败一次，下一次吞吐目标降低这么多（下限 `0.01`）。 |
| `sampleSize` | `5` | 参与性能判定的最近请求数。 |
| `requireFullSamples` | `true` | 轮换前要求攒满 `sampleSize` 个样本。 |
| `routingIdPrefix` | `"ses_"` | 生成路由 id 的前缀。 |
| `statePath` | `$DSH_HOME/storages/opencode-router/state.json` | 持久化的路由与计时样本。 |
| `dryRun` | `false` | 只记录轮换，不真正选择新的请求头值。 |
| `debug` | `false` | 额外的 info 日志。 |
| `overrideExistingHeader` | `true` | 替换已存在的 `x-opencode-session`。设为 false 则保留原值。 |
| `pollIntervalMs` | `2000` | 会话活跃时的轮询间隔。 |
| `requestCheckDelaysMs` | `[400, 1500]` | 请求结束后额外的状态文件检查时间点。 |
| `biliSessionsDir` | `null` | 覆盖 billion-context 的会话根目录。 |
| `biliProtocol` | `"openai"` | 状态子目录。 |
| `biliUpstreamHost` | `"opencode.ai"` | 状态文件名里的 host 标签。 |
| `maxSamples` | `20` | 每个会话保留的最大样本数。 |
| `sessionActiveMs` | `600000` | 会话空闲超过该时长后停止轮询。 |
| `minRotationGapMs` | `0` | 同一会话两次轮换之间的最小间隔。 |
| `poolEnabled` | `true` | 启用热路由 id 池。 |
| `poolIdleMs` | `180000` | 无待办工作时，空闲多久后 code 入池。 |
| `poolMatchPct` | `60` | 一级池老 code 必须覆盖的前缀摘要命中率下限（二级池无下限）。 |
| `poolSpeedGainRatio` | `1.1` | 二级池借出 code 相对会话基线所需的最低吞吐倍数。 |
| `poolSpeedMinSamples` | `5` | 借出方与基线各自需要的绑定样本数，之后速度门槛才做判断。 |
| `poolMinTps` | `80` | 老 code 样本的平均吞吐下限（须严格高于）。 |
| `poolMaxTtftMs` | `8000` | 老 code 样本的平均 TTFT 上限（8 秒含边界）。 |
| `poolSampleSize` | `5` | code 成为候选前要求的绑定样本数。 |
| `poolTier1Ms` | `3600000` | 不活跃时间小于该值的 code 属于一级池。 |
| `poolExpireMs` | `86400000` | 不活跃超过该值就从池中剔除，之后不再交出。 |
| `poolMaxEntries` | `50` | 池中 code 上限；超出时先淘汰最久不活跃者。 |
| `poolDigestChunkChars` | `512` | 每个前缀摘要块的字符数。 |
| `poolDigestMaxChars` | `262144` | 参与摘要的前缀最大字符数。 |

## 状态路由

`GET /opencode-router/status` 返回 JSON，包含生效配置、持久化路由、池内容、轮换历史和每个会话的监视状态：

- `history` —— 最近的路由记录，最新的在前，含 `sessionId`、`at`、`reason`（`predicted-cold`、`pool-adopted` 或 `pool-donated`）、`basis`、`foldSeq`、`cacheHitPct`（预期命中率）、`step`、路由 `value`、切换前后 TTFT 与吞吐、样本进度，以及 `backfilled` 标记。新记录还带 `version` 与 `thresholds`（基础/生效 TTFT 与吞吐目标、失败步进）；池记录为 `thresholds: null`，并带 `poolMatchPct`、`poolTier`、`poolScore`、`poolSourceSessionId`、`poolRole` 和首请求标记 `firstRequestAt`；
- `routes` —— 持久化路由；前缀摘要脱敏为 `digestChunks`（块数），绑定样本概括为 `poolSamples`；
- `pool` —— `enabled`、`speedGainRatio`、`speedMinSamples`、各项上限、`total`、`tier1`、`tier2`、`eligible`、`lastAdoption`、`lastRevival`、`effect`（`adopted`/`baseline` 首请求命中汇总、`deltaPct` 与最近 `samples`），以及每个条目的 `sessionId`、`code`、`tier`、`eligible`、`samples`、`avgTtftMs`、`avgTps`、`score`、`digestChunks`、`digestChars`、`ageMs`、`pooledAt` 与 `lastActiveAt`；
- `activity` —— 每个会话的进行中回合、工具调用、确认、后台任务和最近活动时间；它们决定能否入池；
- `eligibility` —— 已配置的 provider 和固定的 `deepseek` 模型前缀；
- `baselineReady` 与 `lastFoldSeq` —— 折叠诊断的游标；
- `latestFold` —— 最新的折叠记录（含 `hPct`）；
- `watchingId` —— 正在跟踪的 billion-context 状态文件对应的 DSH 会话 id；
- `route` —— 当前轮换后的路由 id，或 `null`；其 `reason` 为 `predicted-cold`、`pool-adopted` 或 `pool-donated`，`basis` 为预测或池的依据，`step` 为当次切换使用的失败步进；
- `targetActive` —— 最近一次普通会话请求是否为合格的 OpenCode Go DeepSeek 请求；`false` 会阻止轮换；
- `lastPrediction` —— 最近一次请求前预测：依据、预期与上次命中率、是否判冷、空闲时长、样本数、性能摘要、步进、`rotated`，以及 `skipReason`（`predictive-rotation-off`、`cache-expected-warm`、`not-target`、`cooldown`、`performance-ok`、`pool-adopted`、`pool-revived`）；
- `predictions`、`predictiveRotation`、`cacheHitThresholdPct`、`cacheTtlMs` —— 已做预测次数与预测设置；
- `systemPromptFp`、`messageCount`、`lastSample` —— 预测用于比较的最新前缀输入；
- `stepping` —— `step`、`consecutiveFailures`、基础与生效的 TTFT/吞吐阈值，以及每步放宽量；
- `samples` —— 样本数、平均 TTFT、平均吞吐；
- `billionContext` —— `{ detected, root }`：billion-context 的会话目录是否存在（最多每 30 秒探测一次），以及探测的根目录；
- `statistics` —— 设置页标题栏用的请求汇总：`window.requests`、`window.poolEvents`、`requests.total/measured/avgHitPct/warm/cold/avgTtftMs/avgTps`，以及 `pool.swaps/revivals/lastSwapAt`；
- `requests` —— 最近 100 条实测请求，最新的在前：`sessionId`、`at`、命中率、TTFT、吞吐、输入与缓存读取 token 数；
- `poolEvents` —— 最近 100 条池替换与复苏记录，最新的在前：`role`（`adopted`/`revived`）、会话 id、code 与借出 code、命中率、层级、分数、借出方的 TTFT/吞吐/样本数，以及借入事件的 `firstRequest` 首请求快照（时间、命中率、TTFT、吞吐、输入与缓存读取 token）；
- `rotations`、`lastRequestAt`、`lastTickAt`、`lastError`；
- `routing` —— 请求头钩子的计数与最近一次判定：`checks`、`applications`、`lastCheckedAt`、`lastCheckedSessionId`、`lastAppliedAt`、`lastAppliedSessionId`、`lastAppliedValue`、`lastReason`。`lastReason` 取值 `applied`、`no-route`、`existing-header`、`no-headers`、`disabled`、`not-target`。

当宿主的 Web 服务器绑定在 localhost 时，该路由只在 localhost 可访问。请把这份 JSON 当作诊断信息。

## 设置页

在 DSH Web 客户端打开插件管理器，选择本 bundle。详情页会在 bundle 配置行上方显示 **静默切换性能记录**。

每条路由记录会显示时间、短会话 id、触发原因（`预测冷请求`、`系统提示词改写`、`池复用` 或 `池借出`）、预测依据与折叠编号、预期缓存命中率、失败步进（大于 0 时）、切换前的平均 TTFT 与吞吐、切换后前 `sampleSize` 个合格样本，以及百分比变化。池复用行没有自己的基线：其「切换前」一栏是借入 code 在来源会话的历史，因此百分比只表示同一 code 迁移后的漂移，不是复用收益；这类行不计入标题栏的平均变化，复用收益看上方「池效果」。每条记录还会标出写入时生效的阈值；没有记录阈值的旧版本行会标记为旧版记录，而不会拿今天的默认值去评判。标题栏显示池大小、两级数量、合格数、最近活跃会话的步进与生效阈值，面板里解释了每一步的放宽量。下方是「两级池 session code」列表，按一级/二级分组显示每个 code 的会话、code 原文、是否合格、TTFT、吞吐、样本进度、评分、空闲时长、摘要大小与入池时间；不合格条目会说明原因。记录每五秒从 `GET /opencode-router/status` 刷新一次。切换后窗口攒满 `sampleSize` 个样本后即冻结，之后的流量不会改写历史。

页面还会显示一行最近请求汇总（平均命中率、热/冷次数、平均 TTFT 与吞吐），并在记录下方显示两个日志：**池替换记录**（哪个 code 被复用/收回、来自哪个会话、命中率、层级、借出方速度）和**缓存命中记录**（只显示每次从池中复用 code 后的第一条请求；同一会话收回自己的 code 不算池替换，不显示；首请求快照随池事件持久化，200 条请求记录淘汰后仍可查看；每条显示命中率、TTFT、吞吐、提示词与缓存读取 token 数）。未检测到 billion-context 时，页面会提示折叠诊断不可用、统计来自插件自身采样，并隐藏折叠标记。

0.2.0 之前创建的路由会被回填为每个仍已知路由一行，并标记为 `Reconstructed`；它们的切换后数值来自该次轮换之后保留的样本。面板只存在于 Web 客户端，不影响宿主路由。

## 隐私与安全

- 保存的数据仅限 DSH 会话 id、生成的路由 id、折叠编号、缓存百分比、TTFT、吞吐、路由历史、逐请求缓存命中与池事件日志、时间戳，以及用于池匹配的分块 SHA-256 前缀哈希。不保存提示词、消息、工具输出或 API 密钥；摘要无法还原成原文。
- 每个宿主回调都自行捕获异常。未安装 billion-context 只会关闭折叠诊断；状态文件格式异常只会产生一条日志。
- 修改请求头只是路由提示，并不保证网关一定选中不同的物理后端。如果网关忽略未知或新的会话值，插件无法强制迁移。
- billion-context 的状态文件是内部格式。如果其布局变化，折叠诊断可能看不到折叠并保持空闲，插件不会破坏任何数据。

## 开发

```bash
node --test
```

测试覆盖折叠解析、缓存命中测量、预测规则与依据、性能判定与连续失败步进、仅 DeepSeek 的适用范围、状态持久化、轮换历史、请求与池事件日志、统计汇总、收紧后的入池门槛、监视器、请求头路由、流式测量、客户端 bundle 注册与两级池 code 列表、前缀摘要、两级池、池交换与复苏、首请求标记、首请求快照与池效果归因、空闲/归档入池，以及活动跟踪。

## 我的其他 DSH 项目

上下文路由只是 DSH 的一小块。下面这些插件也都由我维护，按需取用。

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** —— 侧栏行右键菜单：工作区行、会话行与会话正文各有自己的右键菜单，含「打开方式」「更多操作」二级菜单。
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** —— 七区域布局整理器：侧栏、侧栏底部、对话标签、输入框、会话头部、右侧栏、设置导航都能长按拖拽排序，面板可以收进「更多」再拖回来。
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** —— `ask_user_question` 增强：右键选项补备注，选之前先拿同一份上下文旁问模型一句。
- **[dsh-if](https://github.com/TLEWA/dsh-if)** —— `/if` 命令：让模型结合上文判断条件，成立才把下面的指令作为用户消息发出。
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** —— 修复 Windows 下 DSH 子进程 GBK/CP936/CP932 输出乱码。
- **[dsh-fastload](https://github.com/TLEWA/dsh-fastload)** —— 长会话首屏历史瘦身：缩小首次打开时的历史页，同时保留用户实际看到的尾部内容。
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** —— 修复 PTC `run_code` 中无参工具调用被拒绝的问题：把省略或 `undefined` 的首参归一化为 `{}`。

## 许可证

MIT

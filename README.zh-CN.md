# dsh-opencode-go-router

[![CI](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml/badge.svg)](https://github.com/TLEWA/dsh-opencode-go-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-opencode-go-router.svg)](https://www.npmjs.com/package/dsh-opencode-go-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](./README.md) · [简体中文](./README.zh-CN.md)

一个 DeepSeek Harness（DSH）宿主插件：当一条 OpenCode Go 的 DeepSeek 系列会话请求**即将**打不中上游前缀缓存、并且最近的请求很慢时，为这条请求换一个新的路由 id。预测发生在请求发出之前，所以切换正好作用于这条请求本身，不会额外增加一次缓存 miss。

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
- **折叠账本（仅作诊断）。** 它同时读取 billion-context 的会话状态文件（`sessions/openai/<host>_<sha256(conversationId).slice(0,24)>.json`），跟踪 `metadata.cacheLedger.folds`。billion-context 的 `conversationId` 取自优先级最高的会话请求头，在 DSH 里是 `x-bili-plugin-conversation`（DSH 会话 id）；`x-opencode-session` 的优先级更低，所以轮换它不会改变文件名。最新的折叠只作为“刚才那次大冷请求是重建”的证据，不再直接触发轮换。插件不修改自身之外的任何文件：0.5.0 移除了 0.4.0 那个需要给 billion-context 打补丁的折叠前衔接。
- **适用范围。** 只处理来自已配置 provider（默认 `opencode-go`）且模型 id 以 `deepseek` 开头（大小写不敏感）的请求。`models` 可以收窄到具体的 DeepSeek id。其他模型被忽略；如果最近一次普通会话请求用的是不合格的模型，则跳过轮换。声明了 `purpose` 的辅助请求不会改变这一状态。
- **预测。** 在合格请求发出前，插件按以下顺序预测它的缓存命中：系统提示词变化或消息历史变短 → 0%；还没有任何实测请求 → 未知，绝不轮换；空闲达到 `cacheTtlMs`（默认 1 小时）→ 0%；上次命中 `>=` 80% → 沿用；上次请求完整 prefill 了大前缀（`>=` `prefillMinTokens` 且命中低）→ 按热处理（实测 95–99%），因为那次 prefill 已经把前缀写进缓存（即折叠重建的情形）；这是概率判断，不是保证——若那条请求实际仍冷，下一条会按 cache-miss-persists 判冷并轮换；其余情况沿用上次实测命中，命中 `<=` `cacheHitThresholdPct` 即判冷。
- **判定。** 只有在预测为冷、最近样本很慢（平均 TTFT `>=` 默认 12000 ms，或平均吞吐 `<=` 默认 60 token/秒，会按失败步进放宽）、最近一次普通请求合格、且 `minRotationGapMs` 已过时才轮换。记录里保留预测依据（`system-rewrite`、`history-compacted`、`idle-expired`、`cache-miss-persists` 等）和预期命中率。
- **路由。** 一个持久化的路由把 DSH 会话 id 映射到生成的 `ses_...` 值。`llm-pi-ai/request-headers` 瀑布流在 pi-ai 组装好请求头之后、请求发出之前执行，因此在那里设置 `x-opencode-session` 会真正上线，预测写入的路由也作用于同一条请求。在参考配置里，`dsh-opencode-ip-guard` 之类的配套注入器会提供等于 DSH 会话 id 的基线值；路由存在时本插件替换它，注入器的“不覆盖”回退则会保留新值。
- **没有 billion-context 也不产生影响。** 如果会话目录或会话状态文件不存在，折叠诊断保持空闲。预测只依赖实测样本，没有样本就不会轮换，也不会把异常抛进 DSH。

会话的第一个请求没有实测样本，因此不会因预测而轮换；插件启动后看到的第一个折叠只作为诊断基线。轮换只改变上游路由 id，billion-context 仍为同一个 DSH 会话写同一个状态文件，所以监视器可以一直跟踪下去。

## 环境要求

- DSH 带 `llm-pi-ai` 适配器，并配置了 OpenCode Go provider（默认 `opencode-go`），其中至少有一个 DeepSeek 系列模型（模型 id 以 `deepseek` 开头）。
- 已安装 billion-context 并会持续保存会话状态（用于折叠诊断；预测本身只依赖实测样本）。
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

## 状态路由

`GET /opencode-router/status` 返回 JSON，包含生效配置、持久化路由、轮换历史和每个会话的监视状态：

- `history` —— 最近的静默切换，最新的在前，含 `sessionId`、`at`、`reason`（`predicted-cold`）、`basis`、`foldSeq`、`cacheHitPct`（预期命中率）、`step`、路由 `value`、切换前后 TTFT 与吞吐、样本进度，以及 `backfilled` 标记；
- `eligibility` —— 已配置的 provider 和固定的 `deepseek` 模型前缀；
- `baselineReady` 与 `lastFoldSeq` —— 折叠诊断的游标；
- `latestFold` —— 最新的折叠记录（含 `hPct`）；
- `watchingId` —— 正在跟踪的 billion-context 状态文件对应的 DSH 会话 id；
- `route` —— 当前轮换后的路由 id，或 `null`；其 `reason` 为 `predicted-cold`，`basis` 为预测依据，`step` 为当次切换使用的失败步进；
- `targetActive` —— 最近一次普通会话请求是否为合格的 OpenCode Go DeepSeek 请求；`false` 会阻止轮换；
- `lastPrediction` —— 最近一次请求前预测：依据、预期与上次命中率、是否判冷、空闲时长、样本数、性能摘要、步进、`rotated`，以及 `skipReason`（`predictive-rotation-off`、`cache-expected-warm`、`not-target`、`cooldown`、`performance-ok`）；
- `predictions`、`predictiveRotation`、`cacheHitThresholdPct`、`cacheTtlMs` —— 已做预测次数与预测设置；
- `systemPromptFp`、`messageCount`、`lastSample` —— 预测用于比较的最新前缀输入；
- `stepping` —— `step`、`consecutiveFailures`、基础与生效的 TTFT/吞吐阈值，以及每步放宽量；
- `samples` —— 样本数、平均 TTFT、平均吞吐；
- `rotations`、`lastRequestAt`、`lastTickAt`、`lastError`；
- `routing` —— 请求头钩子的计数与最近一次判定：`checks`、`applications`、`lastCheckedAt`、`lastCheckedSessionId`、`lastAppliedAt`、`lastAppliedSessionId`、`lastAppliedValue`、`lastReason`。`lastReason` 取值 `applied`、`no-route`、`existing-header`、`no-headers`、`disabled`、`not-target`。

当宿主的 Web 服务器绑定在 localhost 时，该路由只在 localhost 可访问。请把这份 JSON 当作诊断信息。

## 设置页

在 DSH Web 客户端打开插件管理器，选择本 bundle。详情页会在 bundle 配置行上方显示 **静默切换性能记录**。

每条静默切换会显示时间、短会话 id、触发原因（`预测冷请求` 或 `系统提示词改写`）、预测依据与折叠编号、预期缓存命中率、失败步进（大于 0 时）、切换前的平均 TTFT 与吞吐、切换后前 `sampleSize` 个合格样本，以及百分比变化。标题栏还会显示最近活跃会话的步进与生效阈值，面板里解释了每一步的放宽量。记录每五秒从 `GET /opencode-router/status` 刷新一次。切换后窗口攒满 `sampleSize` 个样本后即冻结，之后的流量不会改写历史。

0.2.0 之前创建的路由会被回填为每个仍已知路由一行，并标记为 `Reconstructed`；它们的切换后数值来自该次轮换之后保留的样本。面板只存在于 Web 客户端，不影响宿主路由。

## 隐私与安全

- 保存的数据仅限 DSH 会话 id、生成的路由 id、折叠编号、缓存百分比、TTFT、吞吐、轮换历史和时间戳。不保存提示词、消息、工具输出或 API 密钥。
- 每个宿主回调都自行捕获异常。billion-context 状态文件缺失或格式异常只会产生一条日志。
- 修改请求头只是路由提示，并不保证网关一定选中不同的物理后端。如果网关忽略未知或新的会话值，插件无法强制迁移。
- billion-context 的状态文件是内部格式。如果其布局变化，折叠诊断可能看不到折叠并保持空闲，插件不会破坏任何数据。

## 开发

```bash
node --test
```

测试覆盖折叠解析、缓存命中测量、预测规则与依据、性能判定与连续失败步进、仅 DeepSeek 的适用范围、状态持久化、轮换历史、监视器、请求头路由、流式测量，以及客户端 bundle 注册。

## 我的其他 DSH 项目

上下文路由只是 DSH 的一小块。下面这些插件也都由我维护，按需取用。

- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** —— 侧栏行右键菜单：工作区行、会话行与会话正文各有自己的右键菜单，含「打开方式」「更多操作」二级菜单。
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** —— 七区域布局整理器：侧栏、侧栏底部、对话标签、输入框、会话头部、右侧栏、设置导航都能长按拖拽排序，面板可以收进「更多」再拖回来。
- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** —— `ask_user_question` 增强：右键选项补备注，选之前先拿同一份上下文旁问模型一句。
- **[dsh-if](https://github.com/TLEWA/dsh-if)** —— `/if` 命令：让模型结合上文判断条件，成立才把下面的指令作为用户消息发出。
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** —— 修复 Windows 下 DSH 子进程 GBK/CP936/CP932 输出乱码。

## 许可证

MIT

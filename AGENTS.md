# AGENTS.md

本仓库是一个 DSH 插件。开工前先读仓库的 `README.md`；通用流程与检查项看中心仓的 [PROCESS.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/PROCESS.md) 与 [docs/gates.md](https://github.com/TLEWA/dsh-plugin-ci/blob/v1/docs/gates.md)。本文件只强调本类仓库最容易出错的点。

## 插件的硬性约束

- `package.json` 必须有顶层 `engines.dsh`；写在 `dsh.engines.dsh` 会被忽略。
- `dsh.manifestVersion` 必须是 1，`dsh.bundle.patch` 必须指向真实存在的 `cordis.patch.yml`。
- `cordis.patch.yml` 里 `insert[].name` 必须等于包名；`id` 是用户可见的短名，不要随意改。
- `dsh.client.inject` 只允许 `@deepseek-ai/*`，裸模块名（如 `react`）不会被打包。
- `lib/` 是直接运行的源码（本仓库没有构建步骤）；不要新增 build 步骤，也不要把 `lib/index.js` 改成生成物。
- `package.json` 的 `scripts.prepublishOnly` 必须调用 `dsh-ci-gate --prepublish`；它拦截本机 `npm publish`，不要删除或绕过。

## 本仓库专属

`dsh-opencode-go-router` 由薄壳 `lib/index.js` 和实现 `lib/impl.js`（以及
`core/monitor/store/pool/activity/client`）组成，没有构建步骤，`lib/` 直接运行。

- 壳必须保持无状态、极薄：`inject=[]`；`apply` 里用带 `?v=` 的 cache-busting 动态 import
  加载 `impl.js`。不要改回静态 import，否则热重载会失效。
- 壳里的错误只 log，不能 throw；插件加载失败不能拖垮宿主启动。
- 只处理 OpenCode Go 的 DeepSeek 系列请求；`isTargetRequest` 的边界是产品契约，不得擅自扩大。
- 改 DEFAULTS 的缓存/路由/池阈值视为行为变更：说明理由、补测试，并在 CHANGELOG 写清影响。
- `/opencode-router/status` 的公开数据必须脱敏（digest/samples），不要泄露 prompt、请求体或密钥。
- 状态默认写 `$DSH_HOME/storages/opencode-router/state.json`；不要改成仓库内路径。
- `README.md` 是中文主文档，`README.en.md` 是英文；两者标题、命令与限制要同步。
- `npm test` 是 `node --test`；没有 build，不要给 `lib/` 增加生成的“源码”层。

## 每次改动

1. 从最新 main 开 `feat/` 或 `fix/` 分支。
2. 改代码、测试、双语文档与 CHANGELOG（同一个 PR）。
3. 本地跑 gate，全绿再 push；不要复制 gate 脚本，CI 会通过 `.ci` 运行中心仓的版本。
4. 开 PR 并按模板勾选；`ci / ci-ok` 通过后由维护者合并。改 CI、AGENTS 或 PR 模板必须加 `ci-change`；
   `human-approved` 只能由人加，模型不得自行添加。

```bash
npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate
npm test
```

## 发布

只由维护者打 tag 触发 `release.yml`。模型不得执行 `npm publish`、不得改版本号（除非在 `release/` 分支上且被明确要求）。

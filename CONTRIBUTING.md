# 贡献指南 / Contributing

> **[中文](#中文贡献指南)** | **[English](#english-contributing-guide)**

---

<a id="中文贡献指南"></a>

## 🇨🇳 中文贡献指南

我们将本项目维护为独立的 DeepSeek Harness 浏览器插件。贡献应同时保持工具契约、浏览器可靠性、证据边界和评测可复现性。

### 环境要求

- Node.js `>=22.19`
- npm
- Chrome 或 Chromium
- `pnpm`（执行 DSH 安装验证时需要）

### 代码库布局

```text
src/                       源码事实来源
├─ index.ts                Cordis 插件入口和资源清理
├─ plugin-tools.ts         DSH defineTool 注册与执行边界
├─ tool-schemas.ts         工具参数和 canonical output schema
├─ config.ts               配置 schema 与运行时校验
└─ browser/
   ├─ manager.ts           Chromium、标签页和 Session 生命周期
   ├─ operations/          16 个浏览器操作
   ├─ cdp/                 Chrome DevTools Protocol
   └─ dom/                 DOM 快照、渲染、差异和视觉映射
lib/                       构建产物，不要手工修改
test/                      node:test 测试
scripts/                   真实浏览器与安装验证
assets/benchmark/          固定的 WebVoyager 126 题与历史 109 题参考信息
docs/                      评测、可靠性和证据契约
cordis.patch.yml           DSH profile bundle patch
```

`src/` 是唯一源码事实来源。`lib/` 和根目录的 `.tgz` 都由构建命令生成。

### 本地开发

```powershell
npm install
npm run build
npm test
```

涉及真实浏览器行为时，再运行：

```powershell
npm run test:smoke
npm run test:host
npm run verify:installed
```

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run build` | 从 `src/index.ts` 生成 `lib/` |
| `npm test` | 构建并运行全部 `node:test` 测试 |
| `npm run test:smoke` | 启动真实 Chromium 并验证主链路 |
| `npm run verify:package` | 检查 bundle manifest、依赖和发布文件清单 |
| `npm run verify:installed` | 在临时消费者项目中安装并导入 tarball |
| `npm run check` | 运行测试与安装验证 |

### 评测变更

修改 `scripts/eval/`、评分口径、Trace、用量统计或数据集时，我们先运行 `npm run eval:test`，必要时再运行 `npm run eval:smoke`。真实全量评测使用新的 `output/evals/NAME` 目录，不覆盖旧 manifest，也不把 missing、unjudged、未知用量或 provider 故障当作零成本的普通失败。评测 PR 应列出精确命令、评分模式、并发、完整性状态和 Agent/Judge 成本口径。


## 🇬🇧 English contributing guide

We maintain this repository as a standalone DeepSeek Harness browser plugin. Contributions must preserve tool contracts, browser reliability, evidence boundaries, and evaluation reproducibility.

### Requirements

- Node.js `>=22.19`
- npm
- Chrome or Chromium
- `pnpm` for DSH installation verification

### Repository layout

```text
src/                       source of truth
├─ index.ts                Cordis entry and cleanup
├─ plugin-tools.ts         DSH defineTool registration and execution boundary
├─ tool-schemas.ts         parameter and canonical-output schemas
├─ config.ts               config schema and runtime validation
└─ browser/
   ├─ manager.ts           Chromium, tab, and Session lifecycle
   ├─ operations/          16 browser operations
   ├─ cdp/                 Chrome DevTools Protocol
   └─ dom/                 DOM snapshots, rendering, diffing, and visual mapping
lib/                       generated output; do not edit manually
test/                      node:test suite
scripts/                   real-browser and installation verification
assets/benchmark/          pinned WebVoyager 126-task dataset and historical 109-task provenance
docs/                      evaluation, reliability, and evidence contracts
cordis.patch.yml           DSH profile bundle patch
```

`src/` is the only source of truth. `lib/` and the root `.tgz` are generated artifacts.

### Local development

```powershell
npm install
npm run build
npm test
```

For changes that affect real browser behavior, also run:

```powershell
npm run test:smoke
npm run test:host
npm run verify:installed
```

Common commands:

| Command | Purpose |
|---|---|
| `npm run build` | Generate `lib/` from `src/index.ts` |
| `npm test` | Build and run the complete `node:test` suite |
| `npm run test:smoke` | Launch real Chromium and verify the main path |
| `npm run verify:package` | Check the bundle manifest, dependencies, and publish list |
| `npm run verify:installed` | Install and import the tarball in a temporary consumer |
| `npm run check` | Run tests and installation verification |

### Evaluation changes

When changing `scripts/eval/`, grading rules, Trace handling, usage metrics, or the dataset, we run `npm run eval:test` first and add `npm run eval:smoke` when browser integration is affected. A real full run uses a new `output/evals/NAME` directory and preserves the previous manifest. We never coerce missing, unjudged, unpriced, or provider-failure measurements to zero. Evaluation pull requests state the exact command, Judge mode, concurrency, completeness status, and Agent/Judge cost basis.

## 浏览可靠性回归 / Browser reliability regressions

修改交互、滚动或恢复时，我们运行 `npm run check`、`npx tsc --noEmit`、`npm run test:smoke` 和 `npm run test:host`。`scripts/smoke-reliability.mjs` 使用本地 HTTP 页面和真实 Chromium，覆盖动态插入、60 条虚拟列表、输入值核对、成功/失败后置条件、遮挡、精确版本的表单与滚动恢复，以及只读字段的部分恢复。我们为新能力同时覆正常和失败路径。

For interaction, scrolling, or restoration changes, we run the same commands above. We keep expected action failures, optional postcondition checks, and task completion separate; we verify partial restoration rather than treating a returned function as success. We use local fixtures and never commit real page data or checkpoint values.

![dsh-browser — Native browser agent for DeepSeek Harness](assets/dsh-browser-banner-v3.png)

<h1 align="center">dsh-browser-use</h1>

<p align="center">Native Chromium browser Agent tools for DeepSeek Harness</p>

在 WebVoyager 126 tasks / 3 站点上取得 92.9 % 的成功率，平均 15.3 steps / 任务，耗时149 s / 任务，成本约 $ 0.031 / 任务。成本为 Agent 标价等价估算，Judge 费用另计；评测方法和历史归档见[评测指南](docs/evaluation.md)。

浏览器命令失败的处理、点击检查和脚本异常说明见[可靠性文档](docs/reliability.md)；原文引用的获取方式见[证据文档](docs/evidence.md)。

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-blue" alt="Node.js >= 22.19">
  <img src="https://img.shields.io/badge/browser-Chrome%20%7C%20Chromium-blue" alt="Chrome or Chromium">
  <img src="https://img.shields.io/badge/tools-17-success" alt="17 browser and recall tools">
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a id="中文"></a>

# 🇨🇳 dsh-browser-use（中文）

> 给 DeepSeek Harness 装上真实浏览器：让 Agent 能够打开网页、理解页面、填写表单、管理标签页并完成多步骤任务。

我们将 `dsh-browser-plugin` 作为可独立安装的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web profile 插件。它直接启动本机 Chrome 或 Chromium，通过 Puppeteer、Chrome DevTools Protocol（CDP）和增量 DOM 快照向 Agent 提供 16 个浏览器操作与 1 个归档回读工具。

本仓库只包含浏览器插件自身的源码，不包含 DeepSeek Harness 源码，也不要求用户克隆 Harness 仓库。

本版本通过 DSH 的原生扩展点，把浏览器运行时与上下文策略接入 Agent Harness。这里的 Host 是 DSH 的 Agent/Session 运行时；插件仍可独立打包安装，不需要复制或修改 DSH 源码。

## 它能做什么

| 任务 | 没装插件 | 装上插件 |
|---|---|---|
| 访问动态网站 | 只能依赖搜索或静态抓取 | 启动真实 Chromium 并操作页面 |
| 填写复杂表单 | 无法处理弹窗、下拉框和动态字段 | 通过 DOM 引用定位、输入和点击 |
| 多步资料调研 | 每一步都要人工复制页面内容 | Agent 可在多个标签页之间持续探索 |
| 理解页面变化 | 反复读取整页，浪费上下文 | 优先返回 DOM 差异，必要时建立完整基线 |
| 查看图表和图片 | 只有文本信息 | 截取指定视觉元素并保存为 DSH attachment |

## 核心特性

- **真实 Chromium** — 使用本机 Chrome/Chromium，而不是 HTTP 抓取器或模拟页面。
- **增量 DOM** — 首次返回完整快照，后续优先返回 `+|` / `-|` 差异，减少重复上下文。
- **稳定元素引用** — 可点击元素使用 `[N]`，可输入元素使用 `<N>`，视觉元素使用 `[view:ID]`。
- **Session 隔离** — 每个 DSH Agent 独立拥有浏览器进程、标签页、CDP 会话和 DOM 缓存。
- **多标签页与滚动探索** — 支持创建、切换、关闭标签页，以及按屏或按页面位置探索长页面。
- **DSH 原生生命周期** — 使用 Cordis、`defineTool`、approval、取消信号和 attachment 服务，不依赖兼容服务器。
- **显式浏览器路由** — 用户明确要求使用浏览器或 Chromium 时，模型从 `browser_start` 开始并持续使用 `browser_*`，不会用 `web_search` 或 `web_fetch` 替代。
- **安全默认值** — Chromium sandbox 默认开启；改变页面状态的操作默认需要 DSH approval。
- **有界输出** — 页面脚本结果过大时只向模型返回预览，并把完整结果写入指定目录或临时目录。
- **同轮文本留存** — 每个 DOM 快照提醒 Agent 在改变页面前把重要答案、数值和导航线索写进同一次 assistant 输出，无需额外调用旧事实总结接口。
- **按需回读归档** — 页面观察按访问自动归档；需要核对旧页面时再调用 `browser_recall`，不强制逐页登记或补齐字段。
- **操作后置条件** — 点击和输入可检查文本或 URL；实际执行、验证通过和整体任务完成始终是三个独立结论。
- **精确检查点恢复** — 我们用完整 `stateId` 恢复支持的表单、展开状态与滚动位置，并将不完整恢复明确标为 `partial`。
- **结构化与跨域诊断** — `browser_execute_script` 支持 JSON-LD、重复列表和有界结果；OOPIF 路由、CDP 录制/回放与统计接口用于可复现的 DOM 诊断。

## 快速开始

### 环境要求

- Node.js `>=22.19`
- Chrome 或 Chromium
- `pnpm`（DSH 的插件安装命令会调用它）

```powershell
node --version
pnpm --version
```

如果尚未安装 `pnpm`：

```powershell
npm install --global pnpm
```

### 安装当前本地版本

该包目前尚未发布到 npm。取得本仓库源码后，先生成标准 npm tarball，再安装到 DSH 的 `web` profile：

```powershell
Set-Location path\to\dsh-browser
npm install
$package = npm pack --silent

npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add ".\$package"
npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

`--dump-config` 中应出现 `id: dsh-browser` 和 `name: dsh-browser-plugin`。

### 发布到 npm 后

```powershell
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

首次使用 `npx` 时可能会下载 npm 发布的 DSH CLI 及其依赖；插件安装会下载本插件及其依赖。两条路径都不会下载 DeepSeek Harness 源码 checkout。

## 快速配置（可选）

默认配置可以直接使用。在本地打包前，可以修改本仓库的 [`cordis.patch.yml`](cordis.patch.yml)。安装完成后，把下面的条目合并进 `$DSH_HOME/profiles/web/cordis.patch.yml`（`DSH_HOME` 默认是 `~/.dsh`）已有的 YAML 列表；不要覆盖文件中的其他 profile 条目。该层会覆盖 bundle 默认值。

DSH 的 profile patch 会替换目标条目的整个 `config`，因此覆盖时要重述需要保留的字段：

```yaml
- id: dsh-browser
  config:
    headless: true
    noSandbox: false
    approvalMode: mutating
    viewportWidth: 1280
    viewportHeight: 900
    toolTimeoutMs: 120000
    maxWaitSeconds: 300
    maxContextDeltas: 8
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

修改后重启 DSH，并用 `npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config` 检查最终配置。

| 需求 | 配置项 | 默认值 | 常用改法 |
|---|---|---:|---|
| 后台无界面运行 | `headless` | `false` | 改为 `true` |
| 指定浏览器程序 | `chromePath` | 自动探测 | 填入 Chrome/Chromium 绝对路径 |
| 调整操作审批 | `approvalMode` | `mutating` | `off`、`mutating` 或 `always` |
| 调整浏览器窗口 | `viewportWidth` / `viewportHeight` | `1280` / `900` | 改为所需正整数 |
| 限制单次工具时长 | `toolTimeoutMs` | `120000` | 填写正整数毫秒数 |
| 限制等待时长 | `maxWaitSeconds` | `300` | 填写正整数秒数 |
| 限制 DOM 增量链长 | `maxContextDeltas` | `8` | 正整数；达到后生成完整检查点 |
| 限制脚本可见输出 | `scriptMaxLines` / `scriptMaxBytes` | `100` / `8192` | 改为所需正整数 |
| 保存完整脚本结果 | `outputDir` | 系统临时目录 | 填入目标目录绝对路径 |

只有受控容器确有兼容性需要时才应设置 `noSandbox: true`。

## 使用示例

安装后，直接在 DSH 中使用自然语言描述任务：

### 信息提取

> 打开 Hugging Face 热门模型页面，整理排名前三的模型名称、机构、参数规模和下载量，并给出来源页面。

### 表单填写

> 打开联系表单，填写我提供的字段，检查必填项和格式校验，但不要最终提交。

### 多步骤调研

> 调查一篇论文的官方代码仓库、依赖、最近维护状态和常见复现问题，最后判断复现难度。

涉及登录、购买、发布、删除或最终提交等高风险动作时，应明确限制任务边界并保留 approval。

## 增量 DOM 如何工作

普通浏览器 Agent 经常在每次操作后把整个页面重新发送给模型。这个插件会保留同一标签页的 DOM 快照链：

```text
首次观察       → mode:full         完整 DOM
少量页面变化   → mode:incremental  新增 +| 与移除 -|
大量变化/检查点 → mode:full         建立新的完整基线
没有变化       → mode:nochange     简短状态提示
```

处理链路如下：

```text
CDP Snapshot
  → DOM Tree
  → 可见性与可交互性检测
  → 剪枝、内联合并和视觉元素标记
  → 结构化文本渲染
  → 与上一快照计算差异
  → 返回给 Agent
```

`browser_restore_state` 优先回到仍有效的浏览器历史条目，失败时访问原 URL，再逐项恢复并验证受支持状态。它使用完整版本号（如 `tab0-dom3.2`）恢复检查点 URL、原生表单值、勾选/下拉选项、details 展开状态，以及主页面和局部容器的滚动位置。恢复后逐项核对；不完整时返回 `partial`。密码、文件选择、iframe、任意弹窗与 SPA 内存不在恢复范围内。

## 工具清单

| 工具 | 作用 |
|---|---|
| `browser_start` | 启动浏览器并打开 URL |
| `browser_observe` | 不刷新页面，重新观察完整状态；支持 HTML 或 Markdown |
| `browser_goto` | 导航当前标签页 |
| `browser_refresh` | 刷新当前页面 |
| `browser_restore_state` | 按精确 `stateId` 恢复可支持的页面状态，并报告未恢复项 |
| `browser_new_tab` | 新建标签页 |
| `browser_switch_tab` | 切换活动标签页 |
| `browser_close_tab` | 关闭一个或多个标签页 |
| `browser_click` | 点击 `[N]` 元素 |
| `browser_input` | 向 `<N>` 元素输入内容 |
| `browser_reveal_offscreen` | 展示已知的离屏元素 |
| `browser_scroll_next_screen` | 滚动到下一段未探索内容 |
| `browser_scroll_to_page` | 跳到指定页面位置 |
| `browser_execute_script` | 在页面上下文执行 JavaScript |
| `browser_view_elements` | 截取 `[view:ID]` 视觉元素 |
| `browser_wait` | 可取消地等待指定秒数 |
| `browser_recall` | 按需回读历史事实或已归档的页面观察 |

## 架构

```text
DSH Agent Session
  → Cordis 加载 dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments / observation metadata
  → agent/pre-step: browser context retention
  → Session surface → next model request
```

项目结构：

```text
dsh-browser/
├─ src/
│  ├─ index.ts              # Cordis 插件入口与生命周期
│  ├─ plugin-tools.ts       # 注册 16 个浏览器工具，另有 1 个归档回读工具
│  ├─ tool-schemas.ts       # 参数与输出 schema
│  ├─ config.ts             # 配置 schema 与校验
│  └─ browser/
│     ├─ manager.ts         # 浏览器与标签页生命周期
│     ├─ operations/        # 导航、交互、观察、滚动等操作
│     ├─ cdp/               # CDP 封装
│     └─ dom/               # DOM 构建、渲染、差异与视觉映射
├─ test/                    # node:test 测试
├─ scripts/                 # 真实浏览器和安装验证脚本
├─ cordis.patch.yml         # DSH bundle patch
└─ package.json             # npm 与 DSH bundle 清单
```

`src/` 是源码事实来源，`lib/` 是 `npm run build` 生成的发布产物，不要直接编辑 `lib/`。

上下文策略优先通过 `Session.snapshotEvents()` 读取当前宿主日志；对依赖锁定的 DSH `0.1.2-alpha.2` 使用其 `events` getter。源码链接安装修改后需重新构建插件并重启 `pnpm dsh web`，使进程加载新的 `lib/`。

## 浏览器能力与诊断

我们对 17 个工具统一复用 approval、取消和输出限额，并保持以下能力边界：

| 能力 | 使用方式与边界 |
|---|---|
| 显式观察 | `browser_observe({format: "html"})` 不导航、不刷新，建立完整 DOM 基线；`markdown` 使用完整 AX 语义树并保留操作引用。 |
| 结构化数据 | `__data`、`__find`、`__records` 和 `__skeleton` 帮助读取 JSON-LD、Microdata 和已加载的重复列表；页面数据仍需按任务要求验证。 |
| 跨域 iframe | CDP 请求路由到节点所属子会话，元素引用按 frame 隔离；主页成功不自动证明子框架可操作。 |
| 页面变化提醒 | Host 在 URL 与最近观察不一致时要求重新观察；相同 URL 内的人工修改仍需显式观察。 |
| 离线回归 | `npm run dom:regression -- capture|verify` 录制和回放受控 CDP 输入；录制可能含页面数据，只保存在本地受控目录。 |

`dsh-browser-plugin/diagnostics` 导出 `captureDomTape`、`replayDomTape`、`CDPTape` 和 `CDPStats`。这些接口用于 DOM 文本、元素编号和管线性能诊断，不等同于线上任务成功率。

## 运行 WebVoyager 评测

在本仓库根目录打开 PowerShell，要求 Node.js `>=22.19` 和本机 Chrome/Chromium。脚本直接启动真实 DSH AgentLoop 和浏览器，无需先启动 DSH Web 界面。Agent 自动操作网页，独立的 LLM Judge 请求负责评分。

### 1. 安装依赖并构建

```powershell
# 首次使用或依赖变化后安装
npm install
# 首次评测及修改源码后重新构建
npm run build
```

默认读取现有 DSH 配置（`DSH_HOME` 默认是 `~/.dsh`）：从 `settings.yaml` 获取当前 Agent provider/model/reasoningEffort，通过环境变量或 `.credentials.yaml` 的凭据引用获取 API Key。MiniMax 默认沿用 DSH 的 Anthropic-compatible 路径；`high` 按当前 DSH 映射为 `thinking.enabled` 和 16384-token 思考预算，完整 thinking 块随工具调用历史回放。默认 Agent 和 Judge 共用模型、推理档位及凭据，也可用 `EVAL_*` 环境变量分别覆盖，密钥不会写入仓库。

### 2. 检查选题并可选试跑

```powershell
# 只检查并列出选题，不启动浏览器、不调用模型 API
npm run eval -- --dry-run --reasoning-effort high --headed --timeout 600000 --judge reference

# Allrecipes、Apple、Amazon 各一题，显示浏览器窗口方便观察
npm run eval -- --out output/evals/pilot-run1 --ids "Allrecipes--0,Apple--0,Amazon--0" --reasoning-effort high --concurrency 3 --headed --timeout 600000 --judge reference
```

正式评测条件固定为 `--headed --timeout 600000 --judge reference`：显示浏览器窗口、每题最多运行 600 秒，并逐字加载固定上游版本 opencode-browser 的 `judge-prompt.md`。每次评分提供对应任务和 Agent 结果，要求返回单项 JSON 数组；error/timeout 只要最终答案有效也允许 PASS。它们也是评测器的默认值，但命令中仍显式写出，便于复核 manifest 和复现实验。`reference` 不提交浏览器文本证据或截图；旧的严格证据评分仍可显式选择 `--judge evidence`，但不属于上游同口径。`--reasoning-effort high` 显式固定 Agent 和默认 Judge 的推理档位，并写入 manifest 和运行指纹。真实试跑和全量评测都会消耗 Agent、Judge 的 API 额度；`npm run eval:smoke` 则使用真实浏览器和确定性模型替身，不调用收费 API，也不产生正式评测成绩。

### 3. 顺序运行全部 126 题

```powershell
npm run eval -- --out output/evals/webvoyager-126-concurrency1 --reasoning-effort high --concurrency 1 --headed --timeout 600000 --judge reference
```

数据集包含 Allrecipes 45 题、Apple 42 题、Amazon 39 题。完整运行使用可见浏览器、`reference` 评分、每题 600 秒上限、50 轮模型请求和 `--concurrency 1`。并发会影响限流频率和延迟，对照运行必须保持一致；每次全新评测使用独立输出目录。

当前本地评测汇总覆盖 126/126 题，全部已评分，117/126 通过，成功率 92.9%。平均每题调用浏览器工具 15.3 次，Agent 耗时 149 秒，Agent 成本按标价估算约 $0.031；Judge 成本另计。评分模式为 `reference`，成功率分母包含失败和超时任务。此处的成本是估算值，不是实际账单。

启动时会用小请求检查模型服务，默认准入超时为 60000 ms，可通过 `--preflight-timeout` 调整。Agent 运行中的临时限流、服务端错误、超时和传输错误会按有界指数退避自动重试；preflight 和独立 Judge 请求均为单次调用。Judge API、截断或格式异常记录为未评分，不能算作任务 FAIL；可在服务恢复后用 `--judge-only` 补评。额度耗尽与认证失败不会重试。若出现 `quota_exhausted`，需先恢复对应模型账户的额度。

| `halted` / 现象 | 含义 | 处理方式 |
|---|---|---|
| `provider_rate_limit` | preflight/Judge 首次遇到 HTTP 429，或 Agent 的有界重试仍未恢复 | 等待限流窗口恢复并使用 `--concurrency 1`；零题 preflight 失败且配置未变时可 `--resume`，要重做已有失败题或取得干净成绩则换新目录 |
| `provider_connection` | preflight/Judge 单次调用，或 Agent 重试后仍遇到超时、传输错误、HTTP 5xx | preflight 查控制台和 `preflight.ndjson`；Agent 查 `TASK_ID/result.json`、`trace.ndjson`、`host-log.ndjson`；Judge 查 `results.ndjson` 的 `judge_result`。慢模型可在新输出目录设置 `--preflight-timeout 120000` |
| `quota_exhausted` | 账户额度、余额或 Token Plan 用量已耗尽 | 恢复额度后再运行；此类永久错误不会自动重试 |
| `provider_authentication` | API Key 无效、缺失权限或服务返回 HTTP 401/403 | 检查 DSH provider、`apiKeyEnv` 和 `.credentials.yaml` 引用，不要把密钥写入仓库 |
| `provider_preflight_failed` | 未归入上述类型的准入错误 | 读取 `output/evals/RUN_NAME/preflight.ndjson` 中的 `error`，不要把零题运行当作 benchmark 成绩 |

`Allrecipes` 返回 People Inc access issue 页面时属于目标网站访问限制，不是模型 provider 故障；降低模型并发或延长 preflight 超时不会绕过该限制。

### 4. 中断后继续

```powershell
# 普通中断续跑
npm run eval -- --out output/evals/webvoyager-126-concurrency1 --reasoning-effort high --concurrency 1 --headed --timeout 600000 --judge reference --resume

# 完全更换评分规则：先清除旧 Judge 内容，再重新评分全部已保存 Agent 结果；不重跑浏览器
npm run eval:reset-judge -- --out output/evals/webvoyager-126-concurrency1
npm run eval:reset-judge -- --out output/evals/webvoyager-126-concurrency1 --execute
npm run eval -- --out output/evals/webvoyager-126-concurrency1 --reasoning-effort high --judge-only --judge reference
```

续跑需保持原输出目录、选题、配置及代码指纹完全一致。修改 `--concurrency`、`--preflight-timeout`、模型、Judge、评测脚本或构建产物后不能续跑原目录，必须指定新的 `--out`。已有结果（包括失败和超时）会跳过，不会自动重跑或重新评分；要重新评分时使用 `--judge-only` 生成单独的 `judged-reference.json`。发现已有 `trace.ndjson` 但没有 `result.json` 的中断题时，评测器会直接拒绝继续，避免静默重试。需要重新执行这些题时，使用新的输出目录。不要删除仍需续跑的记录。

### 5. 只补旧运行缺失的任务

```powershell
# 只读核对：验证旧任务轨迹并列出精确差集，不加载凭据或启动浏览器
npm run eval:backfill -- --out output/evals/OLD_RUN --data assets/benchmark/webvoyager-126.json

# 审核清单后执行；旧任务进入保护集合，只有差集可被派发
npm run eval:backfill -- --out output/evals/OLD_RUN --data assets/benchmark/webvoyager-126.json --execute
```

补跑器要求旧 manifest 是新数据集的同内容有序子序列，并逐题验证已有 `task.json`、`session.json`、非空 `trace.ndjson`、`result.json` 和最终索引。旧任务即使存在于恢复计划中也不会被重新运行或重新评分；新增结果按 126 题数据集原位置重建 `results.ndjson`、JSON、Markdown 和 CSV。原 manifest 保存为 `manifest-before-backfill.json`，扩展后的结果标记 `mixed_provenance`。

### 6. 查看结果与保留代码

全量命令的结果位于命令指定的 `output/evals/RUN_NAME/`：

| 文件 | 内容 |
|---|---|
| `report.md` | 总体及分站点成功率、平均步数、耗时、成本估算 |
| `summary.json` | 结构化统计和评分完整性标记 |
| `manifest.json` | 选题、模型、API 协议、推理档位、参数及代码指纹 |
| `results.ndjson` | 逐题执行与评分结果 |
| `TASK_ID/trace.ndjson` | 模型请求、响应和工具执行记录 |
| `TASK_ID/result.json`、`TASK_ID/final.png` | Agent 原始结果和最终截图（如有） |

`completed` 只代表 Agent 执行结束，`judge_result.pass` 才代表 Judge 判定通过。当前只对 MiniMax-M3 提供公开单价估算，GLM 等其他模型会显示 `unpriced_calls`，`total_cost_usd: null` 不代表实际费用为 0；估算也不是 Token Plan 实际账单。

`output/` 中的旧评测记录可在不再需要回看、续跑或重新评分时删除，不影响新评测。请保留正式代码 `scripts/eval/`、插件源码 `src/`、数据集 `assets/benchmark/` 及依赖清单。更多参数、评分口径和参考结果差异见[评测指南](docs/evaluation.md)。

## 开发与验证

```powershell
npm install
npm test
npm run test:smoke
npm run test:host
npm run verify:package
npm run verify:installed
```

| 命令 | 验证内容 |
|---|---|
| `npm test` | 构建、包结构、工具注册、错误契约、approval 和配置测试 |
| `npm run test:smoke` | 真实 Chromium：DOM、脚本、截图、附件、清理，以及动态/虚拟列表、操作验证和状态恢复 |
| `npm run test:host` | 真实 Cordis/DSH Agent Loop + Chromium，验证下一轮消息、基线恢复、截图裁剪、回放与会话隔离；模型决策使用确定性适配器 |
| `npm run verify:package` | 确认 npm 包是独立 DSH bundle 且不包含 Harness checkout |
| `npm run verify:installed` | 在临时 npm 消费者项目中安装 tarball 并导入插件 |

`test/browser-context.test.mjs` 可通过 `DSH_TEST_SESSION_MODULE` 指定另一宿主 Session 模块的文件 URL，以复用全部上下文测试。检查 DSH 源码版本时，从其仓库根目录执行（假设插件位于相邻的 `dsh-browser` 目录）：

```powershell
$env:DSH_TEST_SESSION_MODULE = ([uri](Resolve-Path packages/core/session/src/index.ts).Path).AbsoluteUri
node --import tsx/esm --test ../dsh-browser/test/browser-context.test.mjs
Remove-Item Env:DSH_TEST_SESSION_MODULE
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。我们将动态列表、动作后置条件、检查点恢复、证据记录和 Host 上下文管理视为项目的常规能力，其行为契约分别写在[可靠性文档](docs/reliability.md)和[证据文档](docs/evidence.md)中。

## 许可证

本项目使用 [MIT License](LICENSE)。

---

<a id="english"></a>

# 🇬🇧 dsh-browser-use (English)

> Give DeepSeek Harness a real browser so an Agent can open pages, understand interfaces, fill forms, manage tabs, and complete multi-step tasks.

We build `dsh-browser-plugin` as a standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin for the Web profile. It launches a local Chrome or Chromium instance and exposes 16 browser operations plus one archive recall tool through Puppeteer, the Chrome DevTools Protocol (CDP), and incremental DOM snapshots.

Our current local WebVoyager result covers all 126 tasks across three sites. All tasks were judged with the `reference` judge, and 117 passed: 92.9% success, 15.3 browser tool calls and 149 seconds per task. Estimated Agent cost is about $0.031 per task at list prices; Judge cost is separate.

This repository contains only the browser plugin's own source. It neither contains DeepSeek Harness source nor requires users to clone the Harness repository.

## What it enables

| Task | Without the plugin | With the plugin |
|---|---|---|
| Visit dynamic sites | Limited to search or static fetch | Operate a real Chromium page |
| Fill complex forms | Cannot reliably handle dynamic controls | Locate, fill, and click DOM references |
| Conduct multi-step research | Manually copy content at every step | Continue exploration across tabs |
| Understand page changes | Re-read the full page repeatedly | Prefer DOM diffs and establish a full baseline when needed |
| Inspect charts and images | Text-only information | Capture visual elements as DSH attachments |

## Core features

- **Real Chromium** — Controls local Chrome/Chromium instead of simulating a page or performing an HTTP-only fetch.
- **Incremental DOM** — Returns a full initial snapshot, then prefers `+|` / `-|` diffs to reduce repeated context.
- **Stable element references** — Clickable elements use `[N]`, inputs use `<N>`, and visual elements use `[view:ID]`.
- **Session isolation** — Each DSH Agent owns an independent browser process, tab set, CDP session, and DOM cache.
- **Tabs and long-page exploration** — Create, switch, and close tabs; explore content screen by screen or jump to a page position.
- **Native DSH lifecycle** — Uses Cordis, `defineTool`, approval, cancellation signals, and attachments without a compatibility server.
- **Explicit browser routing** — When the user explicitly requests a browser or Chromium, the model starts with `browser_start` and stays on `browser_*` instead of substituting `web_search` or `web_fetch`.
- **Secure defaults** — Chromium sandboxing is enabled, and state-changing operations request DSH approval by default.
- **Bounded output** — Oversized script results return a preview while the full value is written to a configured or temporary directory.
- **Same-step text retention** — Every DOM snapshot tells the Agent to write important answers, values, and navigation cues into the same assistant output before changing pages, without an extra legacy fact-summary call.
- **On-demand archive recall** — Observations are archived by visit; `browser_recall` retrieves older pages when needed, without per-page registration or a completion coverage gate.
- **Postcondition-aware actions** — Click and input can verify text or URL outcomes; execution, checked postconditions, and whole-task completion remain separate claims.
- **Exact checkpoint restoration** — We restore supported form, details, and scroll state by full `stateId`, reporting incomplete restoration as `partial`.
- **Structured and cross-frame diagnostics** — Script helpers cover JSON-LD and repeated records, while OOPIF routing plus CDP tape/statistics support reproducible DOM diagnostics.

## Quick start

### Requirements

- Node.js `>=22.19`
- Chrome or Chromium
- `pnpm` (used by the DSH plugin installation command)

```powershell
node --version
pnpm --version
```

Install `pnpm` if it is missing:

```powershell
npm install --global pnpm
```

### Install the current local build

The package has not been published to npm yet. Obtain this repository's source, build a standard npm tarball, and add it to the DSH `web` profile:

```powershell
Set-Location path\to\dsh-browser
npm install
$package = npm pack --silent

npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add ".\$package"
npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

The dumped config should contain `id: dsh-browser` and `name: dsh-browser-plugin`.

### After npm publication

```powershell
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

On first use, `npx` may download the published DSH CLI and its dependencies; plugin installation downloads this plugin and its dependencies. Neither path downloads a DeepSeek Harness source checkout.

## Quick configuration (optional)

The defaults work out of the box. Before packing locally, you can edit this repository's [`cordis.patch.yml`](cordis.patch.yml). After installation, merge the entry below into the existing YAML list in `$DSH_HOME/profiles/web/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`); do not overwrite unrelated profile entries. This user layer overrides the bundle defaults.

A DSH profile patch replaces the matched entry's entire `config`, so restate every field that must be retained:

```yaml
- id: dsh-browser
  config:
    headless: true
    noSandbox: false
    approvalMode: mutating
    viewportWidth: 1280
    viewportHeight: 900
    toolTimeoutMs: 120000
    maxWaitSeconds: 300
    maxContextDeltas: 8
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

Restart DSH after editing, then inspect the effective config with `npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config`.

| Need | Setting | Default | Common change |
|---|---|---:|---|
| Run without a visible window | `headless` | `false` | Set to `true` |
| Select a browser executable | `chromePath` | Auto-detect | Set an absolute Chrome/Chromium path |
| Change approval behavior | `approvalMode` | `mutating` | `off`, `mutating`, or `always` |
| Resize the viewport | `viewportWidth` / `viewportHeight` | `1280` / `900` | Set positive integers |
| Limit one tool call | `toolTimeoutMs` | `120000` | Set positive milliseconds |
| Limit explicit waits | `maxWaitSeconds` | `300` | Set positive seconds |
| Bound DOM delta chains | `maxContextDeltas` | `8` | Positive integer; then produce a full checkpoint |
| Bound visible script output | `scriptMaxLines` / `scriptMaxBytes` | `100` / `8192` | Set positive integers |
| Store complete script results | `outputDir` | System temp directory | Set an absolute directory path |

Set `noSandbox: true` only when a controlled container has a demonstrated compatibility requirement.

## Usage examples

After installation, describe the task in natural language:

### Information extraction

> Open the Hugging Face trending models page, collect the top three model names, organizations, parameter counts, and download counts, and include the source page.

### Form filling

> Open the contact form, fill the fields I provide, and check required-field and format validation, but do not submit it.

### Multi-step research

> Investigate a paper's official code repository, dependencies, maintenance status, and common reproduction issues, then rate its reproduction difficulty.

For login, purchase, publish, delete, or final-submit operations, keep approval enabled and state the task boundary explicitly.

## How incremental DOM works

Many browser Agents resend the entire page after every action. This plugin retains a DOM snapshot chain for each tab:

```text
First observation   → mode:full         complete DOM
Small page change   → mode:incremental  added +| and removed -|
Large change/checkpoint → mode:full     new complete baseline
No page change      → mode:nochange     short status message
```

Processing pipeline:

```text
CDP Snapshot
  → DOM Tree
  → visibility and interactivity detection
  → pruning, inline merging, and visual-element mapping
  → structured-text rendering
  → diff against the previous snapshot
  → Agent output
```

`browser_restore_state` uses the exact versioned checkpoint ID (for example `tab0-dom3.2`) to restore its URL, native form values, checked/selected options, details state, and window/nested scroll positions. It verifies the result and returns `partial` when incomplete. Passwords, file selections, iframe state, arbitrary dialogs and SPA memory are not restored.

## Tool reference

| Tool | Purpose |
|---|---|
| `browser_start` | Launch the browser and open a URL |
| `browser_observe` | Observe a full current state without reloading, as HTML or Markdown |
| `browser_goto` | Navigate the active tab |
| `browser_refresh` | Reload the active page |
| `browser_restore_state` | Restore supported page state using the exact checkpoint `stateId`; report omissions |
| `browser_new_tab` | Create a tab |
| `browser_switch_tab` | Change the active tab |
| `browser_close_tab` | Close one or more tabs |
| `browser_click` | Click a `[N]` element |
| `browser_input` | Enter content into a `<N>` element |
| `browser_reveal_offscreen` | Reveal a known off-screen element |
| `browser_scroll_next_screen` | Advance 80% of the viewport with overlap for loaded content |
| `browser_scroll_to_page` | Jump to a page position |
| `browser_execute_script` | Run JavaScript in the page context |
| `browser_view_elements` | Capture `[view:ID]` visual elements |
| `browser_wait` | Wait for a bounded number of seconds with cancellation support |
| `browser_recall` | Read historical facts or archived browser observations on demand |

## Architecture

```text
DSH Agent Session
  → Cordis loads dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments / observation metadata
  → agent/pre-step: browser context retention
  → Session surface → next model request
```

Repository layout:

```text
dsh-browser/
├─ src/
│  ├─ index.ts              # Cordis entry and lifecycle
│  ├─ plugin-tools.ts       # Registers 16 browser tools; one archive recall tool is separate
│  ├─ tool-schemas.ts       # parameter and output schemas
│  ├─ config.ts             # config schema and validation
│  └─ browser/
│     ├─ manager.ts         # browser and tab lifecycle
│     ├─ operations/        # navigation, interaction, observation, and scrolling
│     ├─ cdp/               # CDP wrappers
│     └─ dom/               # DOM building, rendering, diffing, and visual mapping
├─ test/                    # node:test suite
├─ scripts/                 # real-browser and installation verification
├─ cordis.patch.yml         # DSH bundle patch
└─ package.json             # npm and DSH bundle manifest
```

`src/` is the source of truth. `lib/` is generated by `npm run build`; do not edit `lib/` directly.

Context preparation reads current host logs through `Session.snapshotEvents()` and uses the `events` getter on the pinned DSH `0.1.2-alpha.2` host. After changing a source-linked installation, rebuild the plugin and restart `pnpm dsh web` to load the updated `lib/`.

Set `DSH_TEST_SESSION_MODULE` to another host Session module's file URL to run `test/browser-context.test.mjs` against it. For a source checkout, run from the DSH root with its TypeScript loader (the plugin is assumed to be in the sibling `dsh-browser` directory):

```powershell
$env:DSH_TEST_SESSION_MODULE = ([uri](Resolve-Path packages/core/session/src/index.ts).Path).AbsoluteUri
node --import tsx/esm --test ../dsh-browser/test/browser-context.test.mjs
Remove-Item Env:DSH_TEST_SESSION_MODULE
```

## Development and verification

```powershell
npm install
npm test
npm run test:smoke
npm run test:host
npm run verify:package
npm run verify:installed
```

| Command | Evidence produced |
|---|---|
| `npm test` | Build, package shape, tool registration, error contract, approval, and config tests |
| `npm run test:smoke` | Real Chromium DOM, images, cleanup, dynamic/virtual lists, postconditions and checkpoint restoration |
| `npm run test:host` | Published Cordis/DSH Agent Loop + Chromium; real model-request inputs, baseline recovery, images, replay and isolation with deterministic decisions |
| `npm run verify:package` | Confirms the npm package is a standalone DSH bundle with no Harness checkout |
| `npm run verify:installed` | Installs the tarball in a temporary consumer project and imports the plugin |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for security boundaries and vulnerability reporting.

## Browser, evidence, and diagnostic contract

We retain dynamic-list coverage, action postconditions, exact checkpoint restoration, archived observations, and Host context management. The package exposes 17 tools: 16 browser operations and `browser_recall`.

The working-memory flow is **observe → write important findings in the same assistant message → continue browsing → recall archived observations only when needed**. Text notes are not verified `sourceRef` evidence. Exact checkpoint IDs restore supported native fields and scrolling; unavailable state returns `error`, while incomplete restoration returns `partial`.

`browser_observe` creates a current full baseline without reloading, with optional Markdown action references. Script helpers include `__data`, `__records`, `__skeleton`, and browser-free `guide: true`. Child-frame CDP routing, frame-scoped references, URL-change notices, and bounded script evidence extend the same execution contract.

Our opt-in `dom:regression` capture/verify workflow and the separate `/diagnostics` export provide socket-free DOM regression and CDP statistics. Recordings contain local page data and are not general Agent evaluation. See [reliability and verification](docs/reliability.md) and [the evidence state model](docs/evidence.md).

## License

This project is released under the [MIT License](LICENSE).

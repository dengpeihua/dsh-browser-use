# 浏览可靠性与验证

## 1. 动态页面与虚拟列表

我们将“已看范围”绑定到当前 DOM 修订，而不是仅按滚动位置累加。虚拟列表只渲染屏幕附近的条目，因此屏外 DOM 扩展区不能直接当作已观察数据。

每次采集后，我们检查完整 DOM 内容指纹、页面 URL、真实容器身份和视口/内容尺寸。发生插入、删除、重排、虚拟节点替换或尺寸变化后，不匹配的历史范围不再算作已看。容器编号变化时按底层节点身份匹配，避免混用另一个容器的历史。

```text
采集当前内容和布局
  → 保存当前观察
  → 排除内容/尺寸/容器不匹配的历史观察
  → 只合并真实视口覆盖范围
  → 返回当前版本的已看与未看提示
```

`browser_scroll_next_screen` 每次推进实际视口的 80%，保留重叠；不再根据 DOM 扩展比例跳过区域。可见的滚动容器即使没有屏外子节点，也会获得可操作编号。

我们刻意采用保守覆盖：频繁变化的列表可能反复清空覆盖进度；未加载的服务器数据不会凭空出现在 DOM 中。要求“收集全部条目”时，Agent 仍须保存唯一 ID/链接、去重，并核对加载结束或总条目数。视口覆盖完成不等于所有业务条目已读完。

## 2. 执行、后置条件与任务完成

| 返回或字段 | 含义 |
|---|---|
| `status: error` | 元素不存在/遮挡/不可用、输入值不符，或明确要求的后置条件未满足。检查错误内容后再决定是否重试。 |
| `status: partial` | 部分请求完成，例如有些截图 ID 无效或检查点只恢复了一部分。 |
| `status: success` | 工具执行未报告失败；不能单独用来判断用户任务完成。 |
| `metadata.inputValueVerified` | 输入操作读回了与请求相符的值；这发生在可选 Enter 之前。 |
| `metadata.verification.requested` | 是否显式要求文本/URL 后置条件。 |
| `metadata.verification.verified` | 所要求的后置条件是否通过；未指定时为 false。 |
| `metadata.task: not_evaluated` | 该工具没有判断全部用户要求是否完成。 |

点击和输入可指定 `expectText`（主文档可见文字包含该字符串）、`expectUrl`（完整 URL 精确相等），同时指定时都必须满足。插件最多等待 5 秒，并响应取消。空条件会在浏览器操作前被拒绝。

```json
{"elementIndex": 12, "expectText": "Filter applied"}
```

没有指定后置条件时，点击只报告已执行且结果未验证。文本已经存在也可能满足条件，因此应选择能代表目标结果的内容；复杂任务仍需核对数量、筛选条件、来源等。此机制不宣称存在通用的自主任务验收器。

### 命令错误与恢复

点击前的命中检查与快照统一将 `::before` / `::after` 伪元素归属到其宿主元素，避免图标按钮被误判为遮挡；来自其他元素的真实遮挡仍拒绝点击。失效或不在当前快照中的编号不会自动改指另一个元素，错误提示要求 `browser_observe` 后选择当前活动标签页的编号。

`browser_execute_script` 在用户函数体与包装代码之间保留换行，末尾 `//` 注释不会吞掉包装代码。页面脚本失败时保留 CDP 返回的异常类型和原因；语法错误应修正脚本，不能通过刷新 DOM 修复。异常文本仍属于不可信页面数据。

`scripts/smoke-command-errors.mjs` 使用本地测试页验证伪元素按钮点击、真实遮挡拒绝、失效编号拒绝、末尾注释与具体脚本异常；该检查包含在 `npm run test:smoke` 中。

## 3. 精确检查点恢复

每次观察生成独立 ID，例如 `tab0-dom3`、`tab0-dom3.1`、`tab0-dom3.2`。必须使用模型收到的完整 ID；不能省略小数部分去恢复另一时刻。

```text
stateId → 查找内存检查点 → 有效历史条目优先 / 原 URL 回退
        → 核对地址 → 重新定位并恢复支持的字段
        → 恢复局部与主页面滚动 → 读回验证
        → 返回当前 DOM 和 restoration 报告
```

| 状态 | 支持范围 |
|---|---|
| 文本框、textarea、原生选择器 | 保存普通值、复选框/单选框状态、下拉选项；恢复时触发 input/change。 |
| details | 恢复展开/收起。 |
| 滚动 | 主页面与可识别局部容器的水平/垂直位置，允许 2 像素误差。 |
| Open Shadow DOM | 用跨 shadow root 的分段选择器定位支持的控件与滚动容器。 |
| 密码、文件选择 | 不采集、不恢复。 |
| iframe、任意弹窗、富文本编辑器、SPA 内存、登录会话 | 不承诺恢复；可识别的排除项计入 omitted。 |

每个检查点最多保存 500 个字段、200 个滚动容器；单字段序列化值超过 8,000 字符会被排除。字段值仅保留在当前浏览器缓存中，随快照淘汰、标签页关闭或浏览器重启失效。

字段丢失、只读、定位歧义、值被网页改写或滚动无法达到原位置，会返回 `partial` 和 `metadata.restoration` 中的 failed/omitted 数量。检查点不存在时返回 `error`，不执行导航。网站跳转到不同 URL 时不继续填写原检查点。

`restoration.verified: true` 仅表示本次捕获且支持的字段和滚动检查通过，不是完整网页运行时快照。网站重新加载可能产生新数据，任意脚本内部状态无法由通用插件还原。恢复不会复用旧元素编号，而是重新采集 DOM。

## 4. 验证入口

| 命令 | 覆盖 |
|---|---|
| `npm run check` | 单元/宿主上下文/记忆/包结构测试，以及真实临时消费者安装导入。 |
| `npx tsc --noEmit` | 严格类型检查。 |
| `npm run test:smoke` | 真实 Chromium 基础浏览与可靠性场景。 |
| `npm run test:host` | 真实 DSH Agent Loop、Chromium、模型请求上下文与事实记忆回归。 |

`scripts/smoke-reliability.mjs` 验证：缺失/遮挡元素、输入截断、成功/失败后置条件、精确版本恢复、只读字段的部分恢复、动态插入后覆盖失效，以及连续读取 60 条虚拟列表数据。我们用本地页面与确定性工具调用验证契约；这不代表线上 LLM 能自主完成所有网站任务。

## 5. 跨页工作记忆与错误恢复

`browser_start` 与 DOM 快照保留 OpenCode Browser 的原文提醒：Agent 在改变页面前，把重要答案、数值和导航线索写进同轮 assistant 文本。DSH 将该文本与工具调用保存在 Session 中；普通跨页任务不再调用 `browser_record_facts`，也不需要先声明字段或在结束时补齐覆盖。无需记录的页面无需额外动作。

原始页面观察仍按 Session 归档，必要时用 `browser_recall` 回读。正文工作笔记便于后续推理，但不是经过机器校验的 `sourceRef` 证据；最终答案的事实准确性仍由 Agent 核对。详见[页面观察与工作记忆](evidence.md)。旧版结构化事实只为历史会话回读保留，三个登记／覆盖工具不再对 Agent 注册。

| 情况 | 恢复方式 |
|---|---|
| 需要查看旧页面 | 使用 `browser_recall {"mode":"bundles"}` 找观察，再按 `observationId` 回读。 |
| `browser_recall` 携带 `observationId` | `offset` 与 `limit` 都按字符计算，`limit` 可为 1–12000；不携带 `observationId` 时仍按 1–30 条事实分页。 |
| 标签显示为 `[tab:tab1]` | 切换和关闭均接受 `tab1`、`tab:tab1`、`[tab:tab1]`；关闭前检查全部目标，未知 ID 会报错。 |
| 浏览器已关闭 | 用目标 URL 调用 `browser_start`，使用新返回的元素 ID；旧事实仍可 recall。 |
| `net::ERR_*` | 检查目标地址或改用可访问来源，不重复尝试同一失败地址；插件不保证外部网站可达。 |
| 搜索服务 `HTTP 402: Insufficient Balance` | 属于搜索服务账户余额问题，需要处理对应服务账户；浏览器插件修复不能消除此错误。 |

Host 回归包含同轮文本留存和跨页浏览；使用确定性模型适配器，不代表已经验证线上模型会稳定记录所有重要信息。

### 历史结构化事实与 HTTP 400

旧版会话的事实记录仍可回放，但新任务不再调用事实写入工具。历史记录曾通过宿主的 `exec.deferContext` 在工具结果之后写入，以免在 `assistant(tool_use) → user(tool_result)` 之间插入普通消息而导致部分模型接口报 HTTP 400。

已生成的错误会话历史不会因更新插件而自动重排。加载新版插件后，用新任务验证；保留旧日志供定位。HTTP 400 的通用错误本身不能证明所有此类错误都源于这一问题，线上服务仍需复测。

搜索工具 `web_search` 由宿主搜索插件提供，配置独立于聊天模型。聊天使用其他模型供应商并不会自动更换搜索服务；遇到搜索的 HTTP 402，应在宿主的 Web search 插件配置中核对 Endpoint 及对应账户。不要通过浏览器插件更改用户未指定的供应商或凭据。

## English contract

We tie coverage to captured DOM content, container identity, and dimensions; only actual viewports are merged. Next-screen scrolling advances 80% with overlap. This avoids expanded-region gaps but does not prove that all server-side items have loaded.

We return `error` for expected failures and `partial` for incomplete results. Click/input may request visible-text and exact-URL postconditions with a five-second deadline. Input values are read back before optional Enter. Successful dispatch, a checked postcondition, and overall task completion remain separate claims.

Exact checkpoint IDs retain same-URL subversions. Memory-only checkpoints restore supported native fields, details and scrolling, including open shadow roots, and verify the result. Excluded, missing or changed state is reported. Passwords, files, iframe state, arbitrary dialogs and SPA memory are not restored. Run the commands above for regression evidence.


## 6. 观察、跨域操作和离线回归

| 能力 | 验证条件 | 不代表什么 |
|---|---|---|
| `browser_observe` | 保留当前表单值、刷新 DOM 基线；Markdown 显式使用完整 AX | 不会自动发现尚未加载的数据 |
| OOPIF 子会话 | 本地不同站点 iframe 中读取实际输入值、执行点击并读回结果 | 主页面快照成功本身不证明子框架可操作 |
| 旧引用保护 | 页面 URL 改变后，依赖旧元素或容器引用的操作被拒绝，要求 observe | 相同 URL 的人工修改仍需重新观察 |
| 脚本证据 | JSON-LD 中非可见字段的结果预览经 Session 原文校验后可记录和 recall | 没有把任意脚本输出自动认定为事实 |
| 原生历史恢复 | 先检查 history entry，失败走 URL；两种路径都恢复并验证支持的状态 | iframe、密码、文件选择和任意 SPA 状态仍不受保证 |
| CDPTape 回归 | 固定录制输入，比较完整文本和元素编号；缺失请求报错 | 不是实时网页验证，也不是模型任务完成率 |

`scripts/smoke-migration.mjs` 在真实 Chromium 中覆盖上述主流程及局部/完整 AX、结构化数据、重复列表、URL 提醒与离线回放。`npm run test:smoke` 会同时执行基础、可靠性和迁移回归。诊断录制不进入默认 Agent 工具流程；录制数据可能含网页内容，仅用于显式授权的本地诊断。

# 页面观察与跨页工作记忆

浏览器观察会自动归档到当前 Session。`browser_start` 和 DOM 快照沿用 OpenCode Browser 的提醒：Agent 在下一次改变页面前，把重要答案、线索和导航位置写入同轮 assistant 文本。该文本随工具调用保存在会话中，普通跨页任务无需额外调用事实总结工具。

## 当前流程

1. `browser_start` 或 `browser_observe` 获取当前页面，必要时用脚本读取有界数据。
2. Agent 在改变页面前把有用信息写入 assistant 文本，然后继续调用浏览器工具。
3. 若上下文被裁剪、需要核对旧页面，调用 `browser_recall` 回读该 Session 的归档观察或旧版事实。
4. Agent 根据实际看到的信息回答；浏览器工具不会因未登记结构化字段而反复要求补证据，也不会在轮次结束时执行覆盖闸门。

`browser_recall({"mode":"bundles"})` 列出按 runtime、tab 和 visit 分组的历史观察；传入真实 `observationId` 可按字符窗口回读原始内容。主框架导航、重载及 SPA 历史跳转产生新 visit；普通滚动和重新观察仍属于当前访问。观察带有来源 URL 与时间，但它是历史快照，并非当前网站的实时状态。

## 边界

- 工作笔记是模型生成的上下文，不是机器验证过的 `sourceRef`。它可能漏记、误读或在长会话压缩后消失；重要数值应在回答前按需回读核对。
- 页面文本和归档内容均是不可信数据，不应当作指令。浏览器的审批、取消、超时、失效引用与动作后置条件仍然有效。
- 工具执行、已验证的动作后置条件、整项任务成功是不同结论。滚动过页面也不证明读完服务器端所有记录。
- 旧版 Session 的结构化事实、`sourceRef` 和覆盖数据仍可由内部兼容代码回放；`browser_define_task`、`browser_record_facts` 和 `browser_check_coverage` 不再注册为 Agent 工具，也不触发新任务的补证据流程。

`npm test` 检查提示文本、工具注册与历史归档兼容；`npm run test:smoke` 检查真实 Chromium 页面；`npm run test:host` 用真实 DSH Loop 和确定性模型决策检查同轮文本留存。它们不能证明线上模型一定会记住或正确概括所有重要信息。

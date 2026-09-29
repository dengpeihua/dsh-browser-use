# WebVoyager 按指定规则复核

在 WebVoyager 549 tasks / 13 站点上取得 88.0 % 的成功率，平均 16.3 steps / 任务，耗时 140 s / 任务，成本约 $ 0.028 / 任务。

| 站点 | 通过/总数 | 准确率 |
|---|---:|---:|
| Allrecipes | 42/45 | 93.3% |
| Amazon | 34/39 | 87.2% |
| Apple | 39/42 | 92.9% |
| ArXiv | 38/38 | 100.0% |
| BBC News | 35/41 | 85.4% |
| Booking | 11/12 | 91.7% |
| Cambridge Dictionary | 24/43 | 55.8% |
| Coursera | 37/42 | 88.1% |
| ESPN | 33/36 | 91.7% |
| GitHub | 36/38 | 94.7% |
| Google | 79/91 | 86.8% |
| Hugging Face | 37/41 | 90.2% |
| Wolfram Alpha | 38/41 | 92.7% |

Agent 加 Judge 成本约 $0.029 / 任务；美元成本按配置或历史标价估算，不是账单，且只统计每题最新尝试。

逐题判定见 judgments.json；完整最新尝试与判定见 results.ndjson；12 项相对原参考 Judge 的严格条件修正见 corrections.json。
评分复用本项目先前按完全相同参考提示词产生的 549 项判定，并依据最终答案修正发现的明确冲突；本次导出没有重新调用模型或浏览器。原运行根目录的 results.ndjson 和修订链保持原样。

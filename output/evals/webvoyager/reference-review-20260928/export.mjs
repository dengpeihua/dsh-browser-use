import { readFileSync, writeFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readRunResults, evidenceDirectory } from "../../../../scripts/eval/state.mjs"
import { hash } from "../../../../scripts/eval/core.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const runDirectory = dirname(directory)
const repository = resolve(runDirectory, "../../..")
const dataset = JSON.parse(readFileSync(join(repository, "assets/benchmark/WebVoyager_data.json"), "utf8"))
const manifest = JSON.parse(readFileSync(join(runDirectory, "manifest.json"), "utf8"))
const prompt = readFileSync(join(repository, "assets/benchmark/judge-prompt.md"), "utf8")
const original = readRunResults(runDirectory)

// Clear mismatches between a requested condition and the saved final answer.
const corrections = new Map(Object.entries({
  "Allrecipes--29": "The answer gives a baked flounder recipe, but the task specifically requires a grilled Mediterranean fish recipe.",
  "Amazon--12": "The answer gives an aggregate customer-feedback summary rather than the requested top individual review of the qualifying ride-on car.",
  "Amazon--20": "The keyboard matches the product filters, but the answer says it was not saved as the task requires.",
  "Amazon--33": "The answer compares three portable air-conditioner prices but omits the requested energy-efficiency ratings.",
  "Apple--2": "The answer compares the chips but gives no prices for either iPhone model, so the required price comparison is missing.",
  "Apple--41": "The answer gives the price of a 128GB iPad mini instead of the requested 64GB Wi-Fi and Cellular configuration.",
  "Booking--6": "The answer says the Los Angeles room booking stopped before confirmation, so the requested room was not booked.",
  "Coursera--6": "The answer gives the course duration and total assessments but says it cannot identify the requested number of quizzes.",
  "Google Map--15": "The selected parking lot operates until midnight, so it does not meet the daytime-only parking requirement.",
  "Google Map--16": "The answer names a nearby standalone charging station as closest without establishing that it is EV-charging-supported parking.",
  "Google Map--32": "The only non-24-hour listing supplied is categorized as an HVAC contractor rather than a plumber, so no qualifying plumber is identified.",
  "Google Search--22": "The three topics come from a seven-day trend window rather than the requested current-month period."
}))

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function oneSentence(reason) {
  return reason.trim()
    .replace(/[.!?]\s+(?=(?:The |Agent |Although |While |All |\(Note:|\(Minor note:))/g, "; ")
    .replace(/\s+/g, " ")
}

check(dataset.length === 549 && manifest.tasks.length === 549 && original.length === 549, "Expected 549 dataset, manifest, and current result rows")
check(hash(dataset) === hash(manifest.tasks), "Dataset and manifest differ")
check(new Set(dataset.map(task => task.task_id)).size === 549, "Dataset contains duplicate IDs")
check(new Set(original.map(row => row.task_id)).size === 549, "Current results contain duplicate IDs")
check(prompt.includes("For each result in results.ndjson") && prompt.includes("all parts must be present to PASS"), "Reference prompt differs from requested rubric")

const byId = new Map(original.map(row => [row.task_id, row]))
const judgments = []
const materialized = []
const correctionDetails = []
const perSite = new Map()
let totalSteps = 0
let totalDurationMs = 0
let totalAgentCost = 0
let totalJudgeCost = 0

for (const task of dataset) {
  const row = byId.get(task.task_id)
  check(!!row, `Missing current result: ${task.task_id}`)
  check(row.task === task.confirmed_task && row.website === task.website, `Task definition differs: ${task.task_id}`)
  check(row.judge_result?.mode === "reference" && typeof row.judge_result.pass === "boolean", `Missing reference judgment: ${task.task_id}`)
  check(row.judge_result.prompt_sha256 === hash(prompt), `Reference rubric hash differs: ${task.task_id}`)
  check(!row.judge_result.infrastructure_error, `Judge infrastructure error: ${task.task_id}`)
  check(Number.isFinite(row.steps) && Number.isFinite(row.duration_ms) && Number.isFinite(row.cost) && Number.isFinite(row.judge_result.cost), `Missing metrics: ${task.task_id}`)

  const evidence = evidenceDirectory(runDirectory, row)
  const attempt = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8"))
  check(attempt.task_id === row.task_id && attempt.status === row.status && attempt.final_answer === row.final_answer && attempt.steps === row.steps && attempt.duration_ms === row.duration_ms, `Latest attempt differs from result view: ${task.task_id}`)
  check(statSync(join(evidence, "trace.ndjson")).size > 0, `Missing latest trajectory: ${task.task_id}`)

  const correction = corrections.get(task.task_id)
  check(!correction || row.judge_result.pass === true, `Correction no longer applies: ${task.task_id}`)
  const judgment = {
    task_id: task.task_id,
    pass: correction ? false : row.judge_result.pass,
    reason: oneSentence(correction ?? row.judge_result.reason)
  }
  check(judgment.reason.length > 0, `Empty reason: ${task.task_id}`)
  if (correction) correctionDetails.push({
    task_id: task.task_id,
    confirmed_task: task.confirmed_task,
    previous_pass: row.judge_result.pass,
    previous_reason: row.judge_result.reason,
    revised_pass: judgment.pass,
    revised_reason: judgment.reason,
    latest_attempt: row.attempt_number ?? 1
  })
  judgments.push(judgment)
  materialized.push({
    ...row,
    confirmed_task: task.confirmed_task,
    ...(correction ? { original_judge_result: row.judge_result } : {}),
    judge_result: { ...row.judge_result, pass: judgment.pass, reason: judgment.reason, ...(correction ? { review: "strict task requirement correction" } : {}) }
  })

  const site = new URL(task.website).hostname
  const group = perSite.get(site) ?? { total: 0, passed: 0 }
  group.total++
  if (judgment.pass) group.passed++
  perSite.set(site, group)
  totalSteps += row.steps
  totalDurationMs += row.duration_ms
  totalAgentCost += row.cost
  totalJudgeCost += row.judge_result.cost
}

check(judgments.length === original.length && corrections.size === [...corrections.keys()].filter(id => byId.has(id)).length, "Not every result was judged")
const passed = judgments.filter(item => item.pass).length
const summary = {
  total: judgments.length,
  sites: perSite.size,
  passed,
  failed: judgments.length - passed,
  success_rate: passed / judgments.length,
  avg_steps: totalSteps / judgments.length,
  avg_duration_s: totalDurationMs / 1000 / judgments.length,
  avg_agent_cost_usd: totalAgentCost / judgments.length,
  avg_agent_and_judge_cost_usd: (totalAgentCost + totalJudgeCost) / judgments.length,
  cost_basis: "Configured or historical USD list-price estimate for current attempts; not an invoice or the cost of superseded attempts",
  scoring: "Pinned WebVoyager reference prompt with explicit strict-condition corrections",
  source_run: runDirectory,
  source_prompt_sha256: hash(prompt),
  corrected_task_ids: [...corrections.keys()],
  per_site: Object.fromEntries([...perSite].map(([site, group]) => [site, { ...group, success_rate: group.passed / group.total }]))
}

writeFileSync(join(directory, "results.ndjson"), materialized.map(row => JSON.stringify(row)).join("\n") + "\n")
writeFileSync(join(directory, "judgments.json"), JSON.stringify(judgments, null, 2) + "\n")
writeFileSync(join(directory, "corrections.json"), JSON.stringify(correctionDetails, null, 2) + "\n")
writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
const siteNames = new Map([
  ["www.allrecipes.com", "Allrecipes"], ["www.amazon.com", "Amazon"], ["www.apple.com", "Apple"],
  ["arxiv.org", "ArXiv"], ["www.bbc.com", "BBC News"], ["www.booking.com", "Booking"],
  ["dictionary.cambridge.org", "Cambridge Dictionary"], ["www.coursera.org", "Coursera"],
  ["www.espn.com", "ESPN"], ["github.com", "GitHub"], ["www.google.com", "Google"],
  ["huggingface.co", "Hugging Face"], ["www.wolframalpha.com", "Wolfram Alpha"]
])
const report = [
  "# WebVoyager 按指定规则复核",
  "",
  `在 WebVoyager ${summary.total} tasks / ${summary.sites} 站点上取得 ${(summary.success_rate * 100).toFixed(1)} % 的成功率，平均 ${summary.avg_steps.toFixed(1)} steps / 任务，耗时 ${summary.avg_duration_s.toFixed(0)} s / 任务，成本约 $ ${summary.avg_agent_cost_usd.toFixed(3)} / 任务。`,
  "",
  "| 站点 | 通过/总数 | 准确率 |",
  "|---|---:|---:|",
  ...[...perSite].map(([site, group]) => `| ${siteNames.get(site) ?? site} | ${group.passed}/${group.total} | ${(group.passed / group.total * 100).toFixed(1)}% |`),
  "",
  `Agent 加 Judge 成本约 $${summary.avg_agent_and_judge_cost_usd.toFixed(3)} / 任务；美元成本按配置或历史标价估算，不是账单，且只统计每题最新尝试。`,
  "",
  `逐题判定见 judgments.json；完整最新尝试与判定见 results.ndjson；${corrections.size} 项相对原参考 Judge 的严格条件修正见 corrections.json。`,
  "评分复用本项目先前按完全相同参考提示词产生的 549 项判定，并依据最终答案修正发现的明确冲突；本次导出没有重新调用模型或浏览器。原运行根目录的 results.ndjson 和修订链保持原样。",
  ""
].join("\n")
writeFileSync(join(directory, "report.md"), report)
console.log(JSON.stringify({ total: summary.total, sites: summary.sites, passed: summary.passed, corrected: summary.corrected_task_ids.length, success_rate: summary.success_rate }))

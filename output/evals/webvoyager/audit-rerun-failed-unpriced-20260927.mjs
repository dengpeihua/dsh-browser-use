import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readRunResults, evidenceDirectory } from "../../../scripts/eval/state.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const readJson = name => JSON.parse(readFileSync(join(directory, name), "utf8"))
const selection = readJson("rerun-failed-unpriced-20260927.json")
const manifest = readJson("manifest.json")
const recovery = readJson("recovery.json")
const summary = readJson("summary.json")
const rows = readJson("task-metrics.json")
const results = readRunResults(directory)
const rerun = manifest.reruns?.find(item => JSON.stringify(item.task_ids) === JSON.stringify(selection.task_ids))
const problems = []
const check = (condition, message) => { if (!condition) problems.push(message) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

check(manifest.tasks?.length === 549, `Dataset task count: ${manifest.tasks?.length}`)
check(selection.task_ids?.length === 87, `Selected task count: ${selection.task_ids?.length}`)
check(same(rerun?.task_ids, selection.task_ids), "Latest rerun does not match the selected task IDs")
check(same(rerun?.protected_override_task_ids, selection.protected_override_task_ids), "Protected override IDs differ")
check(recovery.halted === null, `Run halted: ${recovery.halted}`)
check(recovery.pending?.length === 0, `Selected tasks still pending: ${recovery.pending?.length}`)
check(results.length === 549 && new Set(results.map(result => result.task_id)).size === 549, "Current result view is not exactly 549 unique tasks")
check(rows.length === 549 && new Set(rows.map(row => row.task_id)).size === 549, "Task metrics view is not exactly 549 unique tasks")
check(summary.total === 549 && summary.attempted === 549 && summary.judged === 549 && summary.unjudged === 0, "Summary coverage or judging is incomplete")

const byId = new Map(results.map(result => [result.task_id, result]))
const previous = new Map(rerun?.previous_attempts?.map(item => [item.task_id, item.attempt_number]) ?? [])
for (const id of selection.task_ids ?? []) {
  const result = byId.get(id)
  check(!!result, `Missing selected result: ${id}`)
  if (!result) continue
  check((result.attempt_number ?? 1) > (previous.get(id) ?? Infinity), `No replacement attempt: ${id}`)
  const evidence = evidenceDirectory(directory, result)
  check(existsSync(join(evidence, "result.json")), `Missing current result file: ${id}`)
  check(existsSync(join(evidence, "trace.ndjson")), `Missing current trajectory: ${id}`)
}

for (const result of results) {
  check(typeof result.judge_result?.pass === "boolean", `Unscored task: ${result.task_id}`)
  check(!result.judge_result?.infrastructure_error, `Judge infrastructure error: ${result.task_id}`)
}
check(summary.passed === results.filter(result => result.judge_result?.pass === true).length, "Summary pass count does not match current results")
check(Object.values(summary.per_site ?? {}).reduce((sum, site) => sum + site.total, 0) === 549, "Per-site totals do not sum to 549")
check(summary.cost_known_tasks === 549 && Number.isFinite(summary.avg_cost_usd), "Agent cost remains incomplete")
check(Number.isFinite(summary.judge_cost_usd) && Number.isFinite(summary.total_task_cost_usd), "Agent plus Judge cost remains incomplete")

const csv = readFileSync(join(directory, "task-metrics.csv"), "utf8").replace(/^\uFEFF/, "")
const csvLines = csv.split(/\r?\n/).filter(Boolean)
check(csvLines.length === 551, `CSV line count: ${csvLines.length}`)
check(csvLines.every(line => line.split(",").length === 10), "CSV does not have ten columns on every line")
const blankRows = csvLines.slice(1).filter(line => line.split(",").some(cell => cell === ""))
check(blankRows.length === 0, `CSV rows with blank cells: ${blankRows.length}`)
check(csvLines.at(-1)?.startsWith('"合计",'), "CSV total row is missing")
const unpricedTaskIds = rows.filter(row => !Number.isFinite(row.agent_cost_usd)).map(row => row.task_id)

const report = {
  audited_at: new Date().toISOString(),
  valid: problems.length === 0,
  problems,
  selected: selection.task_ids.length,
  replaced: selection.task_ids.filter(id => (byId.get(id)?.attempt_number ?? 1) > (previous.get(id) ?? Infinity)).length,
  total: summary.total,
  sites: Object.keys(summary.per_site ?? {}).length,
  passed: summary.passed,
  success_rate: summary.success_rate,
  avg_steps: summary.avg_steps,
  avg_duration_s: summary.avg_duration_s,
  avg_cost_usd: summary.avg_cost_usd,
  avg_judge_cost_usd: Number.isFinite(summary.judge_cost_usd) ? summary.judge_cost_usd / summary.total : null,
  avg_agent_and_judge_cost_usd: Number.isFinite(summary.total_task_cost_usd) ? summary.total_task_cost_usd / summary.total : null,
  cost_basis: summary.cost_basis,
  unpriced_task_ids: unpricedTaskIds,
  csv_blank_row_labels: blankRows.map(line => line.split(",")[0].replaceAll('"', "")),
  per_site: summary.per_site,
  current_attempts: results.map(result => ({ task_id: result.task_id, attempt: result.attempt_number ?? 1, directory: result.attempt_directory ?? result.task_id })),
}
const reportPath = join(directory, "rerun-failed-unpriced-20260927.audit.json")
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({ valid: report.valid, problems, selected: report.selected, replaced: report.replaced, total: report.total, passed: report.passed, sites: report.sites, avg_steps: report.avg_steps, avg_duration_s: report.avg_duration_s, avg_cost_usd: report.avg_cost_usd }))
if (problems.length) process.exitCode = 1

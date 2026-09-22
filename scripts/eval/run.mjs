import { spawn, execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { DEFAULT_PREFLIGHT_TIMEOUT_MS, appendJson, hash, readJson, readLines, summarize, validateTasks, writeJson, infrastructureFailure, judgeOnlyPlan, measurementHealth, normalizeUsage, estimateCost, redact, resultHaltReason, resumeAction } from "./core.mjs"
import { readRunResults, reviseResult, nextAttempt, evidenceDirectory, historicalCosts, writeResultIndex } from "./state.mjs"
import { loadConfig, publicConfig, validateReasoningEffort } from "./config.mjs"
import { judgeResult } from "./judge.mjs"
import { complete } from "./provider.mjs"
import { DEFAULT_PRICING, aggregateMetrics, summarizeCalls, recoverCalls, taskMetrics, taskRows, taskTable, tokenMetrics } from "./metrics.mjs"
import { recoveryPlan as buildRecoveryPlan, executionFailure } from "./core.mjs"
import { recoverAttemptResults } from "./state.mjs"
import { acquireRunLock, orderResults, planBackfill } from "./backfill.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const DEFAULT_TASK_TIMEOUT_MS = 600000
const DEFAULT_JUDGE_MODE = "reference"
const DEFAULT_HEADED = true
const { values: flags } = parseArgs({ options: {
  data: { type: "string", default: "assets/benchmark/webvoyager-126.json" },
  out: { type: "string" }, site: { type: "string" }, ids: { type: "string" }, count: { type: "string" },
  timeout: { type: "string", default: String(DEFAULT_TASK_TIMEOUT_MS) }, concurrency: { type: "string", default: "1" },
  "preflight-timeout": { type: "string", default: String(DEFAULT_PREFLIGHT_TIMEOUT_MS) },
  "max-rounds": { type: "string", default: "50" }, judge: { type: "string", default: DEFAULT_JUDGE_MODE },
  "reasoning-effort": { type: "string" },
  "retry-from": { type: "string" },
  "rerun-ids": { type: "string" },
  "new-rerun": { type: "boolean" },
  resume: { type: "boolean" }, "judge-only": { type: "boolean" }, "backfill-missing": { type: "boolean" }, "dry-run": { type: "boolean" },
  headed: { type: "boolean" }, help: { type: "boolean" },
} })
if (flags.help) {
  console.log("Defaults: headed Chromium, 600000 ms per task, opencode-compatible reference judge. --resume retries service failures and rejudges unresolved completed answers. --retry-from OLD_RUN requires a new --out and preserves prior results with mixed provenance.")
  console.log("Usage: npm run eval -- [--data assets/benchmark/webvoyager-126.json] [--out output/evals/NAME] [--site allrecipes|apple|amazon] [--ids Allrecipes--0,Apple--0,Amazon--0] [--count N] [--concurrency 1] [--timeout 600000] [--preflight-timeout 60000] [--max-rounds 50] [--reasoning-effort off|minimal|low|medium|high|xhigh|max] [--judge reference|evidence|none] [--resume] [--judge-only] [--backfill-missing] [--rerun-ids Allrecipes--30] [--new-rerun] [--dry-run] [--headed]\nReference mode follows the pinned opencode-browser judge-prompt.md rubric, including grading error/timeout results when they contain an answer; evidence mode retains this project's stricter observation-backed rubric for historical compatibility. Reads the active DSH model/key/reasoning effort from settings and credential refs; optional EVAL_* environment overrides. MiniMax uses the DSH Anthropic protocol mapping. Every new run uses fresh per-task Chromium. Resume requires identical dataset/config/code. Judge-only reuses saved attempts without re-running browsers. Backfill-missing extends an existing run only after protecting and verifying every prior trajectory. Rerun-ids is an owner-requested replacement that preserves the prior attempt and updates the current result view; new-rerun explicitly starts another replacement request for the same IDs.")
  process.exit(0)
}
const positive = (value, name) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}
const settings = { timeout: positive(flags.timeout, "timeout"), preflightTimeout: positive(flags["preflight-timeout"], "preflight-timeout"), maxRounds: positive(flags["max-rounds"], "max-rounds"), headed: flags.headed ?? DEFAULT_HEADED }
const concurrency = positive(flags.concurrency, "concurrency")
const reasoningEffortOverride = validateReasoningEffort(flags["reasoning-effort"])
if (concurrency > 8) throw new Error("concurrency must be <= 8")
if (!["reference", "evidence", "none"].includes(flags.judge)) throw new Error("Unknown judge mode")
if (flags["judge-only"] && !flags.out) throw new Error("--judge-only requires --out")
if (flags.resume && !flags.out) throw new Error("--resume requires --out")
if (flags["backfill-missing"] && !flags.out) throw new Error("--backfill-missing requires --out")
if (flags["rerun-ids"] && !flags.out) throw new Error("--rerun-ids requires --out")
if (flags["new-rerun"] && !flags["rerun-ids"]) throw new Error("--new-rerun requires --rerun-ids")
if (flags["judge-only"] && flags.judge === "none") throw new Error("--judge-only requires reference or evidence grading")
if (flags["retry-from"] && (!flags.out || flags.resume || flags["judge-only"])) throw new Error("--retry-from requires a new --out and cannot combine with --resume/--judge-only")
if (flags["backfill-missing"] && (flags.resume || flags["judge-only"] || flags["retry-from"] || flags.site || flags.ids || flags.count)) throw new Error("--backfill-missing cannot combine with resume, judge-only, retry-from, site, ids, or count")
if (flags["rerun-ids"] && (flags.resume || flags["judge-only"] || flags["retry-from"] || flags["backfill-missing"] || flags.site || flags.ids || flags.count)) throw new Error("--rerun-ids cannot combine with resume, judge-only, retry-from, backfill-missing, site, ids, or count")
let tasks = validateTasks(readJson(resolve(root, flags.data)))
const requestedRerunIds = flags["rerun-ids"] ? flags["rerun-ids"].split(",").map(id => id.trim()).filter(Boolean) : []
if (new Set(requestedRerunIds).size !== requestedRerunIds.length) throw new Error("--rerun-ids contains duplicate task IDs")
if (requestedRerunIds.some(id => !tasks.some(task => task.task_id === id))) throw new Error("Unknown --rerun-ids task ID")
const requestedRerunSet = new Set(requestedRerunIds)
const rerunIds = tasks.filter(task => requestedRerunSet.has(task.task_id)).map(task => task.task_id)
if (flags.site) tasks = tasks.filter(t => new URL(t.website).hostname.includes(flags.site.toLowerCase()))
if (flags.ids) {
  const ids = flags.ids.split(",")
  if (ids.some(id => !tasks.some(t => t.task_id === id))) throw new Error("Unknown selected task ID")
  tasks = tasks.filter(t => ids.includes(t.task_id))
}
if (flags.count) tasks = tasks.slice(0, positive(flags.count, "count"))
validateTasks(tasks)
if (flags["dry-run"]) {
  let recoveryPlan
  let backfill
  if (flags["backfill-missing"]) {
    const source = resolve(root, flags.out)
    const manifest = readJson(join(source, "manifest.json"))
    const rows = readRunResults(source)
    backfill = planBackfill({ directory: source, tasks, manifest, results: rows })
    recoveryPlan = backfill.rows.map(({ task_id, action, reason }) => ({ task_id, action, reason }))
  } else if (rerunIds.length) {
    const source = resolve(root, flags.out)
    const manifest = readJson(join(source, "manifest.json"))
    if (hash(manifest.tasks) !== hash(tasks)) throw new Error("Targeted rerun requires exactly the existing dataset")
    const rows = readRunResults(source)
    const protectedIds = new Set(manifest.backfill?.protected_task_ids ?? [])
    if (rerunIds.some(id => protectedIds.has(id))) throw new Error("Targeted rerun cannot replace a protected pre-extension task")
    if (rerunIds.some(id => !rows.some(row => row.task_id === id))) throw new Error("Targeted rerun requires an existing result for every selected task")
    const normalizeRequestIds = ids => tasks.filter(task => ids.includes(task.task_id)).map(task => task.task_id)
    const requestKey = hash(rerunIds)
    const existingRequest = flags["new-rerun"] ? null : manifest.reruns?.findLast(item =>
      (item.request_key ?? hash(normalizeRequestIds(item.task_ids))) === requestKey
      && Array.isArray(item.previous_attempts))
    const previous = new Map(existingRequest?.previous_attempts.map(item => [item.task_id, item]) ?? [])
    const byId = new Map(rows.map(row => [row.task_id, row]))
    recoveryPlan = tasks.map(task => {
      if (!rerunIds.includes(task.task_id)) return { task_id: task.task_id, action: "skip", reason: "not_selected" }
      const result = byId.get(task.task_id)
      const before = previous.get(task.task_id)
      if (!before || !result || (result.attempt_number ?? 1) <= before.attempt_number) return { task_id: task.task_id, action: "run", reason: "owner_requested_replacement" }
      const action = resumeAction(result, manifest.judge_mode)
      return { task_id: task.task_id, action, reason: action === "run" ? executionFailure(result) || "interrupted_replacement" : action === "judge" ? result.judge_result?.infrastructure_error || "unjudged_replacement" : "replacement_finished" }
    })
  } else if (flags["retry-from"] || flags.resume) {
    const source = resolve(root, flags["retry-from"] || flags.out)
    if (hash(readJson(join(source, "manifest.json")).tasks) !== hash(tasks)) throw new Error("Recovery requires exactly the original selected tasks")
    const rows = readRunResults(source)
    summarize(rows, tasks)
    recoveryPlan = buildRecoveryPlan(tasks, rows, flags.judge)
  }
  console.log(JSON.stringify({ total: tasks.length, ids: tasks.map(t => t.task_id), settings, reasoning_effort: reasoningEffortOverride ?? "from DSH settings", judge: flags.judge, backfill: backfill ? { protected: backfill.protected, missing_task_ids: backfill.missing_task_ids, pending: backfill.pending } : undefined, recovery_plan: recoveryPlan, note: "Read-only plan; no credentials loaded, provider request, browser launch, or output mutation" }, null, 2))
  process.exit(0)
}
const config = loadConfig({ ...process.env, ...(reasoningEffortOverride ? { EVAL_REASONING_EFFORT: reasoningEffortOverride } : {}) })
const pricing = { currency: "USD", unit: "per million tokens", basis: "configured or historical list-price estimate, not an invoice", agent: config.agent.pricing ?? (config.agent.model === "MiniMax-M3" ? DEFAULT_PRICING : null), judge: config.judge.pricing ?? (config.judge.model === "MiniMax-M3" ? DEFAULT_PRICING : null) }
const directory = resolve(root, flags.out || `output/evals/${new Date().toISOString().replace(/[:.]/g, "-")}`)
const directoryExisted = existsSync(directory)
if (flags["retry-from"] && directoryExisted) throw new Error("--retry-from output must be a new directory")
const releaseRunLock = acquireRunLock(directory)
process.once("exit", releaseRunLock)
const children = new Set()
let interrupted = false
let haltReason = null
function stop(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
  else { try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") } }
}
process.on("SIGINT", () => { interrupted = true; for (const child of children) stop(child) })
process.on("SIGTERM", () => { interrupted = true; for (const child of children) stop(child) })
const codeFiles = readdirSync(join(root, "scripts/eval")).filter(f => f.endsWith(".mjs")).sort()
const fingerprint = hash({ tasks, settings, concurrency, config: publicConfig(config.agent), judge: publicConfig(config.judge), judgeMode: flags.judge, code: codeFiles.map(f => [f, hash(readFileSync(join(root, "scripts/eval", f)))]), bundle: hash(readFileSync(join(root, "lib/index.js"))), dependencies: hash(readFileSync(join(root, "package-lock.json"))) })
const manifestPath = join(directory, "manifest.json")
let baseline = null
let imported = []
let backfillMetadata = null
let rerunMetadata = null
let protectedTaskIds = new Set()
if (flags["retry-from"]) {
  const source = resolve(root, flags["retry-from"])
  const original = readJson(join(source, "manifest.json"))
  if (hash(original.tasks) !== hash(tasks)) throw new Error("--retry-from requires exactly the original selected tasks")
  const inherited = readRunResults(source)
  summarize(inherited, tasks)
  // Carry provenance, not files; original sessions are read-only evidence inputs.
  imported = inherited.map(result => ({ ...result, inherited: true, inherited_evidence_directory: result.inherited ? result.inherited_evidence_directory : evidenceDirectory(source, result) }))
  baseline = { source, fingerprint: original.fingerprint, results_sha256: hash(inherited), mixed_provenance: true }
}
if (existsSync(manifestPath)) {
  if (!flags.resume && !flags["judge-only"] && !flags["backfill-missing"] && !rerunIds.length) throw new Error("Output run already exists; use --resume or choose another --out")
  const prior = readJson(manifestPath)
  baseline = prior.baseline ?? null
  if (flags["backfill-missing"]) {
    const existingResults = readRunResults(directory)
    const plan = planBackfill({ directory, tasks, manifest: prior, results: existingResults })
    if (hash(prior.settings) !== hash(settings) || prior.concurrency !== concurrency || prior.judge_mode !== flags.judge) throw new Error("Backfill settings, concurrency, or judge mode differ from the existing run")
    if (hash(prior.agent) !== hash(publicConfig(config.agent)) || hash(prior.judge) !== hash(publicConfig(config.judge))) throw new Error("Backfill Agent or Judge configuration differs from the existing run")
    if (prior.backfill) {
      if (hash(prior.tasks) !== hash(tasks) || prior.fingerprint !== fingerprint) throw new Error("Backfill dataset or code changed after extension; restore the recorded version before continuing")
      backfillMetadata = prior.backfill
    } else {
      const backupPath = join(directory, "manifest-before-backfill.json")
      if (existsSync(backupPath) && hash(readJson(backupPath)) !== hash(prior)) throw new Error("Existing manifest-before-backfill.json does not match the current source manifest")
      if (!existsSync(backupPath)) writeJson(backupPath, prior)
      backfillMetadata = {
        version: 1,
        extended_at: new Date().toISOString(),
        mixed_provenance: true,
        source_manifest_sha256: hash(prior),
        source_dataset_sha256: prior.dataset_sha256,
        source_task_count: prior.tasks.length,
        protected_task_ids: plan.protected_task_ids,
        added_task_ids: tasks.filter(task => !plan.protected_task_ids.includes(task.task_id)).map(task => task.task_id),
        target_dataset_sha256: hash(tasks),
      }
      writeResultIndex(directory, orderResults(readLines(join(directory, "results.ndjson")), tasks))
      writeJson(manifestPath, { ...prior, version: 3, fingerprint, tasks, dataset_sha256: hash(tasks), backfill: backfillMetadata, updated_at: new Date().toISOString(), extension_runtime: { node: process.version, platform: process.platform } })
    }
    protectedTaskIds = new Set(backfillMetadata.protected_task_ids)
  } else if (rerunIds.length) {
    if (hash(prior.tasks) !== hash(tasks)) throw new Error("Targeted rerun requires exactly the existing dataset")
    if (hash(prior.settings) !== hash(settings) || prior.concurrency !== concurrency || prior.judge_mode !== flags.judge) throw new Error("Targeted rerun settings, concurrency, or judge mode differ from the existing run")
    if (hash(prior.agent) !== hash(publicConfig(config.agent)) || hash(prior.judge) !== hash(publicConfig(config.judge))) throw new Error("Targeted rerun Agent or Judge configuration differs from the existing run")
    backfillMetadata = prior.backfill ?? null
    protectedTaskIds = new Set(backfillMetadata?.protected_task_ids ?? [])
    if (rerunIds.some(id => protectedTaskIds.has(id))) throw new Error("Targeted rerun cannot replace a protected pre-extension task")
    const existing = readRunResults(directory)
    if (rerunIds.some(id => !existing.some(result => result.task_id === id))) throw new Error("Targeted rerun requires an existing result for every selected task")
    const normalizeRequestIds = ids => tasks.filter(task => ids.includes(task.task_id)).map(task => task.task_id)
    const requestKey = hash(rerunIds)
    const latestRerun = flags["new-rerun"] ? null : prior.reruns?.findLast(item =>
      (item.request_key ?? hash(normalizeRequestIds(item.task_ids))) === requestKey
      && Array.isArray(item.previous_attempts))
    const sameRequest = !!latestRerun
    if (sameRequest) rerunMetadata = latestRerun
    else {
      rerunMetadata = {
        requested_at: new Date().toISOString(), task_ids: rerunIds,
        request_key: requestKey,
        prior_fingerprint: prior.fingerprint, replacement_fingerprint: fingerprint,
        previous_attempts: rerunIds.map(id => {
          const result = existing.find(row => row.task_id === id)
          return { task_id: id, attempt_number: result.attempt_number ?? 1, result_sha256: hash(result) }
        }),
        policy: "owner_requested; prior attempts preserved in the revision chain; recovery remains target-scoped",
      }
      writeJson(manifestPath, { ...prior, version: Math.max(prior.version ?? 2, 3), updated_at: new Date().toISOString(), reruns: [...(prior.reruns ?? []), rerunMetadata] })
    }
  } else if (flags["judge-only"]) {
    tasks = prior.tasks
    backfillMetadata = prior.backfill ?? null
    protectedTaskIds = new Set(backfillMetadata?.protected_task_ids ?? [])
    rerunMetadata = prior.reruns?.at(-1) ?? null
  }
  else if (prior.fingerprint !== fingerprint) throw new Error("Resume dataset/model/settings/code mismatch; use a new output directory")
} else {
  if (flags.resume || flags["judge-only"] || flags["backfill-missing"] || rerunIds.length) throw new Error("No run manifest to resume/judge/backfill/rerun")
  mkdirSync(directory, { recursive: true })
  if (imported.length) writeResultIndex(directory, redact(imported, [config.agent.apiKey, config.judge.apiKey]))
  writeJson(manifestPath, { version: 2, fingerprint, tasks, settings, concurrency, agent: publicConfig(config.agent), judge: publicConfig(config.judge), judge_mode: flags.judge, baseline, tools: "dsh-browser only", created_at: new Date().toISOString(), dataset_sha256: hash(tasks), runtime: { node: process.version, platform: process.platform }, pricing, pricing_source: pricing.agent?.source ?? null, pricing_date: pricing.agent?.date ?? null })
}
const resultsPath = join(directory, "results.ndjson")
if (!flags["judge-only"]) recoverAttemptResults(directory, rerunIds.length ? tasks.filter(task => rerunIds.includes(task.task_id)) : tasks, flags.judge)
let originals = existsSync(resultsPath) ? readLines(resultsPath) : []
if (flags["backfill-missing"] && originals.length) {
  originals = orderResults(originals, tasks)
  writeResultIndex(directory, originals)
}
const results = readRunResults(directory)
summarize(results, tasks) // reject duplicate/foreign records before spending tokens
function currentPlan() {
  if (rerunIds.length) {
    const byId = new Map(results.map(result => [result.task_id, result]))
    const previous = new Map(rerunMetadata.previous_attempts.map(item => [item.task_id, item]))
    return tasks.map(task => {
      if (!rerunIds.includes(task.task_id)) return { task_id: task.task_id, action: "skip", reason: "not_selected" }
      const result = byId.get(task.task_id)
      const before = previous.get(task.task_id)
      if (!result || (result.attempt_number ?? 1) <= before.attempt_number) return { task_id: task.task_id, action: "run", reason: "owner_requested_replacement", previous_attempt: before.attempt_number }
      const action = resumeAction(result, flags.judge)
      const reason = action === "run" ? executionFailure(result) || "interrupted_replacement" : action === "judge" ? result.judge_result?.infrastructure_error || "unjudged_replacement" : "replacement_finished"
      return { task_id: task.task_id, action, reason, previous_attempt: result.attempt_number ?? 1 }
    })
  }
  if (!flags["backfill-missing"]) return buildRecoveryPlan(tasks, results, flags.judge)
  const byId = new Map(results.map(result => [result.task_id, result]))
  return tasks.map(task => {
    if (protectedTaskIds.has(task.task_id)) return { task_id: task.task_id, action: "skip", reason: "existing_trajectory", previous_attempt: byId.get(task.task_id)?.attempt_number ?? 1 }
    const result = byId.get(task.task_id)
    const action = resumeAction(result, flags.judge)
    const reason = action === "run" ? executionFailure(result) || (result ? "interrupted" : "missing_trajectory") : action === "judge" ? result.judge_result?.infrastructure_error || "unjudged" : "finished"
    return { task_id: task.task_id, action, reason, previous_attempt: result ? result.attempt_number ?? 1 : null }
  })
}
function report() {
  const summary = { ...summarize(results, tasks), ...aggregateMetrics(results), ...measurementHealth(results, tasks.length), ...historicalCosts(directory), cost_basis: pricing.basis, pricing }
  const plan = currentPlan()
  const quotaRetries = plan.filter(item => item.action !== "skip" && item.reason === "quota_exhausted")
  summary.quota_retry_task_ids = quotaRetries.filter(item => item.action === "run").map(item => item.task_id)
  summary.quota_rejudge_task_ids = quotaRetries.filter(item => item.action === "judge").map(item => item.task_id)
  writeJson(join(directory, "recovery.json"), { updated_at: new Date().toISOString(), halted: haltReason, pending: plan.filter(item => item.action !== "skip"), policy: flags["backfill-missing"] ? "Run eval:backfill with --execute again after service recovery. Protected prior trajectories remain ineligible; unfinished backfill tasks retain dataset order." : rerunIds.length ? `Run the same --rerun-ids ${rerunIds.join(",")} command after service recovery. Only these owner-selected replacements are eligible; prior attempts remain preserved.` : "On --resume, retry quota-interrupted tasks first; rejudge only if execution completed. Probe availability before dispatch. No assumed reset time." })
  const selectedOrder = tasks.flatMap(task => results.filter(result => result.task_id === task.task_id))
  const table = taskTable(selectedOrder)
  writeJson(join(directory, "task-metrics.json"), taskRows(selectedOrder, tasks))
  for (const [name, text] of [["task-metrics.md", table.markdown], ["task-metrics.csv", table.csv]]) {
    writeFileSync(join(directory, `${name}.tmp`), text)
    renameSync(join(directory, `${name}.tmp`), join(directory, name))
  }
  writeJson(join(directory, "summary.json"), { ...summary, mixed_provenance: !!baseline || !!backfillMetadata || !!rerunMetadata, inherited_tasks: results.filter(r => r.inherited).length, protected_tasks: protectedTaskIds.size, judge_mode: flags.judge, judge: publicConfig(config.judge), interrupted, halted: haltReason })
  const pct = value => value === null ? "unknown" : `${(value * 100).toFixed(1)}%`
  const fmt = value => value === null ? "unknown" : value.toFixed(3)
  const text = ["# DSH Browser WebVoyager evaluation", "", `Attempted: ${summary.attempted}/${summary.total}; judged: ${summary.judged}; passed: ${summary.passed}; success rate: ${pct(summary.success_rate)}${summary.scoring_complete ? "" : " (incomplete; unresolved tasks remain)"}.`, "", `Average tool calls: ${fmt(summary.avg_steps)}; average agent duration: ${fmt(summary.avg_duration_s)} s; estimated agent cost: $${fmt(summary.avg_cost_usd)}/attempt. Judge cost is separate.`, "", "| Site | Tasks | Attempted | Passed | Success |", "| --- | ---: | ---: | ---: | ---: |", ...Object.entries(summary.per_site).map(([site, s]) => `| ${site} | ${s.total} | ${s.attempted} | ${s.passed} | ${pct(s.success_rate)} |`), "", `Judge: ${flags.judge}. Browser tools only. Cost is the USD list-price equivalent, not a Token Plan invoice. Reference: 80/109 (73.4%), 9.2 tool calls, 150 s, $0.0245/task. Tool availability and live website dates differ; do not treat this as a controlled replication.`, "", ...results.filter(r => r.judge_result?.confidence === "low" || r.judge_result?.pass === null).map(r => `- Review ${r.task_id}: ${r.judge_result?.reason}`), ""]
  if (haltReason || summary.infrastructure_errors) text.splice(2, 0, `Service failure / incomplete measurement: ${haltReason || `${summary.infrastructure_errors} infrastructure errors`}. Do not publish this as a clean benchmark score.`, "")
  if (baseline) text.splice(2, 0, "Mixed-provenance recovery: retained results come from a previous code/config snapshot. This is not a fresh controlled benchmark.", "")
  if (backfillMetadata) text.splice(2, 0, `Missing-task backfill: ${backfillMetadata.protected_task_ids.length} prior trajectories were protected from rerun; only the dataset extension was eligible to run. This is a mixed-provenance result.`, "")
  if (rerunMetadata) text.splice(2, 0, `Owner-requested targeted replacement: ${rerunMetadata.task_ids.join(", ")}. Prior attempts remain in the revision chain; tables show the latest attempt.`, "")
  text.push(`Observed agent cost subtotal: $${summary.observed_cost_usd.toFixed(6)}; unpriced calls: ${summary.unpriced_calls ?? "unknown"}. A subtotal is not the full bill. Lower-bound duration records: ${summary.duration_lower_bound_tasks}.`)
  text.push(`Superseded attempts: ${summary.superseded_attempts}; their observed agent cost: $${summary.superseded_agent_cost_observed.toFixed(6)}; prior judge cost subtotal: $${summary.superseded_judge_cost_observed.toFixed(6)}. These are additional to the current-result totals, not free retries.`)
  text.push("", "## 逐题统计", "", table.markdown)
  if (quotaRetries.length) text.push("", `额度恢复后待重测：${summary.quota_retry_task_ids.join(", ") || "无"}；仅需补评分：${summary.quota_rejudge_task_ids.join(", ") || "无"}。恢复时${flags["backfill-missing"] ? "重新执行 eval:backfill -- --out <RUN> --execute" : "使用相同参数及 --resume"}，清单见 recovery.json。`)
  writeFileSync(join(directory, "report.md.tmp"), text.join("\n"))
  renameSync(join(directory, "report.md.tmp"), join(directory, "report.md"))
}
function persistResult(result) {
  const safe = redact(result, [config.agent.apiKey, config.judge.apiKey])
  const index = results.findIndex(row => row.task_id === safe.task_id)
  if (index >= 0) {
    reviseResult(directory, results[index], safe, [config.agent.apiKey, config.judge.apiKey])
    results[index] = safe
  } else {
    originals = orderResults([...originals, safe], tasks)
    writeResultIndex(directory, originals)
    results.push(safe)
    const ordered = orderResults(results, tasks)
    results.splice(0, results.length, ...ordered)
  }
  report()
}
async function runChild(task, taskDir) {
  mkdirSync(taskDir, { recursive: true })
  const output = join(taskDir, "result.json")
  if (existsSync(output)) return readJson(output) // recover persisted result after parent interruption
  writeJson(join(taskDir, "task.json"), task)
  if (existsSync(join(taskDir, "trace.ndjson"))) throw new Error(`Interrupted attempt ${task.task_id} has a trace but no result; choose a new run instead of silently retrying`)
  return new Promise((resolveResult, reject) => {
    const env = { ...process.env, EVAL_PROVIDER: config.agent.provider, EVAL_MODEL: config.agent.model, EVAL_API_PROTOCOL: config.agent.protocol, EVAL_BASE_URL: config.agent.baseURL, EVAL_API_KEY: config.agent.apiKey, ...(config.agent.reasoningEffort ? { EVAL_REASONING_EFFORT: config.agent.reasoningEffort } : {}) }
    const child = spawn(process.execPath, [join(root, "scripts/eval/host.mjs"), join(taskDir, "task.json"), taskDir, JSON.stringify(settings)], { cwd: root, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    children.add(child)
    const began = Date.now()
    let deadline = false
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => appendJson(join(taskDir, "host-log.ndjson"), { text: chunk.toString() }, [config.agent.apiKey, config.judge.apiKey]))
    const timer = setTimeout(() => { deadline = true; stop(child) }, settings.timeout + 20000)
    child.on("error", error => { clearTimeout(timer); children.delete(child); reject(error) })
    child.on("close", code => {
      clearTimeout(timer)
      children.delete(child)
      if (existsSync(output)) return resolveResult(readJson(output))
      // Preserve observability from the append-only trace even when a child is killed.
      const tracePath = join(taskDir, "trace.ndjson")
      const trace = existsSync(tracePath) ? readLines(tracePath, { allowTrailingPartial: true }) : []
      const calls = trace.filter(t => t.type === "session/event" && t.event.type === "tool/call").map(t => ({ tool: t.event.data.name, input: t.event.data.arguments, status: "incomplete" }))
      const fallback = { task_id: task.task_id, website: task.website, task: task.confirmed_task, status: deadline ? "timeout" : "error", duration_ms: Date.now() - began, steps: calls.length, browser_steps: calls.filter(c => c.tool.startsWith("browser_")).length, tool_trace: calls, final_answer: "", cost: null, tokens: null, error: interrupted ? "Run interrupted" : `Worker exited ${code}${deadline ? " after deadline" : ""}`, model: config.agent.model, provider: config.agent.provider, protocol: config.agent.protocol, reasoning_effort: config.agent.reasoningEffort }
      const modelCalls = recoverCalls(trace)
      Object.assign(fallback, summarizeCalls(modelCalls), {
        started_at: new Date(began).toISOString(), finished_at: new Date().toISOString(),
        duration_basis: "dispatcher spawn to worker exit; may include cleanup",
        model_calls: modelCalls, model_rounds: modelCalls.length,
        model_steps: trace.filter(t => t.type === "session/event" && t.event.type === "step/start").length,
        retry_count: trace.filter(t => t.type === "session/event" && t.event.type === "llm/retry").length,
        error_kind: interrupted ? "dispatcher_interrupted" : "worker_exit",
      })
      if (!modelCalls.length) Object.assign(fallback, { cost: null, tokens: null, usage_metrics: tokenMetrics(null), unpriced_calls: null, usage_missing_calls: null })
      writeJson(output, fallback)
      resolveResult(fallback)
    })
  })
}
const queue = flags["judge-only"] ? judgeOnlyPlan(results, flags.judge) : currentPlan()
  .filter(item => item.action !== "skip")
  .map(item => ({ ...tasks.find(task => task.task_id === item.task_id), action: item.action }))
console.log(`Run: ${directory}; tasks=${tasks.length}; pending=${queue.length}; model=${config.agent.model}; reasoning=${config.agent.reasoningEffort ?? "default"}; concurrency=${concurrency}`)
report()
if (queue.length) {
  // Admission checks are logged outside task metrics. A depleted account must not burn through the dataset.
  const probes = flags["judge-only"] ? [config.judge] : [config.agent, ...(flags.judge !== "none" && (config.judge.model !== config.agent.model || config.judge.baseURL !== config.agent.baseURL || config.judge.apiKey !== config.agent.apiKey) ? [config.judge] : [])]
  for (const probe of probes) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await complete(probe, [{ role: "user", content: "Reply OK" }], { maxTokens: 128, signal: AbortSignal.timeout(settings.preflightTimeout) })
        const usage = normalizeUsage(response.usage)
        appendJson(join(directory, "preflight.ndjson"), { timestamp: new Date().toISOString(), model: probe.model, status: "connected", attempt, usage, cost: estimateCost(usage, probe.model, probe.pricing) }, [probe.apiKey])
        break
      } catch (error) {
        const reason = infrastructureFailure(error) || "provider_preflight_failed"
        appendJson(join(directory, "preflight.ndjson"), { timestamp: new Date().toISOString(), status: reason, attempt, error: error.message }, [probe.apiKey])
        if (attempt < 3 && reason === "provider_connection") {
          await new Promise(resolve => setTimeout(resolve, attempt * 1000))
          continue
        }
        haltReason = reason
        console.error(`Evaluation paused before task dispatch: ${haltReason}: ${error.message}`)
        break
      }
    }
    if (haltReason) break
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length && !interrupted && !haltReason) {
    const item = queue.shift()
    const previousIndex = results.findIndex(r => r.task_id === item.task_id)
    const previous = results[previousIndex]
    const attempt = item.action === "run" ? nextAttempt(directory, item.task_id, previous) : null
    const taskDir = attempt?.path ?? evidenceDirectory(directory, previous)
    console.log(`START ${item.task_id}`)
    let result = item.action === "judge" ? { ...previous } : { ...await runChild(item, taskDir), attempt_number: attempt.number, attempt_directory: attempt.relativePath }
    mkdirSync(taskDir, { recursive: true })
    result.judge_mode = flags.judge
    // Publish completed agent metrics before potentially slow or failing judgment.
    if (item.action === "run") {
      result.metrics = taskMetrics(result)
      persistResult(result)
    }
    if (flags.judge !== "none" && !interrupted) result.judge_result = await judgeResult(result, config.judge, flags.judge, taskDir, complete, result.inherited ? result.inherited_evidence_directory : taskDir)
    result.evaluation_finished_at = new Date().toISOString()
    result.metrics = taskMetrics(result)
    haltReason ||= resultHaltReason(result, item.action)
    persistResult(result)
    console.log(`DONE ${result.task_id} ${result.status} pass=${result.judge_result?.pass ?? "unjudged"} steps=${result.steps} seconds=${(result.duration_ms / 1000).toFixed(1)}`)
  }
}))
if (flags["judge-only"]) {
  // Separate judged view preserves original attempts and earlier judge outcomes.
  writeJson(join(directory, `judged-${flags.judge}.json`), { judge: publicConfig(config.judge), results })
}
report()
console.log(JSON.stringify(readJson(join(directory, "summary.json")), null, 2))
if (interrupted || haltReason || results.some(r => r.judge_result?.status === "judge_error")) process.exitCode = 1

import { spawn, execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { DEFAULT_PREFLIGHT_TIMEOUT_MS, appendJson, hash, readJson, readLines, summarize, validateTasks, writeJson, infrastructureFailure, measurementHealth, normalizeUsage, estimateCost, redact } from "./core.mjs"
import { readRunResults, reviseResult, nextAttempt, evidenceDirectory, historicalCosts, writeResultIndex } from "./state.mjs"
import { loadConfig, publicConfig, validateReasoningEffort } from "./config.mjs"
import { judgeResult } from "./judge.mjs"
import { complete } from "./provider.mjs"
import { DEFAULT_PRICING, aggregateMetrics, summarizeCalls, recoverCalls, taskMetrics, taskRows, taskTable, tokenMetrics } from "./metrics.mjs"
import { recoveryPlan as buildRecoveryPlan, executionFailure } from "./core.mjs"
import { recoverAttemptResults } from "./state.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const DEFAULT_TASK_TIMEOUT_MS = 600000
const DEFAULT_JUDGE_MODE = "reference"
const DEFAULT_HEADED = true
const { values: flags } = parseArgs({ options: {
  data: { type: "string", default: "assets/benchmark/webvoyager-109.json" },
  out: { type: "string" }, site: { type: "string" }, ids: { type: "string" }, count: { type: "string" },
  timeout: { type: "string", default: String(DEFAULT_TASK_TIMEOUT_MS) }, concurrency: { type: "string", default: "1" },
  "preflight-timeout": { type: "string", default: String(DEFAULT_PREFLIGHT_TIMEOUT_MS) },
  "max-rounds": { type: "string", default: "50" }, judge: { type: "string", default: DEFAULT_JUDGE_MODE },
  "reasoning-effort": { type: "string" },
  "retry-from": { type: "string" },
  resume: { type: "boolean" }, "judge-only": { type: "boolean" }, "dry-run": { type: "boolean" },
  headed: { type: "boolean" }, help: { type: "boolean" },
} })
if (flags.help) {
  console.log("Defaults: headed Chromium, 600000 ms per task, evidence judge. --resume retries service failures and rejudges unresolved completed answers. --retry-from OLD_RUN requires a new --out and preserves prior results with mixed provenance.")
  console.log("Usage: npm run eval -- [--out output/evals/NAME] [--site allrecipes|apple|amazon] [--ids Allrecipes--0,Apple--0,Amazon--0] [--count N] [--concurrency 1] [--timeout 600000] [--preflight-timeout 60000] [--max-rounds 50] [--reasoning-effort off|minimal|low|medium|high|xhigh|max] [--judge reference|evidence|none] [--resume] [--judge-only] [--dry-run] [--headed]\nReads the active DSH model/key/reasoning effort from settings and credential refs; optional EVAL_* environment overrides. MiniMax uses the DSH Anthropic protocol mapping. Every new run uses fresh per-task Chromium. Resume requires identical dataset/config/code. Judge-only reuses saved attempts without re-running browsers.")
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
if (flags["judge-only"] && flags.judge === "none") throw new Error("--judge-only requires reference or evidence grading")
if (flags["retry-from"] && (!flags.out || flags.resume || flags["judge-only"])) throw new Error("--retry-from requires a new --out and cannot combine with --resume/--judge-only")
let tasks = validateTasks(readJson(resolve(root, flags.data)))
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
  if (flags["retry-from"] || flags.resume) {
    const source = resolve(root, flags["retry-from"] || flags.out)
    if (hash(readJson(join(source, "manifest.json")).tasks) !== hash(tasks)) throw new Error("Recovery requires exactly the original selected tasks")
    const rows = readRunResults(source)
    summarize(rows, tasks)
    recoveryPlan = buildRecoveryPlan(tasks, rows, flags.judge)
  }
  console.log(JSON.stringify({ total: tasks.length, ids: tasks.map(t => t.task_id), settings, reasoning_effort: reasoningEffortOverride ?? "from DSH settings", judge: flags.judge, recovery_plan: recoveryPlan, note: "Read-only plan; no credentials loaded, provider request, or browser launch" }, null, 2))
  process.exit(0)
}
const config = loadConfig({ ...process.env, ...(reasoningEffortOverride ? { EVAL_REASONING_EFFORT: reasoningEffortOverride } : {}) })
const pricing = { currency: "USD", unit: "per million tokens", basis: "configured or historical list-price estimate, not an invoice", agent: config.agent.pricing ?? (config.agent.model === "MiniMax-M3" ? DEFAULT_PRICING : null), judge: config.judge.pricing ?? (config.judge.model === "MiniMax-M3" ? DEFAULT_PRICING : null) }
const directory = resolve(root, flags.out || `output/evals/${new Date().toISOString().replace(/[:.]/g, "-")}`)
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
if (flags["retry-from"]) {
  const source = resolve(root, flags["retry-from"])
  if (existsSync(directory)) throw new Error("--retry-from output must be a new directory")
  const original = readJson(join(source, "manifest.json"))
  if (hash(original.tasks) !== hash(tasks)) throw new Error("--retry-from requires exactly the original selected tasks")
  const inherited = readRunResults(source)
  summarize(inherited, tasks)
  // Carry provenance, not files; original sessions are read-only evidence inputs.
  imported = inherited.map(result => ({ ...result, inherited: true, inherited_evidence_directory: result.inherited ? result.inherited_evidence_directory : evidenceDirectory(source, result) }))
  baseline = { source, fingerprint: original.fingerprint, results_sha256: hash(inherited), mixed_provenance: true }
}
if (existsSync(manifestPath)) {
  if (!flags.resume && !flags["judge-only"]) throw new Error("Output run already exists; use --resume or choose another --out")
  const prior = readJson(manifestPath)
  baseline = prior.baseline ?? null
  if (flags["judge-only"]) tasks = prior.tasks
  else if (prior.fingerprint !== fingerprint) throw new Error("Resume dataset/model/settings/code mismatch; use a new output directory")
} else {
  if (flags.resume || flags["judge-only"]) throw new Error("No run manifest to resume/judge")
  mkdirSync(directory, { recursive: true })
  if (imported.length) writeResultIndex(directory, redact(imported, [config.agent.apiKey, config.judge.apiKey]))
  writeJson(manifestPath, { version: 2, fingerprint, tasks, settings, concurrency, agent: publicConfig(config.agent), judge: publicConfig(config.judge), judge_mode: flags.judge, baseline, tools: "dsh-browser only", created_at: new Date().toISOString(), dataset_sha256: hash(tasks), runtime: { node: process.version, platform: process.platform }, pricing, pricing_source: pricing.agent?.source ?? null, pricing_date: pricing.agent?.date ?? null })
}
const resultsPath = join(directory, "results.ndjson")
if (!flags["judge-only"]) recoverAttemptResults(directory, tasks, flags.judge)
const originals = existsSync(resultsPath) ? readLines(resultsPath) : []
const results = readRunResults(directory)
summarize(results, tasks) // reject duplicate/foreign records before spending tokens
function report() {
  const summary = { ...summarize(results, tasks), ...aggregateMetrics(results), ...measurementHealth(results, tasks.length), ...historicalCosts(directory), cost_basis: pricing.basis, pricing }
  const plan = buildRecoveryPlan(tasks, results, flags.judge)
  const quotaRetries = plan.filter(item => item.action !== "skip" && item.reason === "quota_exhausted")
  summary.quota_retry_task_ids = quotaRetries.filter(item => item.action === "run").map(item => item.task_id)
  summary.quota_rejudge_task_ids = quotaRetries.filter(item => item.action === "judge").map(item => item.task_id)
  writeJson(join(directory, "recovery.json"), { updated_at: new Date().toISOString(), halted: haltReason, pending: plan.filter(item => item.action !== "skip"), policy: "On --resume, retry quota-interrupted tasks first; rejudge only if execution completed. Probe availability before dispatch. No assumed reset time." })
  const selectedOrder = tasks.flatMap(task => results.filter(result => result.task_id === task.task_id))
  const table = taskTable(selectedOrder)
  writeJson(join(directory, "task-metrics.json"), taskRows(selectedOrder, tasks))
  for (const [name, text] of [["task-metrics.md", table.markdown], ["task-metrics.csv", table.csv]]) {
    writeFileSync(join(directory, `${name}.tmp`), text)
    renameSync(join(directory, `${name}.tmp`), join(directory, name))
  }
  writeJson(join(directory, "summary.json"), { ...summary, mixed_provenance: !!baseline, inherited_tasks: results.filter(r => r.inherited).length, judge_mode: flags.judge, judge: publicConfig(config.judge), interrupted, halted: haltReason })
  const pct = value => value === null ? "unknown" : `${(value * 100).toFixed(1)}%`
  const fmt = value => value === null ? "unknown" : value.toFixed(3)
  const text = ["# DSH Browser WebVoyager evaluation", "", `Attempted: ${summary.attempted}/${summary.total}; judged: ${summary.judged}; passed: ${summary.passed}; success rate: ${pct(summary.success_rate)}${summary.scoring_complete ? "" : " (incomplete; unresolved tasks remain)"}.`, "", `Average tool calls: ${fmt(summary.avg_steps)}; average agent duration: ${fmt(summary.avg_duration_s)} s; estimated agent cost: $${fmt(summary.avg_cost_usd)}/attempt. Judge cost is separate.`, "", "| Site | Tasks | Attempted | Passed | Success |", "| --- | ---: | ---: | ---: | ---: |", ...Object.entries(summary.per_site).map(([site, s]) => `| ${site} | ${s.total} | ${s.attempted} | ${s.passed} | ${pct(s.success_rate)} |`), "", `Judge: ${flags.judge}. Browser tools only. Cost is the USD list-price equivalent, not a Token Plan invoice. Reference: 80/109 (73.4%), 9.2 tool calls, 150 s, $0.0245/task. Tool availability and live website dates differ; do not treat this as a controlled replication.`, "", ...results.filter(r => r.judge_result?.confidence === "low" || r.judge_result?.pass === null).map(r => `- Review ${r.task_id}: ${r.judge_result?.reason}`), ""]
  if (haltReason || summary.infrastructure_errors) text.splice(2, 0, `Service failure / incomplete measurement: ${haltReason || `${summary.infrastructure_errors} infrastructure errors`}. Do not publish this as a clean benchmark score.`, "")
  if (baseline) text.splice(2, 0, "Mixed-provenance recovery: retained results come from a previous code/config snapshot. This is not a fresh controlled benchmark.", "")
  text.push(`Observed agent cost subtotal: $${summary.observed_cost_usd.toFixed(6)}; unpriced calls: ${summary.unpriced_calls ?? "unknown"}. A subtotal is not the full bill. Lower-bound duration records: ${summary.duration_lower_bound_tasks}.`)
  text.push(`Superseded attempts: ${summary.superseded_attempts}; their observed agent cost: $${summary.superseded_agent_cost_observed.toFixed(6)}; prior judge cost subtotal: $${summary.superseded_judge_cost_observed.toFixed(6)}. These are additional to the current-result totals, not free retries.`)
  text.push("", "## 逐题统计", "", table.markdown)
  if (quotaRetries.length) text.push("", `额度恢复后待重测：${summary.quota_retry_task_ids.join(", ") || "无"}；仅需补评分：${summary.quota_rejudge_task_ids.join(", ") || "无"}。恢复时使用相同参数及 --resume，清单见 recovery.json。`)
  writeFileSync(join(directory, "report.md"), text.join("\n"))
}
function persistResult(result) {
  const safe = redact(result, [config.agent.apiKey, config.judge.apiKey])
  const index = results.findIndex(row => row.task_id === safe.task_id)
  if (index >= 0) {
    reviseResult(directory, results[index], safe, [config.agent.apiKey, config.judge.apiKey])
    results[index] = safe
  } else { writeResultIndex(directory, [...originals, safe]); originals.push(safe); results.push(safe) }
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
const queue = flags["judge-only"] ? results.map(result => ({ task_id: result.task_id, action: "judge" })) : buildRecoveryPlan(tasks, results, flags.judge)
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
    haltReason ||= executionFailure(result) || result.judge_result?.infrastructure_error
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

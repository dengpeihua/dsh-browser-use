import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { hash, readJson, readLines, writeJson } from "./core.mjs"
import { readRunResults } from "./state.mjs"
import { acquireRunLock } from "./backfill.mjs"
import { taskMetrics } from "./metrics.mjs"

const aggregateNames = new Set(["summary.json", "report.md", "task-metrics.json", "task-metrics.csv", "task-metrics.md", "recovery.json"])

function assertInside(directory, target) {
  const rel = relative(resolve(directory), resolve(target))
  if (!rel || rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Judge reset target must stay inside the run directory")
}

function stripJudge(result) {
  const { judge_result: _judgeResult, judge_mode: _judgeMode, evaluation_finished_at: _evaluationFinishedAt, metrics: _metrics, ...agentResult } = result
  return { ...agentResult, metrics: taskMetrics(agentResult) }
}

function judgeLogs(directory) {
  const found = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Judge reset refuses symlink: ${path}`)
      if (entry.isDirectory()) {
        if (!/^\.judge-reset-/.test(entry.name)) visit(path)
      } else if (/^judge-(?:evidence|reference)\.ndjson$/.test(entry.name)) found.push(path)
    }
  }
  visit(directory)
  return found
}

function aggregateFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && (aggregateNames.has(entry.name) || /^judged-(?:evidence|reference)\.json$/.test(entry.name)))
    .map(entry => join(directory, entry.name))
}

export function planJudgeReset(directory) {
  directory = resolve(directory)
  for (const name of ["manifest.json", "results.ndjson"]) if (!existsSync(join(directory, name))) throw new Error(`Missing ${name} in judge reset target`)
  const results = readRunResults(directory)
  const manifest = readJson(join(directory, "manifest.json"))
  if (!Array.isArray(manifest.tasks) || results.length !== manifest.tasks.length) throw new Error("Judge reset requires one current result for every manifest task")
  return { directory, results: results.length, judge_logs: judgeLogs(directory), aggregates: aggregateFiles(directory), revisions: existsSync(join(directory, "result-revisions")) ? readdirSync(join(directory, "result-revisions")).filter(name => /^\d{8}\.json$/.test(name)).length : 0 }
}

export function resetJudgeArtifacts(directory) {
  const plan = planJudgeReset(directory)
  directory = plan.directory
  const resultsPath = join(directory, "results.ndjson")
  const manifestPath = join(directory, "manifest.json")
  const revisionsPath = join(directory, "result-revisions")
  const raw = readLines(resultsPath)
  const revisionFiles = existsSync(revisionsPath) ? readdirSync(revisionsPath).filter(name => /^\d{8}\.json$/.test(name)).sort() : []
  const originalById = new Map(raw.map(result => [result.task_id, result]))
  const cleanBase = raw.map(stripJudge)
  const cleanById = new Map(cleanBase.map(result => [result.task_id, result]))
  const rebuilt = []

  for (const file of revisionFiles) {
    const revision = readJson(join(revisionsPath, file))
    const prior = originalById.get(revision.result.task_id)
    if (!prior || hash(prior) !== revision.previous) throw new Error(`Broken result revision chain: ${file}`)
    originalById.set(revision.result.task_id, revision.result)
    const clean = stripJudge(revision.result)
    const cleanPrior = cleanById.get(clean.task_id)
    if (hash(cleanPrior) !== hash(clean)) rebuilt.push({ previous: hash(cleanPrior), result: clean })
    cleanById.set(clean.task_id, clean)
  }

  const timestamp = new Date().toISOString()
  const manifest = readJson(manifestPath)
  const cleanManifest = { ...manifest, judge_mode: "reference", updated_at: timestamp, judge_reset: { at: timestamp, removed_prior_judge_content: true, target_rubric: "opencode-browser-856867996e73f7dcc5e39827bf2af7555bd63d40-judge-prompt.md" } }
  const stage = join(directory, `.judge-reset-${process.pid}`)
  const backups = { results: `${resultsPath}.judge-reset-backup`, manifest: `${manifestPath}.judge-reset-backup`, revisions: `${revisionsPath}.judge-reset-backup` }
  for (const target of [stage, ...Object.values(backups)]) {
    assertInside(directory, target)
    if (existsSync(target)) throw new Error(`Judge reset staging path already exists: ${target}`)
  }

  mkdirSync(stage)
  writeFileSync(join(stage, "results.ndjson"), cleanBase.map(result => JSON.stringify(result)).join("\n") + "\n")
  writeJson(join(stage, "manifest.json"), cleanManifest)
  if (rebuilt.length) {
    mkdirSync(join(stage, "result-revisions"))
    rebuilt.forEach((revision, index) => writeJson(join(stage, "result-revisions", `${String(index + 1).padStart(8, "0")}.json`), revision))
  }

  const moved = { results: false, manifest: false, revisions: false }
  const installed = { results: false, manifest: false, revisions: false }
  try {
    renameSync(resultsPath, backups.results); moved.results = true
    renameSync(manifestPath, backups.manifest); moved.manifest = true
    if (existsSync(revisionsPath)) { renameSync(revisionsPath, backups.revisions); moved.revisions = true }
    renameSync(join(stage, "results.ndjson"), resultsPath); installed.results = true
    renameSync(join(stage, "manifest.json"), manifestPath); installed.manifest = true
    if (existsSync(join(stage, "result-revisions"))) { renameSync(join(stage, "result-revisions"), revisionsPath); installed.revisions = true }
  } catch (error) {
    if (installed.results && existsSync(resultsPath)) rmSync(resultsPath)
    if (installed.manifest && existsSync(manifestPath)) rmSync(manifestPath)
    if (installed.revisions && existsSync(revisionsPath)) rmSync(revisionsPath, { recursive: true })
    if (moved.results && existsSync(backups.results)) renameSync(backups.results, resultsPath)
    if (moved.manifest && existsSync(backups.manifest)) renameSync(backups.manifest, manifestPath)
    if (moved.revisions && existsSync(backups.revisions)) renameSync(backups.revisions, revisionsPath)
    throw error
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true })
  }
  rmSync(backups.results)
  rmSync(backups.manifest)
  if (existsSync(backups.revisions)) rmSync(backups.revisions, { recursive: true })

  for (const target of [...plan.judge_logs, ...plan.aggregates]) {
    assertInside(directory, target)
    rmSync(target)
  }
  return { results: plan.results, revisions_before: plan.revisions, revisions_after: rebuilt.length, judge_logs_removed: plan.judge_logs.length, aggregates_removed: plan.aggregates.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" }, execute: { type: "boolean" }, help: { type: "boolean" } } })
  if (values.help || !values.out) {
    console.log("Usage: node scripts/eval/reset-judge.mjs --out output/evals/RUN [--execute]")
    process.exit(values.help ? 0 : 1)
  }
  const directory = resolve(values.out)
  const plan = planJudgeReset(directory)
  if (!values.execute) console.log(JSON.stringify({ ...plan, judge_logs: plan.judge_logs.map(path => relative(directory, path)), aggregates: plan.aggregates.map(path => relative(directory, path)), note: "Read-only plan; add --execute to remove prior Judge content" }, null, 2))
  else {
    const release = acquireRunLock(directory)
    try { console.log(JSON.stringify(resetJudgeArtifacts(directory), null, 2)) } finally { release() }
  }
}

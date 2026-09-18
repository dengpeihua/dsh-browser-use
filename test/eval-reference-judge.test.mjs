import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import test from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeResult } from "../scripts/eval/judge.mjs"
import { hash, judgeOnlyPlan, readJson, resultHaltReason, writeJson } from "../scripts/eval/core.mjs"
import { readRunResults, writeResultIndex } from "../scripts/eval/state.mjs"
import { resetJudgeArtifacts } from "../scripts/eval/reset-judge.mjs"

const promptPath = new URL("../assets/benchmark/judge-prompt.md", import.meta.url)
const promptSha256 = "bcdf403484823037eaeb6cec7918b966fe90ee31a30bc8d69094d2ff42747ccf"
const config = { model: "fixture", apiKey: "fixture" }
const task = {
  task_id: "Allrecipes--0",
  website: "https://www.allrecipes.com/",
  task: "Find a vegetarian lasagna recipe",
  status: "error",
  error: "Browser closed after the answer was found",
  final_answer: "Vegetarian lasagna with 4.6 stars",
  tool_trace: [{ tool: "browser_start", input: { url: "https://www.allrecipes.com/" } }],
  judge_mode: "evidence",
  judge_result: { pass: false, reason: "old evidence judgment" },
}
const response = content => ({
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
})

test("judge-only resumes only unresolved grading and ignores historical agent failures", () => {
  const results = [
    { task_id: "done", status: "completed", judge_mode: "reference", judge_result: { pass: false } },
    { task_id: "missing", status: "timeout" },
    { task_id: "broken", status: "error", infrastructure_error: "provider_connection", judge_mode: "reference", judge_result: { pass: true } },
    { task_id: "old-rubric", status: "completed", judge_mode: "evidence", judge_result: { pass: true } },
  ]
  assert.deepEqual(judgeOnlyPlan(results, "reference"), [
    { task_id: "missing", action: "judge" },
    { task_id: "old-rubric", action: "judge" },
  ])
  assert.equal(resultHaltReason(results[2], "judge"), null)
  assert.equal(resultHaltReason({ ...results[1], judge_result: { pass: null, infrastructure_error: "quota_exhausted" } }, "judge"), "quota_exhausted")
  assert.equal(resultHaltReason(results[2], "run"), "provider_connection")
})

test("vendored judge-prompt.md is byte-identical to the pinned opencode-browser source", () => {
  const prompt = readFileSync(promptPath)
  assert.equal(createHash("sha256").update(prompt).digest("hex"), promptSha256)
})

test("reference judge follows judge-prompt.md conflict rule and evaluates error results with valid answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-prompt-judge-"))
  try {
    const calls = []
    const judged = await judgeResult(task, config, "reference", directory, async (_config, messages, options) => {
      calls.push({ messages, options })
      return response('```json\n[{"task_id":"Allrecipes--0","pass":true,"reason":"The answer supplies a vegetarian lasagna recipe and its 4.6-star rating."}]\n```')
    })
    assert.equal(calls.length, 1)
    assert.equal(createHash("sha256").update(calls[0].messages[0].content).digest("hex"), promptSha256)
    assert.equal(calls[0].messages[0].role, "system")
    assert.equal(calls[0].messages[1].role, "user")
    assert.match(calls[0].messages[1].content, /WebVoyager_data\.json/)
    assert.match(calls[0].messages[1].content, /results\.ndjson/)
    assert.match(calls[0].messages[1].content, /Browser closed after the answer was found/)
    assert.doesNotMatch(calls[0].messages[1].content, /old evidence judgment|judge_result|judge_mode/)
    assert.ok(calls[0].options.signal instanceof AbortSignal)
    assert.equal(judged.pass, true)
    assert.equal(judged.reason, "The answer supplies a vegetarian lasagna recipe and its 4.6-star rating.")
    assert.equal("confidence" in judged, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("reference judge asks the LLM to grade every result and rejects non-array or mismatched output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-prompt-format-"))
  try {
    let calls = 0
    const empty = { ...task, status: "timeout", final_answer: "", error: "timeout" }
    const malformed = await judgeResult(empty, config, "reference", directory, async () => {
      calls++
      return response('{"task_id":"Allrecipes--0","pass":false,"reason":"No answer"}')
    })
    assert.equal(calls, 1)
    assert.equal(malformed.pass, null)
    assert.equal(malformed.status, "judge_error")

    const wrongTask = await judgeResult(empty, config, "reference", directory, async () => {
      calls++
      return response('[{"task_id":"Apple--0","pass":false,"reason":"No answer"}]')
    })
    assert.equal(calls, 2)
    assert.equal(wrongTask.pass, null)
    assert.equal(wrongTask.status, "judge_error")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("judge reset removes only prior judge content and preserves the latest agent attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-judge-reset-"))
  try {
    const oldMetrics = { metrics_version: 1, agent_cost_usd: 0.5, judge_cost_usd: 0.1, total_cost_usd: 0.6, judge_duration_ms: 1000 }
    const original = { task_id: "a", status: "completed", final_answer: "first", attempt_number: 1, attempt_directory: "a", cost: 0.5, duration_ms: 2000, metrics: oldMetrics, evaluation_finished_at: "old-judge-time", judge_mode: "evidence", judge_result: { pass: true, reason: "old" } }
    const replacement = { ...original, final_answer: "second", attempt_number: 2, attempt_directory: join("a", "attempts", "2"), judge_result: { pass: false, reason: "old replacement" } }
    writeResultIndex(directory, [original])
    mkdirSync(join(directory, "result-revisions"))
    writeJson(join(directory, "result-revisions", "00000001.json"), { previous: hash(original), result: replacement })
    writeJson(join(directory, "manifest.json"), { version: 3, judge_mode: "evidence", tasks: [{ task_id: "a", confirmed_task: "answer", website: "https://example.com" }] })
    mkdirSync(join(directory, "a", "attempts", "2"), { recursive: true })
    writeFileSync(join(directory, "a", "session.json"), "[]")
    writeFileSync(join(directory, "a", "judge-evidence.ndjson"), "old judge trace\n")
    writeFileSync(join(directory, "a", "attempts", "2", "judge-reference.ndjson"), "old judge trace\n")
    for (const file of ["summary.json", "report.md", "task-metrics.json", "task-metrics.csv", "task-metrics.md", "recovery.json", "judged-evidence.json"]) writeFileSync(join(directory, file), "old judge aggregate\n")

    const reset = resetJudgeArtifacts(directory)
    assert.equal(reset.results, 1)
    assert.equal(reset.judge_logs_removed, 2)
    const current = readRunResults(directory)
    assert.equal(current[0].final_answer, "second")
    assert.equal(current[0].attempt_number, 2)
    assert.equal("judge_result" in current[0], false)
    assert.equal("judge_mode" in current[0], false)
    assert.equal("evaluation_finished_at" in current[0], false)
    assert.equal(current[0].metrics.agent_cost_usd, 0.5)
    assert.equal(current[0].metrics.judge_cost_usd, null)
    assert.equal(current[0].metrics.judge_duration_ms, null)
    assert.equal(readdirSync(join(directory, "result-revisions")).length, 1)
    assert.equal(existsSync(join(directory, "a", "session.json")), true)
    assert.equal(existsSync(join(directory, "a", "judge-evidence.ndjson")), false)
    assert.equal(existsSync(join(directory, "summary.json")), false)
    assert.equal(readJson(join(directory, "manifest.json")).judge_mode, "reference")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

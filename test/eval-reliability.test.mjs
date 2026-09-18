import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeResult } from "../scripts/eval/judge.mjs"
import * as core from "../scripts/eval/core.mjs"
import { readRunResults, reviseResult, nextAttempt, evidenceDirectory } from "../scripts/eval/state.mjs"
import * as state from "../scripts/eval/state.mjs"

const completed = { task_id: "a", status: "completed", task: "Find the release date and price", website: "https://example.com", final_answer: "New model, September 18, $1199", tool_trace: [] }
const event = (seq, text) => ({ type: "tool/result", seq, time: 1, data: { meta: { status: "success", title: "Observe page", browserContext: { observation: { url: "https://example.com", capturedAt: "2026-09-15", fullOutput: text } } }, message: { content: [{ type: "tool-result", isError: false, content: [{ type: "text", text }] }] } } })
const response = content => ({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
const config = { model: "MiniMax-M3", apiKey: "fixture" }

test("resume retries provider failures, rejudges unresolved answers, and retains real task failures", () => {
  assert.equal(core.resumeAction({ status: "error", infrastructure_error: "quota_exhausted" }), "run")
  assert.equal(core.resumeAction({ status: "error", error: "Model transport error: fetch failed" }), "run")
  assert.equal(core.resumeAction({ status: "error", error_kind: "dispatcher_interrupted" }), "run")
  assert.equal(core.resumeAction({ ...completed, judge_result: { pass: null, status: "judge_error" } }), "judge")
  assert.equal(core.resumeAction({ ...completed, judge_result: { pass: false } }), "skip")
  assert.equal(core.resumeAction({ status: "timeout", judge_result: { pass: false } }), "skip")
  assert.equal(core.resumeAction(undefined), "run")
})

test("quota recovery includes masked timeout errors and prioritizes interrupted tasks over untouched tasks", () => {
  const results = [
    { task_id: "b", status: "timeout", error: "timeout", model_calls: [{ errorKind: "quota_exhausted" }], judge_result: { pass: false } },
    { ...completed, task_id: "c", judge_result: { pass: false, infrastructure_error: "quota_exhausted" } },
    { ...completed, task_id: "d", judge_result: { pass: true } },
  ]
  assert.equal(core.resumeAction(results[0]), "run")
  assert.equal(core.resumeAction(results[1]), "judge")
  assert.deepEqual(core.recoveryPlan(["a", "b", "c", "d"].map(task_id => ({ task_id })), results).map(item => [item.task_id, item.action]), [["b", "run"], ["c", "judge"], ["a", "run"], ["d", "skip"]])
  assert.equal(core.resumeAction({ ...completed, model_calls: [{ errorKind: "quota_exhausted" }, { status: "success" }], judge_result: { pass: true } }), "skip")
})

test("an orphan quota result is registered and can be retried during the same resume", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-orphan-quota-"))
  try {
    mkdirSync(join(directory, "a"))
    const failed = { task_id: "a", status: "error", infrastructure_error: "quota_exhausted" }
    core.writeJson(join(directory, "a", "result.json"), failed)
    const recovered = state.recoverAttemptResults(directory, [{ task_id: "a" }], "none")
    assert.equal(recovered[0].attempt_number, 1)
    assert.equal(core.resumeAction(recovered[0], "none"), "run")
    assert.equal(nextAttempt(directory, "a", recovered[0]).number, 2)
    assert.deepEqual(core.readJson(join(directory, "a", "result.json")), failed)
    assert.deepEqual(state.recoverAttemptResults(directory, [{ task_id: "a" }], "none"), recovered)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("quota-interrupted execution remains unjudged until it is rerun", async () => {
  const result = await judgeResult({ task_id: "a", status: "error", infrastructure_error: "quota_exhausted" }, {}, "evidence", "unused", () => { throw new Error("must not call") })
  assert.equal(result.pass, null)
  assert.equal(result.status, "pending_retry")
  assert.equal(result.cost, 0)
})

test("evidence judge sees browser evidence and one schema repair is bounded and accounted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-judge-repair-"))
  try {
    writeFileSync(join(directory, "session.json"), JSON.stringify([event(85, "New model. Available September 18. From $1199.")]))
    const prompts = []
    const result = await judgeResult(completed, config, "evidence", directory, async () => response('{}'))
    assert.equal(result.pass, null)
    const repaired = await judgeResult(completed, config, "evidence", directory, async (_config, messages) => {
      prompts.push(JSON.stringify(messages))
      return response(prompts.length === 1 ? '{"pass":true,"reason":"observed","confidence": high}' : '{"pass":true,"reason":"observed","confidence":"high","evidence_seqs":[85]}')
    })
    assert.equal(prompts.length, 2)
    assert.match(prompts[0], /Available September 18/)
    assert.match(prompts[0], /training|prior knowledge/i)
    assert.equal(repaired.pass, true)
    assert.equal(repaired.requests, 2)
    assert.equal(repaired.tokens.input, 20)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("revision replay is durable, preserves originals, recovers orphan results and rejects escaping paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-state-"))
  try {
    const failed = { task_id: "a", status: "error", infrastructure_error: "quota_exhausted" }
    writeFileSync(join(directory, "results.ndjson"), JSON.stringify(failed) + "\n")
    const retry = { ...completed, attempt_number: 2, attempt_directory: "a/attempts/2" }
    const pending = nextAttempt(directory, "a", failed)
    assert.equal(pending.number, 2)
    mkdirSync(pending.path, { recursive: true })
    core.writeJson(join(pending.path, "result.json"), retry)
    assert.equal(nextAttempt(directory, "a", failed).number, 2)
    reviseResult(directory, failed, retry)
    assert.deepEqual(readRunResults(directory), [retry])
    assert.deepEqual(core.readLines(join(directory, "results.ndjson")), [failed])
    assert.throws(() => evidenceDirectory(directory, { attempt_directory: "../outside" }), /inside/)
    const interrupted = nextAttempt(directory, "a", retry)
    mkdirSync(interrupted.path, { recursive: true })
    writeFileSync(join(interrupted.path, "trace.ndjson"), "partial")
    assert.equal(nextAttempt(directory, "a", retry).number, 4)
    reviseResult(directory, failed, completed)
    assert.throws(() => readRunResults(directory), /revision chain/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("fabricated evidence citations cannot establish success and quota errors are not format-retried", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-judge-citations-"))
  try {
    writeFileSync(join(directory, "session.json"), JSON.stringify([event(8, "page evidence")]))
    let calls = 0
    const invalid = await judgeResult(completed, config, "evidence", directory, async () => {
      calls++
      return response('{"pass":true,"reason":"found","confidence":"high","evidence_seqs":[999]}')
    })
    assert.equal(invalid.pass, null)
    assert.equal(calls, 2)
    calls = 0
    const quota = await judgeResult(completed, config, "evidence", directory, async () => { calls++; throw new Error("Model HTTP 429: Token Plan 用量上限 (2056)") })
    assert.equal(calls, 1)
    assert.equal(quota.infrastructure_error, "quota_exhausted")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("evidence projection includes late observations and labels truncation instead of discarding the tail", () => {
  const evidence = core.judgeEvidence([event(1, "x".repeat(150000)), event(99, "late price $1199")])
  assert.ok(evidence.text.length <= 120000)
  assert.match(evidence.text, /late price/)
  assert.equal(evidence.truncated, true)
  assert.deepEqual(evidence.seqs, [1, 99])
})

test("a passing judgment cannot cite only failed browser observations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-judge-failed-evidence-"))
  try {
    const failed = event(8, "Postcondition failed; item not saved")
    failed.data.meta.status = "error"
    writeFileSync(join(directory, "session.json"), JSON.stringify([failed]))
    const result = await judgeResult(completed, config, "evidence", directory, async () => response('{"pass":true,"reason":"saved","confidence":"high","evidence_seqs":[8]}'))
    assert.equal(result.pass, null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("result index commits atomically and keeps every existing original attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-index-"))
  try {
    state.writeResultIndex(directory, [completed])
    writeFileSync(join(directory, "results.ndjson.tmp"), "interrupted partial write")
    assert.deepEqual(readRunResults(directory), [completed])
    state.writeResultIndex(directory, [completed, { ...completed, task_id: "b" }])
    assert.deepEqual(readRunResults(directory).map(r => r.task_id), ["a", "b"])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

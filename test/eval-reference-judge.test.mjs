import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgePrompt, judgeResult } from "../scripts/eval/judge.mjs"

const config = { model: "fixture", apiKey: "fixture" }
const task = {
  task_id: "Allrecipes--0",
  website: "https://www.allrecipes.com/",
  task: "Find a vegetarian lasagna recipe",
  status: "completed",
  final_answer: "Vegetarian lasagna with 4.6 stars",
  tool_trace: [{ tool: "browser_start", input: { url: "https://www.allrecipes.com/" } }],
}
const response = content => ({
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
})

test("reference judge prompt is the exact executable opencode-browser judge.ts rubric", () => {
  assert.equal(judgePrompt(task, "reference"), `You are evaluating whether an AI agent successfully completed a web browsing task.

## Task
Website: https://www.allrecipes.com/
Instruction: Find a vegetarian lasagna recipe

## Agent's Tool Usage (summary)
- browser_start({"url":"https://www.allrecipes.com/"})

## Agent's Final Answer
Vegetarian lasagna with 4.6 stars

## Evaluation Criteria
Judge whether the agent's final answer satisfactorily addresses the task requirements.
- The answer must contain the specific information requested.
- Minor formatting differences are acceptable.
- If the task asks for a recipe with certain criteria, the answer must reference a recipe that plausibly meets those criteria.
- If the task asks to "find" something, the agent must have found and reported it.

## Response Format
Respond with EXACTLY one JSON object (no markdown, no extra text):
{"pass": true/false, "reason": "brief explanation", "confidence": "high/medium/low"}`)
})

test("reference judge uses no browser evidence, sends one upstream prompt, and preserves upstream parsing defaults", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-reference-judge-"))
  try {
    const calls = []
    const result = await judgeResult(task, config, "reference", directory, async (_config, messages, options) => {
      calls.push({ messages, options })
      return response('prefix {"pass":1} suffix')
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].messages, [{ role: "user", content: judgePrompt(task, "reference") }])
    assert.ok(calls[0].options.signal instanceof AbortSignal)
    assert.equal(result.pass, true)
    assert.equal(result.reason, "")
    assert.equal(result.confidence, "medium")
    assert.equal("evidence_seqs" in result, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("reference judge reproduces upstream deterministic failures and unparseable-response failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-reference-failure-"))
  try {
    let calls = 0
    const timeout = await judgeResult({ ...task, status: "timeout" }, config, "reference", directory, async () => { calls++; return response("unused") })
    assert.equal(calls, 0)
    assert.deepEqual({ pass: timeout.pass, reason: timeout.reason, confidence: timeout.confidence }, { pass: false, reason: "Task timed out", confidence: "high" })

    const malformed = await judgeResult(task, config, "reference", directory, async () => { calls++; return response("not json") })
    assert.equal(calls, 1)
    assert.deepEqual({ pass: malformed.pass, reason: malformed.reason, confidence: malformed.confidence }, { pass: false, reason: "Judge response not parseable", confidence: "low" })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


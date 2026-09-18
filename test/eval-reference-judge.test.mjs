import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import test from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeResult } from "../scripts/eval/judge.mjs"

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
      return response('[{"task_id":"Allrecipes--0","pass":true,"reason":"The answer supplies a vegetarian lasagna recipe and its 4.6-star rating."}]')
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


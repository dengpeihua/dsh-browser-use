import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { resolve } from "node:path"
import { LlmError } from "@deepseek-ai/dsh-llm"
import { runHost } from "./host.mjs"
import { judgeResult } from "./judge.mjs"
import { readLines } from "./core.mjs"

const server = createServer((_req, response) => response.end('<title>Evaluation fixture</title><h1>Evaluation fixture ready</h1><svg width="64" height="32" aria-label="chart"><rect width="64" height="32" fill="navy"/></svg>'))
server.listen(0, "127.0.0.1")
await once(server, "listening")
const url = `http://127.0.0.1:${server.address().port}`
const task = { task_id: "fixture-0", website: url, confirmed_task: "Open the fixture page and report its heading" }
const directory = resolve(`output/eval-smoke/${Date.now()}`)
const config = { provider: "fixture", model: "fixture", apiKey: "not-a-key" }
let attempt = 0, round = 0
const request = async (_config, messages, options) => {
  attempt++
  if (attempt === 1) throw new LlmError("Model HTTP 429: rate limited", "RATE_LIMIT", { status: 429, providerRetryAfterMs: 1 })
  round++
  assert.ok(options.tools.some(t => t.name === "browser_start"))
  const views = [...JSON.stringify(messages).matchAll(/\[view:([^\]]+)\]/g)].map(m => m[1]).filter(id => id !== "ID")
  const action = round === 1 ? ["browser_start", { url }] : round === 2 ? ["browser_view_elements", { viewIds: [views.at(-1)] }] : null
  if (!action) assert.match(JSON.stringify(messages), /Evaluation fixture ready/)
  if (!action) assert.ok(messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image_url")))
  return { usage: { prompt_tokens: 20, completion_tokens: 5 }, choices: [{ finish_reason: action ? "tool_calls" : "stop", message: action ? { role: "assistant", content: null, tool_calls: [{ id: `fixture-${round}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: "assistant", content: "Evaluation fixture ready" } }] }
}
try {
  const result = await runHost(task, directory, { maxRounds: 8, timeout: 30000 }, config, request)
  assert.equal(result.status, "completed", JSON.stringify(result))
  assert.equal(result.infrastructure_error, null)
  assert.equal(result.steps, 2)
  assert.equal(result.model_rounds, 4)
  assert.equal(result.request_count, 4)
  assert.equal(result.retry_count, 1)
  assert.equal(result.model_steps, 3)
  assert.equal(result.usage_missing_calls, 1)
  assert.equal(result.tokens, null)
  assert.equal(result.tokens_observed.input, 60)
  assert.equal(result.tokens_observed.output, 15)
  assert.ok(Date.parse(result.finished_at) >= Date.parse(result.started_at))
  assert.equal(result.duration_ms, Date.parse(result.finished_at) - Date.parse(result.started_at))
  assert.ok(result.tool_trace.every(t => t.status === "success"))
  assert.equal(result.final_answer, "Evaluation fixture ready")
  assert.equal(result.final_screenshot, "final.png")
  assert.ok(readLines(`${directory}/trace.ndjson`).some(t => t.type === "session/event" && t.event.type === "llm/retry"))
  assert.ok(readLines(`${directory}/trace.ndjson`).some(t => t.type === "session/event" && t.event.type === "tool/result"))
  const imageEvent = readLines(`${directory}/trace.ndjson`).find(t => t.type === "session/event" && t.event.type === "tool/result" && t.event.data.message.content[0].content.some(b => b.type === "image"))
  const ref = imageEvent.event.data.message.content[0].content.find(b => b.type === "image").attachment
  assert.ok(ref.width > 0 && ref.height > 0)
  const observation = readLines(`${directory}/trace.ndjson`).find(t => t.type === "session/event" && t.event.type === "tool/result" && t.event.data.meta?.browserContext?.observation && t.event.data.meta.status !== "error")
  assert.ok(observation, "Fixture must produce a browser observation for the judge")
  const judged = await judgeResult(result, config, "reference", directory, async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify([{ task_id: result.task_id, pass: true, reason: "Fixture heading matches" }]) } }] }))
  assert.equal(judged.pass, true)
  const timeout = await runHost({ ...task, task_id: "fixture-timeout" }, `${directory}/timeout`, { maxRounds: 8, timeout: 250 }, config, async (_c, _m, { signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  }))
  assert.equal(timeout.status, "timeout")
  assert.equal(timeout.usage_missing_calls, 1)
  assert.ok(timeout.finished_at)
  console.log(JSON.stringify({ status: "passed", fixture_only: true, browser: "real Chromium + real DSH AgentLoop", model_and_judge: "scripted", trace: true, screenshot: true, cancellation: true, directory }))
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }

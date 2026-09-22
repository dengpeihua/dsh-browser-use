import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_PREFLIGHT_TIMEOUT_MS, hash, normalizeUsage, estimateCost, parseJudgment, summarize, validateTasks, redact, readJson, infrastructureFailure, measurementHealth, imageDimensions, readLines } from "../scripts/eval/core.mjs"
import { createServer } from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { LlmError } from "@deepseek-ai/dsh-llm"
import { loadConfig, publicConfig, validateReasoningEffort } from "../scripts/eval/config.mjs"
import { complete, wireMessages } from "../scripts/eval/provider.mjs"
import { responsesRequest, normalizeResponses } from "../scripts/eval/responses.mjs"
import { judgeResult } from "../scripts/eval/judge.mjs"
import { readRunResults } from "../scripts/eval/state.mjs"

const tasks = ["a", "b", "c"].map(task_id => ({ task_id, confirmed_task: "Find a recipe", website: "https://example.com" }))
test("preflight allows a slow reasoning endpoint more than the old 15 second deadline", () => {
  assert.ok(DEFAULT_PREFLIGHT_TIMEOUT_MS >= 60000)
})
test("pinned benchmark contains all 126 tasks and preserves the published 109-task reference subset", () => {
  const selected = validateTasks(readJson(new URL("../assets/benchmark/webvoyager-126.json", import.meta.url)))
  const ref = readJson(new URL("../assets/benchmark/reference.json", import.meta.url))
  const referenceTasks = ref.task_ids.map(id => selected.find(task => task.task_id === id))
  assert.equal(hash(referenceTasks), ref.subset_sha256)
  assert.equal(selected.length, 126)
  assert.deepEqual(Object.fromEntries([...new Set(selected.map(task => new URL(task.website).hostname))].map(site => [site, selected.filter(task => new URL(task.website).hostname === site).length])), { "www.allrecipes.com": 45, "www.amazon.com": 39, "www.apple.com": 42 })
  assert.deepEqual(Object.fromEntries(Object.entries(ref.per_site).map(([k, v]) => [k, v.total])), { "www.allrecipes.com": 35, "www.amazon.com": 39, "www.apple.com": 35 })
  assert.equal((ref.success_rate * 100).toFixed(1), "73.4")
})
test("failure, timeout and unjudged tasks remain in the selected denominator", () => {
  const rows = [
    { task_id: "a", status: "completed", steps: 2, browser_steps: 2, duration_ms: 1000, cost: 0.2, judge_result: { pass: true, cost: 0.01 } },
    { task_id: "b", status: "timeout", steps: 4, browser_steps: 3, duration_ms: 3000, cost: null, judge_result: { pass: false, cost: 0 } },
  ]
  const result = summarize(rows, tasks)
  assert.equal(result.success_rate, 1 / 3)
  assert.equal(result.missing, 1)
  assert.equal(result.scoring_complete, false)
  assert.equal(result.avg_steps, 3)
  assert.equal(result.avg_duration_s, 2)
  assert.equal(result.avg_cost_usd, null)
  assert.throws(() => summarize([...rows, rows[0]], tasks), /duplicate/)
})
test("evidence judge schema parser never coerces string false to true", () => {
  assert.throws(() => parseJudgment('{"pass":"false","reason":"bad","confidence":"high"}'))
  assert.throws(() => parseJudgment('{"pass":true}'))
  assert.equal(parseJudgment('```json\n{"pass":false,"reason":"missing requirement","confidence":"high"}\n```').pass, false)
})
test("cache input is disjoint, unknown usage/cost stays unknown, reasoning is not billed twice", () => {
  const usage = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 50 } })
  assert.deepEqual(usage, { input: 200, cache_read: 800, cache_write: 0, output: 100, reasoning: 50 })
  assert.equal(estimateCost(usage, "MiniMax-M3"), (200 * 0.3 + 800 * 0.06 + 100 * 1.2) / 1e6)
  assert.equal(normalizeUsage(undefined), null)
  assert.equal(estimateCost(null, "MiniMax-M3"), null)
  assert.equal(estimateCost(usage, "other"), null)
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 30 }), null)
})
test("dataset rejects path traversal, duplicate identities and non-web URLs", () => {
  assert.throws(() => validateTasks([{ ...tasks[0], task_id: "../secret" }]))
  assert.throws(() => validateTasks([tasks[0], tasks[0]]))
  assert.throws(() => validateTasks([{ ...tasks[0], website: "file:///private" }]))
})
test("DSH credential refs resolve without exporting keys to manifests or trace", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-config-"))
  try {
    writeFileSync(join(directory, "settings.yaml"), "llm-pi-ai:\n  providers:\n    minimax-cn:\n      apiKeyEnv: LOCAL_TEST_KEY\nagent-default-model:\n  provider: minimax-cn\n  model: MiniMax-M3\n  reasoningEffort: high\n")
    writeFileSync(join(directory, ".credentials.yaml"), "refs:\n  LOCAL_TEST_KEY: dummy-secret-for-test\n")
    const config = loadConfig({ DSH_HOME: directory })
    assert.equal(config.agent.apiKey, "dummy-secret-for-test")
    assert.equal(config.agent.protocol, "anthropic-messages")
    assert.equal(config.agent.baseURL, "https://api.minimaxi.com/anthropic")
    assert.equal(config.agent.reasoningEffort, "high")
    assert.deepEqual(publicConfig(config.agent), {
      provider: "minimax-cn", model: "MiniMax-M3", protocol: "anthropic-messages",
      baseURL: "https://api.minimaxi.com/anthropic", reasoningEffort: "high",
      modelMaxTokens: 512000, contextWindow: 512000, maxTokens: 8192, temperature: 1,
    })
    assert.equal(JSON.stringify(publicConfig(config.agent)).includes("dummy-secret"), false)
    assert.deepEqual(redact({ apiKey: "abc", nested: "dummy-secret-for-test" }, [config.agent.apiKey]), { apiKey: "[REDACTED]", nested: "[REDACTED]" })
    assert.throws(() => loadConfig({ DSH_HOME: directory, EVAL_BASE_URL: "https://user:pass@example.com/v1" }))
    assert.throws(() => loadConfig({ DSH_HOME: directory, EVAL_REASONING_EFFORT: "extreme" }), /reasoning effort/i)
    assert.equal(validateReasoningEffort("high"), "high")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test("MiniMax honors configured model capacity when allocating the High thinking budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-minimax-"))
  let body
  const server = createServer((request, response) => {
    let text = ""
    request.on("data", chunk => { text += chunk })
    request.on("end", () => {
      body = JSON.parse(text)
      assert.equal(request.url, "/anthropic/v1/messages")
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const settings = { "llm-pi-ai": { providers: { "minimax-cn": { apiKeyEnv: "MINIMAX_TOKEN_PLAN_API_KEY", api: "anthropic-messages", baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, models: [{ id: "MiniMax-M3", maxTokens: 32768 }] } } }, "agent-default-model": { provider: "minimax-cn", model: "MiniMax-M3", reasoningEffort: "high" } }
    writeFileSync(join(directory, "settings.yaml"), JSON.stringify(settings))
    const config = loadConfig({ DSH_HOME: directory, MINIMAX_TOKEN_PLAN_API_KEY: "test-only-key" })
    await complete(config.agent, [{ role: "user", content: "Reply OK" }])
    assert.equal(body.model, "MiniMax-M3")
    assert.equal(body.max_tokens, 24576)
    assert.equal(body.thinking.budget_tokens, 16384)
    assert.equal(config.judge.modelMaxTokens, 32768)
    settings["llm-pi-ai"].providers["minimax-cn"].models[0].maxTokens = -1
    writeFileSync(join(directory, "settings.yaml"), JSON.stringify(settings))
    assert.throws(() => loadConfig({ DSH_HOME: directory, MINIMAX_TOKEN_PLAN_API_KEY: "test-only-key" }), /model maxTokens/)
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }) }
})

test("evaluation CLI reports the benchmark defaults and an explicit reasoning effort", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--dry-run", "--reasoning-effort", "high"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => { stdout += chunk })
  child.stderr.on("data", chunk => { stderr += chunk })
  const [code] = await once(child, "close")
  assert.equal(code, 0, stderr)
  const plan = JSON.parse(stdout)
  assert.equal(plan.reasoning_effort, "high")
  assert.deepEqual(plan.settings, { timeout: 600000, preflightTimeout: 60000, maxRounds: 50, headed: true })
  assert.equal(plan.judge, "reference")
})

test("Responses preserves encrypted reasoning, tool IDs and image input across a tool round", async () => {
  const native = [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque-reasoning", summary: [] }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: '{"value":"test"}', status: "completed" }]
  const normalized = normalizeResponses({ status: "completed", model: "gpt-6-astra", output: native, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } } })
  assert.deepEqual(normalizeUsage(normalized.usage), { input: 40, output: 20, cache_read: 60, cache_write: 0, reasoning: 10 })
  const projected = wireMessages({ messages: [{ role: "assistant", source: { replayState: { response: { responses_output: native } } }, content: [{ type: "tool-call", id: "call_1", name: "echo", arguments: '{"value":"test"}' }] }, { role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "echo-result" }] }] }] })
  projected.push({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,fixture" } }] })
  const config = { model: "gpt-6-astra", reasoningEffort: "high", maxTokens: 8192 }
  const request = responsesRequest(config, projected, [], 8192)
  assert.deepEqual(request.input.slice(0, 2), native)
  assert.deepEqual(request.input[2], { type: "function_call_output", call_id: "call_1", output: "echo-result" })
  assert.equal(request.input[3].content[0].type, "input_image")
  assert.equal(request.store, false)
  assert.equal(request.reasoning.effort, "high")
  assert.equal(request.max_output_tokens, 8192)
  assert.equal("max_output_tokens" in responsesRequest({ ...config, supportsMaxOutputTokens: false }, projected, [], 8192), false)
  let seen
  const server = createServer((req, res) => {
    let text = ""
    req.on("data", chunk => { text += chunk })
    req.on("end", () => { seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(text) }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "completed", model: "gpt-6-astra", output: [{ type: "message", content: [{ type: "output_text", text: "echo-result" }] }] })) })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const answer = await complete({ ...config, protocol: "openai-responses", baseURL: `http://127.0.0.1:${server.address().port}/codex/v1`, apiKey: "fixture-key" }, projected)
    assert.equal(answer.choices[0].message.content, "echo-result")
    assert.equal(seen.url, "/codex/v1/responses")
    assert.equal(seen.auth, "Bearer fixture-key")
    assert.equal(seen.body.input[0].encrypted_content, "opaque-reasoning")
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})

test("Responses reports truncation and rejects failed or empty output instead of claiming success", () => {
  assert.equal(normalizeResponses({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }).choices[0].finish_reason, "length")
  for (const data of [{ status: "failed", output: [] }, { status: "completed", error: { message: "failure" }, output: [] }, { status: "completed", output: [] }, { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }]) assert.throws(() => normalizeResponses(data))
  assert.throws(() => normalizeResponses({ status: "completed", output: [] }), error => infrastructureFailure(error) === "provider_connection")
  assert.throws(() => normalizeResponses({ error: { code: "insufficient_quota" } }), error => infrastructureFailure(error) === "quota_exhausted")
})
test("wire projection preserves MiniMax reasoning replay and tool call/result pairing", () => {
  const messages = wireMessages({ messages: [
    { role: "assistant", source: { replayState: { response: { reasoning_details: [{ text: "reason" }] } } }, content: [{ type: "tool-call", id: "call1", name: "browser_start", arguments: "{}" }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "call1", content: [{ type: "text", text: "ok" }] }] },
  ] })
  assert.deepEqual(messages[0].reasoning_details, [{ text: "reason" }])
  assert.equal(messages[0].tool_calls[0].id, messages[1].tool_call_id)
})
test("provider exposes HTTP 429 as a retryable structured model failure", async () => {
  const server = createServer((request, response) => {
    request.resume()
    response.statusCode = 429
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Retry-After", "2")
    response.end(JSON.stringify({ error: { message: "您的账户已达到速率限制，请您控制请求频率" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const config = { provider: "fixture", model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: "dummy-test-key", maxTokens: 128, temperature: 1 }
    await assert.rejects(complete(config, [{ role: "user", content: "test" }]), error => {
      assert.equal(error.code, "RATE_LIMIT")
      assert.equal(error.failure.status, 429)
      assert.equal(error.failure.providerRetryAfterMs, 2000)
      return true
    })
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})

test("quota error codes without messages and HTTP 200 error bodies are not short-loop rate retries", async () => {
  let status = 429, body = { error: { code: 2056 } }
  const server = createServer((request, response) => {
    request.resume()
    response.statusCode = status
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(body))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const config = { model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture" }
    for (const fixture of [
      [429, { error: { code: 2056 } }],
      [429, { base_resp: { status_code: 2056 } }],
      [200, { base_resp: { status_code: 2056, status_msg: "Token Plan limit exceeded" } }],
      [200, { error: { code: "insufficient_quota" } }],
    ]) {
      status = fixture[0]
      body = fixture[1]
      for (const protocol of ["openai-completions", "anthropic-messages", "openai-responses"]) {
        await assert.rejects(complete({ ...config, protocol }, [{ role: "user", content: "fixture" }]), error => error.code === "QUOTA" && infrastructureFailure(error) === "quota_exhausted")
      }
    }
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})
test("provider exposes a caller deadline as a structured timeout failure", async () => {
  const server = createServer(request => request.resume())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const config = { provider: "fixture", model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: "dummy-test-key", maxTokens: 128, temperature: 1 }
    await assert.rejects(complete(config, [{ role: "user", content: "test" }], { signal: AbortSignal.timeout(10) }), error => {
      assert.equal(error.code, "TIMEOUT")
      assert.equal(infrastructureFailure(error), "provider_connection")
      return true
    })
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})
test("MiniMax-M3 high uses the DSH Anthropic thinking budget and preserves replay blocks", async () => {
  let received
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      received = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        id: "msg-1", type: "message", role: "assistant", model: "MiniMax-M3", stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "inspect", signature: "signed-thinking" },
          { type: "tool_use", id: "call-1", name: "browser_start", input: {} },
        ],
        usage: { input_tokens: 5, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } },
      }))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const config = { provider: "minimax-cn", model: "MiniMax-M3", protocol: "anthropic-messages", baseURL: `http://127.0.0.1:${server.address().port}`, apiKey: "dummy-test-key", reasoningEffort: "high", modelMaxTokens: 512000, maxTokens: 8192, temperature: 1 }
    const data = await complete(config, [{ role: "system", content: "system" }, { role: "user", content: "start" }], { tools: [{ name: "browser_start", description: "Start", parameters: { type: "object", properties: {} } }] })
    assert.equal(received.url, "/v1/messages")
    assert.equal(received.headers["x-api-key"], "dummy-test-key")
    assert.deepEqual(received.body.thinking, { type: "enabled", budget_tokens: 16384 })
    assert.equal(received.body.max_tokens, 24576)
    assert.equal("temperature" in received.body, false)
    assert.deepEqual(received.body.tools[0], { name: "browser_start", description: "Start", input_schema: { type: "object", properties: {} } })
    assert.equal(data.choices[0].finish_reason, "tool_calls")
    assert.equal(data.choices[0].message.reasoning_content, "inspect")
    assert.equal(data.choices[0].message.tool_calls[0].function.name, "browser_start")
    assert.deepEqual(normalizeUsage(data.usage), { input: 5, cache_read: 0, cache_write: 0, output: 7, reasoning: 3 })
    const replay = wireMessages({ messages: [{ role: "assistant", source: { replayState: { response: { anthropic_content: data.choices[0].message.anthropic_content } } }, content: [{ type: "tool-call", id: "call-1", name: "browser_start", arguments: "{}" }] }] })
    assert.equal(replay[0].anthropic_content[0].signature, "signed-thinking")
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})
test("reference judge grades runtime failures and enforces judge-prompt array output", async () => {
  let calls = 0
  const request = async () => { calls++; return { choices: [{ finish_reason: "stop", message: { content: calls === 1 ? '[{"task_id":"a","pass":false,"reason":"No answer was produced."}]' : '{"task_id":"a","pass":false,"reason":"Wrong output shape."}' } }] } }
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-judge-"))
  try {
    const failed = await judgeResult({ task_id: "a", status: "timeout" }, {}, "reference", directory, request)
    assert.equal(calls, 1)
    assert.equal(failed.pass, false)
    const malformed = await judgeResult({ task_id: "a", status: "completed", final_answer: "answer", tool_trace: [] }, {}, "reference", directory, request)
    assert.equal(calls, 2)
    assert.equal(malformed.pass, null)
    assert.equal(malformed.status, "judge_error")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test("images are delivered only after all sibling tool responses, preserving function-call protocol", () => {
  const image = { type: "image", attachment: { attachmentId: "image1" } }
  const messages = wireMessages({ messages: [
    { role: "assistant", content: ["a", "b"].map(id => ({ type: "tool-call", id, name: "browser_view_elements", arguments: "{}" })) },
    { role: "user", content: [{ type: "tool-result", toolCallId: "a", content: [image] }] },
    { role: "user", content: [{ type: "tool-result", toolCallId: "b", content: [{ type: "text", text: "second result" }] }] },
  ] }, new Map([["image1", { mediaType: "image/png", data: Buffer.from("fixture") }]]))
  assert.deepEqual(messages.map(m => m.role), ["assistant", "tool", "tool", "user"])
  assert.equal(messages[3].content[0].type, "image_url")
})
test("screenshot dimensions are decoded from JPEG/PNG headers and corrupt headers fail", () => {
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,32,0,64,1,1,17,0,255,217])
  assert.deepEqual(imageDimensions(jpeg, "image/jpeg"), { width: 64, height: 32 })
  const png = Buffer.alloc(24)
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png)
  png.writeUInt32BE(128, 16); png.writeUInt32BE(96, 20)
  assert.deepEqual(imageDimensions(png, "image/png"), { width: 128, height: 96 })
  assert.throws(() => imageDimensions(Buffer.from([255,216,255]), "image/jpeg"))
})
test("infrastructure failures are separated from task failures and observed cost is not a total", () => {
  assert.equal(infrastructureFailure("Model HTTP 429: Token Plan 用量上限 (2056)"), "quota_exhausted")
  assert.equal(infrastructureFailure("Model HTTP 401"), "provider_authentication")
  assert.equal(infrastructureFailure(new LlmError("Model request timed out", "TIMEOUT")), "provider_connection")
  assert.equal(infrastructureFailure("element not found"), null)
  const health = measurementHealth([{ infrastructure_error: "quota_exhausted", cost: null, cost_observed: 0.1, unpriced_calls: 1, judge_result: { pass: false } }], 3)
  assert.equal(health.complete_without_infrastructure_errors, false)
  assert.equal(health.observed_cost_usd, 0.1)
  assert.equal(health.unpriced_calls, 1)
})
test("truncated trace recovery keeps a valid prefix but never hides corrupt interior records", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-trace-"))
  try {
    const path = join(directory, "trace.ndjson")
    writeFileSync(path, '{"a":1}\n{"b":')
    assert.deepEqual(readLines(path, { allowTrailingPartial: true }), [{ a: 1 }])
    assert.throws(() => readLines(path))
    writeFileSync(path, '{"a":\n{"b":2}\n')
    assert.throws(() => readLines(path, { allowTrailingPartial: true }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test("missing evidence becomes unresolved judgment instead of aborting the whole batch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-evidence-"))
  try {
    const result = await judgeResult({ task_id: "a", status: "completed", final_answer: "x", tool_trace: [] }, {}, "evidence", directory, () => { throw new Error("must not call model") })
    assert.equal(result.status, "judge_error")
    assert.equal(result.pass, null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test("quota circuit breaker prevents dataset-wide false failures, both before and during dispatch", async () => {
  let requests = 0, failPreflight = false, recovered = false
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    if (failPreflight || (!recovered && requests > 1)) { response.statusCode = 429; response.end(JSON.stringify({ error: { message: "Token Plan 用量上限 (2056)" } })); return }
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-quota-"))
  const run = (output, extra = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--count", "3", "--out", output, "--concurrency", "1", ...extra], {
      env: { ...process.env, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_JUDGE_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: `http://127.0.0.1:${server.address().port}`, EVAL_JUDGE_BASE_URL: `http://127.0.0.1:${server.address().port}`, EVAL_API_KEY: "dummy-test-key", EVAL_JUDGE_API_KEY: "dummy-test-key", EVAL_REASONING_EFFORT: "high" }, windowsHide: true, stdio: "ignore",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })
  try {
    const midrun = join(directory, "midrun")
    assert.equal(await run(midrun), 1)
    const summary = readJson(join(midrun, "summary.json"))
    assert.equal(summary.attempted, 1)
    assert.equal(summary.missing, 2)
    assert.equal(summary.halted, "quota_exhausted")
    assert.equal(requests, 3)
    const manifest = readJson(join(midrun, "manifest.json"))
    assert.equal(manifest.agent.reasoningEffort, "high")
    assert.equal(manifest.agent.protocol, "openai-completions")
    const session = readJson(join(midrun, manifest.tasks[0].task_id, "session.json"))
    assert.equal(session.find(event => event.type === "request/header").data.header.config.reasoningEffort, "high")
    failPreflight = true
    const before = join(directory, "before")
    assert.equal(await run(before), 1)
    assert.equal(readJson(join(before, "summary.json")).attempted, 0)
    assert.equal(existsSync(join(before, "results.ndjson")), false)
    failPreflight = false
    recovered = true
    const originalHash = hash(readLines(join(midrun, "results.ndjson")))
    const migrated = join(directory, "migrated")
    await run(migrated, ["--retry-from", midrun])
    assert.equal(existsSync(join(migrated, "summary.json")), true)
    assert.equal(readJson(join(migrated, "summary.json")).completed, 3)
    assert.equal(hash(readLines(join(midrun, "results.ndjson"))), originalHash)
    // Recovered provider returns plain answers without launching any browser.
    await run(midrun, ["--resume"])
    const resumed = readJson(join(midrun, "summary.json"))
    assert.equal(resumed.infrastructure_errors, 0)
    assert.equal(resumed.completed, 3)
    assert.equal(readJson(join(midrun, manifest.tasks[0].task_id, "result.json")).infrastructure_error, "quota_exhausted")
    assert.equal(readJson(join(midrun, manifest.tasks[0].task_id, "attempts", "2", "result.json")).status, "completed")
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }) }
})

test("resume reruns the quota-failed task, skips previous successes and keeps the pending ledger while blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-quota-resume-"))
  const output = join(directory, "run")
  let phase = "initial", requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    if (phase === "blocked" || (phase === "initial" && requests === 3)) {
      response.statusCode = 429
      response.end(JSON.stringify({ error: { code: 2056 } }))
    } else response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fixture answer" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const run = async (extra = []) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--count", "3", "--out", output, "--judge", "none", ...extra], {
      env: { ...process.env, DSH_HOME: directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_JUDGE_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: `http://127.0.0.1:${server.address().port}`, EVAL_API_KEY: "fixture" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", text => { stdout += text })
    child.stderr.on("data", text => { stderr += text })
    const [code] = await once(child, "close")
    return { code, stdout, stderr }
  }
  try {
    assert.equal((await run()).code, 1)
    assert.equal(requests, 3)
    const original = hash(readLines(join(output, "results.ndjson")))
    assert.deepEqual(readJson(join(output, "summary.json")).quota_retry_task_ids, ["Allrecipes--1"])
    assert.equal(readJson(join(output, "recovery.json")).pending[0].task_id, "Allrecipes--1")
    phase = "blocked"
    const dry = await run(["--resume", "--dry-run"])
    assert.equal(dry.code, 0, dry.stderr)
    assert.equal(requests, 3)
    assert.equal(JSON.parse(dry.stdout).recovery_plan[0].reason, "quota_exhausted")
    assert.equal((await run(["--resume"])).code, 1)
    assert.equal(requests, 4)
    assert.equal(readJson(join(output, "summary.json")).attempted, 2)
    assert.equal(hash(readLines(join(output, "results.ndjson"))), original)
    assert.equal(existsSync(join(output, "Allrecipes--1", "attempts", "2", "result.json")), false)
    phase = "recovered"
    const resumed = await run(["--resume"])
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.equal(requests, 7) // admission + failed task + untouched task; successful task is skipped
    const results = readRunResults(output)
    assert.deepEqual(results.map(result => [result.task_id, result.attempt_number, result.status]), [["Allrecipes--0", 1, "completed"], ["Allrecipes--1", 2, "completed"], ["Allrecipes--2", 1, "completed"]])
    assert.deepEqual(readJson(join(output, "recovery.json")).pending, [])
    assert.equal(readJson(join(output, "Allrecipes--1", "result.json")).infrastructure_error, "quota_exhausted")
    assert.equal(readJson(join(output, "summary.json")).superseded_attempts, 1)
    assert.equal(readJson(join(output, "task-metrics.json")).filter(row => row.task_id === "Allrecipes--1").length, 1)
    assert.equal((await run(["--resume"])).code, 0)
    assert.equal(requests, 7)
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(directory, { recursive: true, force: true }) }
})

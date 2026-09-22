import assert from "node:assert/strict"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { orderResults, planBackfill } from "../scripts/eval/backfill.mjs"
import { readRunResults, reviseResult } from "../scripts/eval/state.mjs"

const tasks = [0, 1, 2].map(index => ({
  task_id: `Allrecipes--${index}`,
  confirmed_task: `Task ${index}`,
  website: "https://www.allrecipes.com/",
}))

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}

function writeTrajectory(directory, task, result) {
  const target = join(directory, task.task_id)
  mkdirSync(target, { recursive: true })
  writeJson(join(target, "task.json"), { ...task, action: "run" })
  writeJson(join(target, "session.json"), [{ type: "tool/result", seq: 1 }])
  writeFileSync(join(target, "trace.ndjson"), JSON.stringify({ type: "session/event", event: { type: "step/start" } }) + "\n")
  writeJson(join(target, "result.json"), result)
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-backfill-"))
  const manifest = {
    version: 2,
    tasks: [tasks[0], tasks[2]],
    settings: { timeout: 600000, preflightTimeout: 60000, maxRounds: 50, headed: true },
    concurrency: 1,
    judge_mode: "none",
  }
  const results = [tasks[0], tasks[2]].map(task => ({ task_id: task.task_id, status: "completed", duration_ms: 1000, steps: 1, browser_steps: 1, final_answer: "done", tool_trace: [] }))
  writeJson(join(directory, "manifest.json"), manifest)
  writeFileSync(join(directory, "results.ndjson"), results.map(JSON.stringify).join("\n") + "\n")
  for (let index = 0; index < manifest.tasks.length; index++) writeTrajectory(directory, manifest.tasks[index], results[index])
  return { directory, manifest, results }
}

test("backfill protects existing trajectories and schedules only missing IDs in dataset order", () => {
  const data = fixture()
  try {
    const plan = planBackfill({ ...data, tasks })
    assert.deepEqual(plan.protected_task_ids, ["Allrecipes--0", "Allrecipes--2"])
    assert.deepEqual(plan.missing_task_ids, ["Allrecipes--1"])
    assert.deepEqual(plan.pending.map(row => [row.task_id, row.dataset_index, row.action]), [["Allrecipes--1", 1, "run"]])
    assert.deepEqual(orderResults([data.results[1], { task_id: "Allrecipes--1" }, data.results[0]], tasks).map(row => row.task_id), tasks.map(task => task.task_id))
  } finally { rmSync(data.directory, { recursive: true, force: true }) }
})

test("backfill refuses changed tasks and incomplete protected trajectories", () => {
  const changed = fixture()
  try {
    const target = tasks.map(task => task.task_id === "Allrecipes--0" ? { ...task, confirmed_task: "Changed" } : task)
    assert.throws(() => planBackfill({ ...changed, tasks: target }), /differs from the target dataset/)
  } finally { rmSync(changed.directory, { recursive: true, force: true }) }

  const incomplete = fixture()
  try {
    unlinkSync(join(incomplete.directory, "Allrecipes--0", "trace.ndjson"))
    assert.throws(() => planBackfill({ ...incomplete, tasks }), /missing trace.ndjson/)
  } finally { rmSync(incomplete.directory, { recursive: true, force: true }) }

  const malformed = fixture()
  try {
    writeJson(join(malformed.directory, "Allrecipes--0", "result.json"), { task_id: "Allrecipes--0" })
    assert.throws(() => planBackfill({ ...malformed, tasks }), /invalid result status/)
  } finally { rmSync(malformed.directory, { recursive: true, force: true }) }

  const inconsistent = fixture()
  try {
    const saved = JSON.parse(readFileSync(join(inconsistent.directory, "Allrecipes--0", "result.json"), "utf8"))
    writeJson(join(inconsistent.directory, "Allrecipes--0", "result.json"), { ...saved, steps: 2 })
    assert.throws(() => planBackfill({ ...inconsistent, tasks }), /disagrees with the result index on steps/)
  } finally { rmSync(inconsistent.directory, { recursive: true, force: true }) }
})

test("backfill CLI plan is read-only and lists the exact missing task", async () => {
  const data = fixture()
  const dataset = join(data.directory, "dataset.json")
  writeJson(dataset, tasks)
  const beforeManifest = readFileSync(join(data.directory, "manifest.json"), "utf8")
  const beforeResults = readFileSync(join(data.directory, "results.ndjson"), "utf8")
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/backfill-missing.mjs", import.meta.url)), "--out", data.directory, "--data", dataset], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const [code] = await once(child, "close")
    assert.equal(code, 0, stderr)
    const plan = JSON.parse(stdout)
    assert.equal(plan.total, 3)
    assert.equal(plan.backfill.protected, 2)
    assert.deepEqual(plan.backfill.missing_task_ids, ["Allrecipes--1"])
    assert.equal(plan.recovery_plan.find(row => row.task_id === "Allrecipes--0").action, "skip")
    assert.equal(plan.recovery_plan.find(row => row.task_id === "Allrecipes--1").action, "run")
    assert.equal(readFileSync(join(data.directory, "manifest.json"), "utf8"), beforeManifest)
    assert.equal(readFileSync(join(data.directory, "results.ndjson"), "utf8"), beforeResults)
  } finally { rmSync(data.directory, { recursive: true, force: true }) }
})

test("backfill execution runs only the missing task and writes every index in dataset order", async () => {
  const data = fixture()
  const dataset = join(data.directory, "dataset.json")
  writeJson(dataset, tasks)
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fixture answer" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const publicConfig = { provider: "fixture", model: "fixture", protocol: "openai-completions", baseURL, modelMaxTokens: 8192, contextWindow: 8192, maxTokens: 8192, temperature: 1 }
  const manifestPath = join(data.directory, "manifest.json")
  writeJson(manifestPath, { ...data.manifest, fingerprint: "original", dataset_sha256: "original", agent: publicConfig, judge: publicConfig })
  const protectedTrace = readFileSync(join(data.directory, "Allrecipes--0", "trace.ndjson"), "utf8")
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/backfill-missing.mjs", import.meta.url)), "--out", data.directory, "--data", dataset, "--execute"], {
      env: { ...process.env, DSH_HOME: data.directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: baseURL, EVAL_API_KEY: "fixture-key" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const [code] = await once(child, "close")
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.equal(requests, 2, "one admission request and one missing-task request expected")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    assert.deepEqual(manifest.tasks.map(task => task.task_id), tasks.map(task => task.task_id))
    assert.deepEqual(manifest.backfill.protected_task_ids, ["Allrecipes--0", "Allrecipes--2"])
    assert.deepEqual(manifest.backfill.added_task_ids, ["Allrecipes--1"])
    const results = readFileSync(join(data.directory, "results.ndjson"), "utf8").trim().split(/\r?\n/).map(JSON.parse)
    assert.deepEqual(results.map(result => result.task_id), tasks.map(task => task.task_id))
    assert.equal(JSON.parse(readFileSync(join(data.directory, "Allrecipes--1", "result.json"), "utf8")).status, "completed")
    assert.equal(readFileSync(join(data.directory, "Allrecipes--0", "trace.ndjson"), "utf8"), protectedTrace)
    assert.deepEqual(JSON.parse(readFileSync(join(data.directory, "task-metrics.json"), "utf8")).map(row => row.task_id), tasks.map(task => task.task_id))
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("backfill execution rejects a second process while the first owns the run lock", async () => {
  const data = fixture()
  const dataset = join(data.directory, "dataset.json")
  writeJson(dataset, tasks)
  let requests = 0
  let holdResponse
  let signalFirstRequest
  const firstRequest = new Promise(resolve => { signalFirstRequest = resolve })
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    if (requests === 1) {
      holdResponse = response
      signalFirstRequest()
      return
    }
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "fixture answer" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const publicConfig = { provider: "fixture", model: "fixture", protocol: "openai-completions", baseURL, modelMaxTokens: 8192, contextWindow: 8192, maxTokens: 8192, temperature: 1 }
  writeJson(join(data.directory, "manifest.json"), { ...data.manifest, fingerprint: "original", dataset_sha256: "original", agent: publicConfig, judge: publicConfig })
  const command = [fileURLToPath(new URL("../scripts/eval/backfill-missing.mjs", import.meta.url)), "--out", data.directory, "--data", dataset, "--execute"]
  const options = {
    env: { ...process.env, DSH_HOME: data.directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: baseURL, EVAL_API_KEY: "fixture-key" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }
  const capture = child => {
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    return { stdout: () => stdout, stderr: () => stderr }
  }
  let first
  try {
    first = spawn(process.execPath, command, options)
    const firstOutput = capture(first)
    await firstRequest
    const second = spawn(process.execPath, command, options)
    const secondOutput = capture(second)
    const [secondCode] = await once(second, "close")
    assert.notEqual(secondCode, 0)
    assert.match(secondOutput.stderr(), /Evaluation run is already active/)
    holdResponse.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    const [firstCode] = await once(first, "close")
    assert.equal(firstCode, 0, `${firstOutput.stdout()}\n${firstOutput.stderr()}`)
    assert.equal(requests, 2, "the rejected process must not reach the provider")
  } finally {
    if (first && first.exitCode === null) first.kill()
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("a new evaluator safely recovers a lock left by a killed local process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-eval-stale-lock-"))
  const moduleUrl = new URL("../scripts/eval/backfill.mjs", import.meta.url).href
  const hold = `import { acquireRunLock } from ${JSON.stringify(moduleUrl)}; acquireRunLock(process.argv[1]); console.log("LOCKED"); setInterval(() => {}, 1000)`
  const recover = `import { acquireRunLock } from ${JSON.stringify(moduleUrl)}; const release = acquireRunLock(process.argv[1]); release(); console.log("RECOVERED")`
  let owner
  try {
    owner = spawn(process.execPath, ["--input-type=module", "-e", hold, directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let ready = ""
    owner.stdout.on("data", chunk => { ready += chunk })
    await once(owner.stdout, "data")
    assert.match(ready, /LOCKED/)
    owner.kill("SIGKILL")
    await once(owner, "close")
    const successor = spawn(process.execPath, ["--input-type=module", "-e", recover, directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    successor.stdout.on("data", chunk => { stdout += chunk })
    successor.stderr.on("data", chunk => { stderr += chunk })
    const [code] = await once(successor, "close")
    assert.equal(code, 0, stderr)
    assert.match(stdout, /RECOVERED/)
  } finally {
    if (owner && owner.exitCode === null) owner.kill("SIGKILL")
    rmSync(directory, { recursive: true, force: true })
  }
})

test("owner-requested targeted rerun preserves attempt one and replaces only the selected current view", async () => {
  const data = fixture()
  const dataset = join(data.directory, "dataset.json")
  writeJson(dataset, tasks)
  const prior = { task_id: tasks[1].task_id, status: "timeout", duration_ms: 600000, steps: 7, browser_steps: 7, final_answer: "", tool_trace: [], error: "timeout", attempt_number: 1, attempt_directory: tasks[1].task_id, judge_mode: "none" }
  writeTrajectory(data.directory, tasks[1], prior)
  writeFileSync(join(data.directory, "results.ndjson"), [...data.results.slice(0, 1), prior, ...data.results.slice(1)].map(JSON.stringify).join("\n") + "\n")
  const unrelatedOrphan = { ...data.results[0], attempt_number: 2, attempt_directory: join(tasks[0].task_id, "attempts", "2") }
  writeTrajectory(join(data.directory, tasks[0].task_id, "attempts"), { ...tasks[0], task_id: "2" }, { ...unrelatedOrphan, task_id: "2" })
  writeJson(join(data.directory, tasks[0].task_id, "attempts", "2", "task.json"), tasks[0])
  writeJson(join(data.directory, tasks[0].task_id, "attempts", "2", "result.json"), unrelatedOrphan)
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "replacement answer" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const publicConfig = { provider: "fixture", model: "fixture", protocol: "openai-completions", baseURL, modelMaxTokens: 8192, contextWindow: 8192, maxTokens: 8192, temperature: 1 }
  const manifestPath = join(data.directory, "manifest.json")
  writeJson(manifestPath, { ...data.manifest, tasks, fingerprint: "prior", dataset_sha256: "prior", agent: publicConfig, judge: publicConfig, backfill: { protected_task_ids: [tasks[0].task_id, tasks[2].task_id], added_task_ids: [tasks[1].task_id] } })
  const original = readFileSync(join(data.directory, tasks[1].task_id, "result.json"), "utf8")
  try {
    const command = [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--out", data.directory, "--data", dataset, "--rerun-ids", tasks[1].task_id, "--timeout", "600000", "--preflight-timeout", "60000", "--max-rounds", "50", "--concurrency", "1", "--judge", "none", "--headed"]
    const options = {
      env: { ...process.env, DSH_HOME: data.directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: baseURL, EVAL_API_KEY: "fixture-key" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
    const child = spawn(process.execPath, command, options)
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const [code] = await once(child, "close")
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.equal(requests, 2, "one admission request and one selected-task request expected")
    assert.equal(readFileSync(join(data.directory, tasks[1].task_id, "result.json"), "utf8"), original)
    const current = readRunResults(data.directory).find(result => result.task_id === tasks[1].task_id)
    assert.equal(current.attempt_number, 2)
    assert.equal(current.attempt_directory.replaceAll("\\", "/"), `${tasks[1].task_id}/attempts/2`)
    assert.equal(current.status, "completed")
    assert.equal(JSON.parse(readFileSync(join(data.directory, tasks[1].task_id, "attempts", "2", "result.json"), "utf8")).status, "completed")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    assert.equal(manifest.fingerprint, "prior", "targeted replacement must not authorize a whole-run resume under new code")
    assert.deepEqual(manifest.reruns.at(-1).task_ids, [tasks[1].task_id])
    const currentResults = readRunResults(data.directory)
    assert.deepEqual(currentResults.map(result => result.task_id), tasks.map(task => task.task_id))
    assert.equal(currentResults.find(result => result.task_id === tasks[0].task_id).attempt_number ?? 1, 1, "an unrelated orphan attempt must remain untouched")
    assert.deepEqual(JSON.parse(readFileSync(join(data.directory, "recovery.json"), "utf8")).pending, [])
    const interleaved = JSON.parse(readFileSync(manifestPath, "utf8"))
    interleaved.reruns.push({ requested_at: new Date().toISOString(), task_ids: [tasks[0].task_id], previous_attempts: [{ task_id: tasks[0].task_id, attempt_number: 1, result_sha256: "interleaved" }] })
    writeJson(manifestPath, interleaved)
    const recovery = spawn(process.execPath, command, options)
    let recoveryStdout = "", recoveryStderr = ""
    recovery.stdout.on("data", chunk => { recoveryStdout += chunk })
    recovery.stderr.on("data", chunk => { recoveryStderr += chunk })
    const [recoveryCode] = await once(recovery, "close")
    assert.equal(recoveryCode, 0, `${recoveryStdout}\n${recoveryStderr}`)
    assert.equal(requests, 2, "reopening the completed replacement request must only rebuild reports")
    assert.equal(readRunResults(data.directory).find(result => result.task_id === tasks[1].task_id).attempt_number, 2)
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).reruns.length, 2, "an interleaved request must not hide the earlier matching request")
    const audit = spawn(process.execPath, [...command, "--dry-run"], options)
    let auditStdout = "", auditStderr = ""
    audit.stdout.on("data", chunk => { auditStdout += chunk })
    audit.stderr.on("data", chunk => { auditStderr += chunk })
    const [auditCode] = await once(audit, "close")
    assert.equal(auditCode, 0, auditStderr)
    assert.equal(JSON.parse(auditStdout).recovery_plan.filter(item => item.action !== "skip").length, 0)
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(data.directory, { recursive: true, force: true })
  }
})

test("multi-task targeted recovery skips an already completed replacement and runs only the unfinished ID", async () => {
  const data = fixture()
  const dataset = join(data.directory, "dataset.json")
  writeJson(dataset, tasks)
  const taskOnePrior = { task_id: tasks[1].task_id, status: "timeout", duration_ms: 600000, steps: 7, browser_steps: 7, final_answer: "", tool_trace: [], error: "timeout", attempt_number: 1, attempt_directory: tasks[1].task_id, judge_mode: "none" }
  writeTrajectory(data.directory, tasks[1], taskOnePrior)
  writeFileSync(join(data.directory, "results.ndjson"), [...data.results.slice(0, 1), taskOnePrior, ...data.results.slice(1)].map(JSON.stringify).join("\n") + "\n")
  const taskZeroReplacement = { ...data.results[0], final_answer: "already replaced", attempt_number: 2, attempt_directory: join(tasks[0].task_id, "attempts", "2"), judge_mode: "none" }
  writeTrajectory(join(data.directory, tasks[0].task_id, "attempts"), { ...tasks[0], task_id: "2" }, { ...taskZeroReplacement, task_id: "2" })
  writeJson(join(data.directory, tasks[0].task_id, "attempts", "2", "task.json"), tasks[0])
  writeJson(join(data.directory, tasks[0].task_id, "attempts", "2", "result.json"), taskZeroReplacement)
  reviseResult(data.directory, data.results[0], taskZeroReplacement)
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests++
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "remaining replacement" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseURL = `http://127.0.0.1:${server.address().port}`
  const publicConfig = { provider: "fixture", model: "fixture", protocol: "openai-completions", baseURL, modelMaxTokens: 8192, contextWindow: 8192, maxTokens: 8192, temperature: 1 }
  const ids = [tasks[0].task_id, tasks[1].task_id]
  const manifestPath = join(data.directory, "manifest.json")
  writeJson(manifestPath, {
    ...data.manifest, tasks, fingerprint: "prior", dataset_sha256: "prior", agent: publicConfig, judge: publicConfig,
    backfill: { protected_task_ids: [tasks[2].task_id], added_task_ids: ids },
    reruns: [{ requested_at: new Date().toISOString(), task_ids: ids, prior_fingerprint: "prior", replacement_fingerprint: "earlier", previous_attempts: ids.map(task_id => ({ task_id, attempt_number: 1, result_sha256: "fixture" })) }],
  })
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--out", data.directory, "--data", dataset, "--rerun-ids", ids.join(","), "--timeout", "600000", "--preflight-timeout", "60000", "--max-rounds", "50", "--concurrency", "1", "--judge", "none", "--headed"], {
      env: { ...process.env, DSH_HOME: data.directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: baseURL, EVAL_API_KEY: "fixture-key" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const [code] = await once(child, "close")
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.equal(requests, 2, "only admission and the unfinished target may reach the provider")
    const current = readRunResults(data.directory)
    assert.equal(current.find(result => result.task_id === tasks[0].task_id).attempt_number, 2)
    assert.equal(current.find(result => result.task_id === tasks[1].task_id).attempt_number, 2)
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).reruns.length, 1)
    const reversed = spawn(process.execPath, [fileURLToPath(new URL("../scripts/eval/run.mjs", import.meta.url)), "--out", data.directory, "--data", dataset, "--rerun-ids", ids.toReversed().join(","), "--timeout", "600000", "--preflight-timeout", "60000", "--max-rounds", "50", "--concurrency", "1", "--judge", "none", "--headed"], {
      env: { ...process.env, DSH_HOME: data.directory, EVAL_PROVIDER: "fixture", EVAL_MODEL: "fixture", EVAL_API_PROTOCOL: "openai-completions", EVAL_BASE_URL: baseURL, EVAL_API_KEY: "fixture-key" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let reversedStdout = "", reversedStderr = ""
    reversed.stdout.on("data", chunk => { reversedStdout += chunk })
    reversed.stderr.on("data", chunk => { reversedStderr += chunk })
    const [reversedCode] = await once(reversed, "close")
    assert.equal(reversedCode, 0, `${reversedStdout}\n${reversedStderr}`)
    assert.equal(requests, 2, "reversing the same target ID set must not create another attempt")
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).reruns.length, 1)
  } finally {
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    rmSync(data.directory, { recursive: true, force: true })
  }
})

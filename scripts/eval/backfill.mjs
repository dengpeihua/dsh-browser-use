import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { hash, readJson, readLines, resumeAction } from "./core.mjs"
import { evidenceDirectory } from "./state.mjs"

const settledStatuses = new Set(["completed", "error", "timeout", "step_limit"])

export function acquireRunLock(directory) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, ".eval-run.lock")
  const recoveryPath = `${path}.recover`
  const payload = JSON.stringify({ pid: process.pid, hostname: hostname(), started_at: new Date().toISOString(), process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(), argv: process.argv.slice(2) }) + "\n"
  const create = () => {
    const descriptor = openSync(path, "wx")
    try { writeFileSync(descriptor, payload) } catch (error) {
      closeSync(descriptor)
      try { unlinkSync(path) } catch {}
      throw error
    }
    return descriptor
  }
  const inspect = () => {
    const text = readFileSync(path, "utf8").trim()
    let owner
    try { owner = JSON.parse(text) } catch {}
    return { text: text || "unknown owner", owner }
  }
  const stale = owner => {
    if (!owner || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false
    try { process.kill(owner.pid, 0); return false } catch (error) { return error.code === "ESRCH" }
  }
  let descriptor
  try { descriptor = create() } catch (error) {
    if (error.code !== "EEXIST") throw error
    const observed = inspect()
    if (!stale(observed.owner)) throw new Error(`Evaluation run is already active for ${directory}; lock owner: ${observed.text}`)
    let recoveryDescriptor
    try {
      recoveryDescriptor = openSync(recoveryPath, "wx")
    } catch (recoveryError) {
      if (recoveryError.code === "EEXIST") throw new Error(`Evaluation run lock recovery is already active for ${directory}`)
      throw recoveryError
    }
    try {
      let current
      try { current = inspect() } catch (inspectError) {
        if (inspectError.code !== "ENOENT") throw inspectError
      }
      if (current) {
        if (!stale(current.owner)) throw new Error(`Evaluation run is already active for ${directory}; lock owner: ${current.text}`)
        unlinkSync(path)
      }
      try { descriptor = create() } catch (createError) {
        if (createError.code === "EEXIST") throw new Error(`Evaluation run became active while recovering the stale lock for ${directory}`)
        throw createError
      }
    } finally {
      closeSync(recoveryDescriptor)
      try { unlinkSync(recoveryPath) } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError
      }
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    closeSync(descriptor)
    try { unlinkSync(path) } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

function taskMap(tasks, label) {
  const byId = new Map()
  for (const task of tasks) {
    if (byId.has(task.task_id)) throw new Error(`${label} contains duplicate task ID ${task.task_id}`)
    byId.set(task.task_id, task)
  }
  return byId
}

function assertSameTask(expected, actual) {
  if (!actual || hash(actual) !== hash(expected)) throw new Error(`Existing task ${expected.task_id} differs from the target dataset`)
}

function assertTaskIdentity(expected, actual) {
  const identity = task => task && ({ task_id: task.task_id, confirmed_task: task.confirmed_task, website: task.website })
  if (!actual || hash(identity(actual)) !== hash(identity(expected))) throw new Error(`Existing task ${expected.task_id} differs from the target dataset`)
}

function assertSubsequence(existingTasks, targetTasks) {
  const target = taskMap(targetTasks, "Target dataset")
  let position = -1
  for (const task of existingTasks) {
    assertSameTask(task, target.get(task.task_id))
    const next = targetTasks.findIndex((candidate, index) => index > position && candidate.task_id === task.task_id)
    if (next < 0) throw new Error("Existing manifest task order is not a subsequence of the target dataset")
    position = next
  }
}

export function orderResults(results, tasks) {
  const expected = new Set(tasks.map(task => task.task_id))
  const byId = new Map()
  for (const result of results) {
    if (!expected.has(result.task_id)) throw new Error(`Unexpected result ID ${result.task_id}`)
    if (byId.has(result.task_id)) throw new Error(`Duplicate result ID ${result.task_id}`)
    byId.set(result.task_id, result)
  }
  return tasks.flatMap(task => byId.has(task.task_id) ? [byId.get(task.task_id)] : [])
}

function assertTrajectory(directory, task, result) {
  const evidence = evidenceDirectory(directory, result)
  for (const name of ["task.json", "session.json", "trace.ndjson", "result.json"]) {
    if (!existsSync(join(evidence, name))) throw new Error(`Protected task ${task.task_id} is missing ${name}`)
  }
  assertTaskIdentity(task, readJson(join(evidence, "task.json")))
  const saved = readJson(join(evidence, "result.json"))
  if (saved.task_id !== task.task_id) throw new Error(`Protected task ${task.task_id} has a mismatched result.json`)
  if (!settledStatuses.has(saved.status) || !settledStatuses.has(result.status)) throw new Error(`Protected task ${task.task_id} has an invalid result status`)
  for (const name of ["duration_ms", "steps", "browser_steps"]) {
    if (!Number.isFinite(saved[name]) || saved[name] < 0) throw new Error(`Protected task ${task.task_id} has an invalid ${name}`)
  }
  if (typeof saved.final_answer !== "string" || !Array.isArray(saved.tool_trace)) throw new Error(`Protected task ${task.task_id} has an incomplete result.json`)
  for (const name of ["status", "duration_ms", "steps", "browser_steps", "final_answer"]) {
    if (saved[name] !== result[name]) throw new Error(`Protected task ${task.task_id} result.json disagrees with the result index on ${name}`)
  }
  const session = readJson(join(evidence, "session.json"))
  if (!Array.isArray(session) || !session.length) throw new Error(`Protected task ${task.task_id} has an empty session.json`)
  const trace = readLines(join(evidence, "trace.ndjson"))
  if (!trace.length) throw new Error(`Protected task ${task.task_id} has an empty trace.ndjson`)
}

export function planBackfill({ directory, tasks, manifest, results }) {
  assertSubsequence(manifest.tasks, tasks)
  const target = taskMap(tasks, "Target dataset")
  const resultById = new Map(results.map(result => [result.task_id, result]))
  if (resultById.size !== results.length) throw new Error("Existing results contain duplicate task IDs")
  for (const id of resultById.keys()) if (!target.has(id)) throw new Error(`Existing result ${id} is not in the target dataset`)

  const protectedIds = manifest.backfill?.protected_task_ids ?? manifest.tasks.map(task => task.task_id)
  const protectedSet = new Set(protectedIds)
  if (protectedSet.size !== protectedIds.length) throw new Error("Backfill protected task IDs contain duplicates")
  for (const id of protectedIds) {
    const task = target.get(id)
    const result = resultById.get(id)
    if (!task) throw new Error(`Protected task ${id} is not in the target dataset`)
    if (!result) throw new Error(`Protected task ${id} has no indexed result; refusing to rerun it`)
    if (resumeAction(result, manifest.judge_mode) !== "skip") throw new Error(`Protected task ${id} is unresolved; refusing to rerun or rejudge it`)
    assertTrajectory(directory, task, result)
  }

  const rows = tasks.map((task, datasetIndex) => {
    const result = resultById.get(task.task_id)
    const protectedTask = protectedSet.has(task.task_id)
    return {
      task_id: task.task_id,
      dataset_index: datasetIndex,
      protected: protectedTask,
      action: protectedTask ? "skip" : resumeAction(result, manifest.judge_mode),
      reason: protectedTask ? "existing_trajectory" : result ? "backfill_attempt_exists" : "missing_trajectory",
    }
  })
  return {
    total: tasks.length,
    protected_task_ids: protectedIds,
    protected: protectedIds.length,
    missing_task_ids: rows.filter(row => !row.protected && !resultById.has(row.task_id)).map(row => row.task_id),
    pending: rows.filter(row => !row.protected && row.action !== "skip"),
    rows,
  }
}

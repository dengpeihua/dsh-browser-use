import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs"
import { priceUsage } from "./metrics.mjs"

export const REFERENCE_SHA = "856867996e73f7dcc5e39827bf2af7555bd63d40"
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60000
export const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")
export const readJson = path => JSON.parse(readFileSync(path, "utf8"))
export function readLines(path, { allowTrailingPartial = false } = {}) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
  return lines.flatMap((line, index) => {
    try { return [JSON.parse(line)] } catch (error) {
      if (allowTrailingPartial && index === lines.length - 1) return []
      throw error
    }
  })
}
export function infrastructureFailure(error = "") {
  const code = typeof error === "object" && error ? error.code : undefined
  const message = typeof error === "object" && error ? error.message : String(error)
  if (code === "QUOTA" || /\b2056\b|insufficient_quota|(?:Token|Coding)\s*Plan.*(?:上限|限额|limit|exhaust)|quota[\s_-]*(?:exceeded|exhausted)|(?:5|five)[ -]hour.*(?:usage|quota).*limit/i.test(message)) return "quota_exhausted"
  if (code === "RATE_LIMIT" || /HTTP 429/.test(message)) return "provider_rate_limit"
  if (["AUTH", "INVALID_CREDENTIAL"].includes(code) || /HTTP (401|403)/.test(message)) return "provider_authentication"
  if (["SERVER", "TIMEOUT", "TRANSPORT"].includes(code) || /fetch failed|HTTP 5\d\d/i.test(message)) return "provider_connection"
  return null
}
/** Resume transient execution failures, not ordinary benchmark failures. */
export function executionFailure(result) {
  if (!result || result.status === "completed") return null
  return result.infrastructure_error || infrastructureFailure(result.error) || result.model_calls?.at(-1)?.errorKind || null
}

export function judgeOnlyPlan(results, judgeMode) {
  return results
    .filter(result => result.judge_mode !== judgeMode || typeof result.judge_result?.pass !== "boolean")
    .map(result => ({ task_id: result.task_id, action: "judge" }))
}

export function resultHaltReason(result, action) {
  return (action === "run" ? executionFailure(result) : null) || result.judge_result?.infrastructure_error || null
}

export function resumeAction(result, judgeMode = "evidence") {
  if (!result) return "run"
  if (result.status !== "completed" && (executionFailure(result) || result.error_kind === "dispatcher_interrupted" || result.error === "Run interrupted")) return "run"
  if (result.status === "completed" && judgeMode !== "none" && (result.judge_result?.infrastructure_error || typeof result.judge_result?.pass !== "boolean")) return "judge"
  return "skip"
}

export function recoveryPlan(tasks, results, judgeMode = "evidence") {
  const byId = new Map(results.map(result => [result.task_id, result]))
  return tasks.map(task => {
    const result = byId.get(task.task_id)
    const action = resumeAction(result, judgeMode)
    const reason = action === "run" ? executionFailure(result) || (result ? "interrupted" : "not_started")
      : action === "judge" ? result.judge_result?.infrastructure_error || "unjudged" : "finished"
    return { task_id: task.task_id, action, reason, previous_attempt: result ? result.attempt_number ?? 1 : null }
  }).sort((a, b) => {
    const priority = item => item.action === "skip" ? 3 : item.reason === "quota_exhausted" ? 0 : item.previous_attempt !== null ? 1 : 2
    return priority(a) - priority(b)
  })
}

/** Allocate space across observations; never silently keep only the beginning of a session. */
export function judgeEvidence(events) {
  if (!Array.isArray(events)) throw new Error("Invalid evidence session")
  const all = events.filter(e => e.type === "tool/result" && Number.isSafeInteger(e.seq))
  if (!all.length) throw new Error("No browser tool evidence available for judgment")
  const selected = all.length <= 500 ? all : [...all.slice(0, 250), ...all.slice(-250)]
  const calls = new Map(events.filter(e => e.type === "tool/call").map(e => [e.data.callId, e.data]))
  const rows = selected.map(e => {
    const call = calls.get(e.data?.message?.source?.callId)
    const observation = e.data?.meta?.browserContext?.observation
    const content = (e.data?.message?.content ?? []).flatMap(c => c.type === "tool-result" ? c.content ?? [] : [c]).filter(c => c.type === "text").map(c => c.text).join("\n")
    return { seq: e.seq, time: e.time, tool: call?.name, url: observation?.url, capturedAt: observation?.capturedAt, has_observation: !!observation, status: e.data?.meta?.status, error: e.data?.message?.content?.some(c => c.isError === true), content }
  })
  let limit = Math.min(12000, Math.floor(90000 / rows.length))
  while (true) {
    const projected = rows.map(row => ({ ...row, truncated: row.content.length > limit, content: row.content.length <= limit ? row.content : `${row.content.slice(0, Math.floor(limit / 2))}\n[... omitted ...]\n${row.content.slice(-Math.floor(limit / 2))}` }))
    const text = JSON.stringify(projected)
    if (text.length <= 120000) return { text, seqs: rows.map(r => r.seq), supportingSeqs: rows.filter(r => r.has_observation && !r.error && r.status !== "error").map(r => r.seq), truncated: selected.length < all.length || projected.some(r => r.truncated) }
    limit = Math.floor(limit / 2)
    if (limit < 1) throw new Error("Evidence metadata exceeds judge budget")
  }
}
export function imageDimensions(data, mediaType) {
  const bytes = Buffer.from(data)
  if (mediaType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (width && height) return { width, height }
  }
  if (mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5)
        if (width && height) return { width, height }
      }
      offset += length
    }
  }
  throw new Error("Invalid or unsupported screenshot header; expected JPEG or PNG dimensions")
}
export function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n")
  renameSync(`${path}.tmp`, path)
}
export function redact(value, secrets = []) {
  const text = JSON.stringify(value, (key, item) => /^(apiKey|api_key|authorization|cookie|set-cookie|password|secret)$/i.test(key) ? "[REDACTED]" : item)
  return JSON.parse(secrets.filter(Boolean).reduce((s, secret) => s.split(secret).join("[REDACTED]"), text))
}
export function appendJson(path, value, secrets = []) { appendFileSync(path, JSON.stringify(redact(value, secrets)) + "\n") }
export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("Dataset must be a nonempty array")
  const seen = new Set()
  for (const task of tasks) {
    if (!/^[A-Za-z0-9_-]+$/.test(task.task_id) || seen.has(task.task_id)) throw new Error("Invalid or duplicate task ID")
    seen.add(task.task_id)
    if (typeof task.confirmed_task !== "string" || !task.confirmed_task.trim()) throw new Error("Missing task instruction")
    if (!["https:", "http:"].includes(new URL(task.website).protocol)) throw new Error("Task URL must use HTTP(S)")
  }
  return tasks
}
export function parseJudgment(raw) {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))
  if (typeof value.pass !== "boolean" || typeof value.reason !== "string" || !value.reason.trim() || !["high", "medium", "low"].includes(value.confidence)) throw new Error("Invalid judge schema: expected boolean pass, reason, confidence")
  return { pass: value.pass, reason: value.reason, confidence: value.confidence }
}
export function normalizeUsage(usage) {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return null
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const values = { input: usage.prompt_tokens - cached - written, cache_read: cached, cache_write: written, output: usage.completion_tokens, reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0 }
  if (Object.values(values).some(n => !Number.isFinite(n) || n < 0)) return null
  return values
}
export function estimateCost(usage, model, pricing) {
  return priceUsage(usage, model, pricing)?.total ?? null
}
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
export function measurementHealth(results, total) {
  const infrastructure = results.filter(r => executionFailure(r) || r.error_kind === "dispatcher_interrupted" || r.judge_result?.infrastructure_error)
  return {
    infrastructure_errors: infrastructure.length,
    complete_without_infrastructure_errors: results.length === total && !infrastructure.length && results.every(r => typeof r.judge_result?.pass === "boolean"),
    observed_cost_usd: results.reduce((sum, r) => sum + (r.cost_observed ?? r.cost ?? 0), 0),
    unpriced_calls: results.every(r => Number.isInteger(r.unpriced_calls)) ? results.reduce((sum, r) => sum + r.unpriced_calls, 0) : null,
    duration_lower_bound_tasks: results.filter(r => r.duration_basis?.includes("lower bound")).length,
  }
}
export function summarize(results, tasks) {
  const byId = new Map()
  const expected = new Set(tasks.map(t => t.task_id))
  for (const result of results) {
    if (!expected.has(result.task_id) || byId.has(result.task_id)) throw new Error("Unexpected or duplicate result ID")
    byId.set(result.task_id, result)
  }
  function group(selected) {
    const rows = selected.map(t => byId.get(t.task_id)).filter(Boolean)
    const passed = rows.filter(r => r.judge_result?.pass === true).length
    const judged = rows.filter(r => typeof r.judge_result?.pass === "boolean").length
    const priced = rows.filter(r => r.cost !== null && Number.isFinite(r.cost))
    return { total: selected.length, attempted: rows.length, missing: selected.length - rows.length, completed: rows.filter(r => r.status === "completed").length, errors: rows.filter(r => r.status === "error").length, website_unavailable: rows.filter(r => r.error_kind === "website_unavailable").length, timeouts: rows.filter(r => r.status === "timeout").length, step_limits: rows.filter(r => r.status === "step_limit").length, passed, judged, unjudged: selected.length - judged, success_rate: selected.length ? passed / selected.length : null, scoring_complete: judged === selected.length, avg_steps: mean(rows.map(r => r.steps)), avg_browser_steps: mean(rows.map(r => r.browser_steps)), avg_duration_s: mean(rows.map(r => r.duration_ms / 1000)), cost_known_tasks: priced.length, total_cost_usd: priced.length === rows.length && rows.length ? priced.reduce((s, r) => s + r.cost, 0) : null, avg_cost_usd: priced.length === rows.length ? mean(priced.map(r => r.cost)) : null, judge_cost_usd: rows.every(r => Number.isFinite(r.judge_result?.cost)) && rows.length ? rows.reduce((s, r) => s + r.judge_result.cost, 0) : null }
  }
  return { ...group(tasks), denominator: "all selected tasks, including missing/error/timeout; unjudged are unresolved", averages: "attempted tasks including errors/timeouts; agent time excludes judging and cleanup", cost_basis: "MiniMax-M3 standard USD list-price estimate 2026-09-13; not actual Token Plan billing", per_site: Object.fromEntries([...new Set(tasks.map(t => new URL(t.website).hostname))].map(site => [site, group(tasks.filter(t => new URL(t.website).hostname === site))])) }
}

import test from "node:test"
import assert from "node:assert/strict"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import * as browser from "../lib/index.js"

const events = s => typeof s.snapshotEvents === "function" ? s.snapshotEvents() : s.events
const modern = s => typeof s.snapshotEvents === "function"
const replace = (s, seq) => ({ surfaceOp: modern(s) ? { op: "replace", startSeq: seq, endSeq: seq } : { op: "replace", start: seq, end: seq }, sourceEventSeqs: [seq] })

function observe(s) {
  const text = "Product A costs 100 yuan"
  const observation = { version: 1, runtimeId: "live", tabId: "tab0", domId: "dom0", mode: "full", output: text, fullOutput: text, url: "https://shop.test/a", capturedAt: "2026-10-23T00:00:00Z" }
  s.append("tool/call", { turn: 1, step: 1, callId: "call0", name: "browser_goto", arguments: "{}" })
  const content = [{ type: "text", text }]
  const message = modern(s)
    ? { id: "result0", role: "tool", source: { kind: "tool", callId: "call0" }, toolCallId: "call0", content }
    : createUserMessage({ source: { kind: "tool", callId: "call0" }, content: [{ type: "tool-result", toolCallId: "call0", content }] })
  const event = s.append("tool/result", { turn: 1, step: 1, message, meta: { browserContext: { version: 1, observation } } }, { surfaceOp: "append" })
  return { observation, event, text }
}

test("all six context writes use producer-owned sources and replay without duplicate snapshots", async () => {
  const s = Session.create(SessionId("source-regression"))
  const o = observe(s)
  browser.recordBrowserFacts(s, { observations: [{ observationId: browser.browserObservationId(o.observation), facts: [{ entity: "Product A", attribute: "price", value: "100 yuan", evidence: o.text }] }] })
  browser.prepareBrowserMemory(s)
  browser.defineEvidenceTask(s, { mode: "records", objective: "Find price", requiredFields: ["price"], minRecords: 1 })
  s.append("user/message", createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Compacted observation" }] }), replace(s, o.event.seq))
  browser.prepareBrowserContext(s, "live")
  const runtime = new browser.BrowserRuntime({ headless: true })
  const manager = runtime.getManager(String(s.id))
  manager.detectStateChanges = () => [{ tabId: "tab0", lastUrl: "https://shop.test/a", currentUrl: "chrome-error://chromewebdata/" }]
  try { runtime.prepareContext(s) } finally { await runtime.dispose() }
  const writes = events(s).filter(e => e.type === "user/message" && e.data.source.kind.startsWith("dsh-browser:"))
  assert.deepEqual([...new Set(writes.map(e => e.data.source.kind))].sort(), ["evidence-record", "fact-record", "recovery", "state-change", "task-memory"].map(k => `dsh-browser:${k}`).sort())
  assert.ok(writes.some(e => e.data.source.kind === "dsh-browser:fact-record" && e.surfaceOp === "append"))
  assert.ok(writes.some(e => e.data.source.kind === "dsh-browser:fact-record" && typeof e.surfaceOp === "object"))
  assert.ok(writes.every(e => !("plugin" in e.data.source)))
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(events(s))))
  assert.deepEqual(replay.deriveMessages(), s.deriveMessages())
  assert.equal(browser.recallBrowserMemory(replay, {}).facts[0].value, "100 yuan")
  assert.equal(browser.checkEvidenceCoverage(replay).status, browser.checkEvidenceCoverage(s).status)
  const before = events(replay).length
  browser.prepareBrowserMemory(replay)
  assert.equal(events(replay).length, before)
  if (process.env.DSH_TEST_V4_CODEC) {
    const { releasedV4SessionFormatCodec: codec } = await import(process.env.DSH_TEST_V4_CODEC)
    for (const event of events(s)) assert.doesNotThrow(() => codec.encodeEvent(event))
    for (const event of writes) {
      const legacy = structuredClone(event)
      legacy.data.source = { ...legacy.data.source, kind: "plugin", plugin: event.data.source.kind }
      assert.throws(() => codec.encodeEvent(legacy), /producer-owned source kind/)
    }
  }
})

test("legacy v3 browser facts and evidence remain readable", () => {
  const s = Session.create(SessionId("legacy-sources"))
  const o = observe(s)
  browser.recordBrowserFacts(s, { observations: [{ observationId: browser.browserObservationId(o.observation), facts: [{ entity: "Product A", attribute: "price", value: "100 yuan", evidence: o.text }] }] })
  browser.defineEvidenceTask(s, { mode: "records", objective: "Find price", requiredFields: ["price"], minRecords: 1 })
  const legacyEvents = structuredClone(events(s))
  for (const e of legacyEvents) if (e.type === "user/message" && e.data.source.kind.startsWith("dsh-browser:")) {
    e.data.source = { ...e.data.source, kind: "plugin", plugin: e.data.source.kind }
  }
  const legacy = Session.create(s.id, legacyEvents)
  assert.equal(browser.recallBrowserMemory(legacy, {}).facts[0].value, "100 yuan")
  assert.equal(browser.checkEvidenceCoverage(legacy).status, browser.checkEvidenceCoverage(s).status)
  browser.prepareBrowserMemory(legacy)
  assert.ok(legacy.deriveMessages().some(m => m.source.kind === "dsh-browser:task-memory"))
})

// Real Cordis + published DSH AgentLoop + Chromium. Only model decisions are deterministic.
import assert from "node:assert/strict"
import { Context } from "@deepseek-ai/cordis"
import AgentRegistry from "@deepseek-ai/dsh-agent"
import AgentLoop from "@deepseek-ai/dsh-agent-loop"
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session"
import SessionProjections from "@deepseek-ai/dsh-session-projection"
import LlmRuntime, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"
import ToolRuntime from "@deepseek-ai/dsh-tools"
import TokenMeter from "@deepseek-ai/dsh-token-meter"
import * as browserPlugin from "../lib/index.js"
import { assertToolProtocol } from "./assert-tool-protocol.mjs"

const html = `<title>Host browser test</title><style>p{margin:0;line-height:16px}</style><main>${Array.from({ length: 40 }, (_, i) => `<p>Stable row ${i}</p>`).join("")}<svg width="64" height="32" aria-label="chart"><rect width="64" height="32" fill="navy"/></svg></main>`
const url = `data:text/html,${encodeURIComponent(html)}`
const actions = [
  ["browser_start", { url }],
  ["browser_execute_script", { script: "document.querySelector('main').insertAdjacentHTML('beforeend','<p>NEW SMALL ROW</p>'); return 'fact: selected item 42'" }],
  ["browser_execute_script", { script: "document.querySelectorAll('p').forEach((p,i)=>p.textContent='Changed row '+i); return 'large update'" }],
  ["browser_execute_script", { script: "return 'unchanged 1'" }],
  ["browser_execute_script", { script: "return 'unchanged 2'" }],
  ["browser_execute_script", { script: "return 'unchanged checkpoint'" }],
  ["browser_view_elements", null],
  ["browser_view_elements", null],
  ["browser_new_tab", { url: "data:text/html,<h1>Second tab</h1>" }],
  ["browser_switch_tab", { tabId: "tab0" }],
  ["browser_close_tab", { tabIds: ["tab0", "tab1"] }],
]
class ScriptedAdapter extends LlmAdapter {
  requests = []
  totalRequests = 0
  constructor(script = actions) { super(); this.script = script }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(options) {
    assertToolProtocol(options.messages)
    this.totalRequests++
    this.requests.push(structuredClone(options.messages))
    const action = this.script[this.requests.length - 1]
    if (!action) {
      yield { type: "block-start", index: 0, blockType: "text" }
      yield { type: "text-delta", index: 0, text: "done" }
      yield { type: "block-end", index: 0, block: { type: "text", text: "done" } }
      yield { type: "finish", reason: { kind: "stop" } }
      return
    }
    let [name, args] = action
    if (args === null) {
      const text = JSON.stringify(options.messages)
      const ids = [...text.matchAll(/\[view:([^\]]+)\]/g)].map(m => m[1]).filter(id => id !== "ID")
      assert.ok(ids.length, "the latest observation exposes a screenshot target")
      args = { viewIds: [ids.at(-1)] }
    }
    const id = `host-call-${this.totalRequests}`
    const argumentsJson = JSON.stringify(args)
    if (this.totalRequests === 3) {
      const note = "Browser working note: selected item 42"
      yield { type: "block-start", index: 0, blockType: "text" }
      yield { type: "text-delta", index: 0, text: note }
      yield { type: "block-end", index: 0, block: { type: "text", text: note } }
    }
    const callIndex = this.totalRequests === 3 ? 1 : 0
    yield { type: "block-start", index: callIndex, blockType: "tool-call" }
    yield { type: "tool-call-delta", index: callIndex, id, name, argumentsDelta: argumentsJson }
    yield { type: "block-end", index: callIndex, block: { type: "tool-call", id, name, arguments: argumentsJson } }
    yield { type: "finish", reason: { kind: "tool-calls" } }
  }
}

const ctx = new Context()
const adapter = new ScriptedAdapter()
let imageCount = 0
let disposeBrowser
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentRegistry, TokenMeter]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(["fixture"], adapter)
  ctx.provide("attachments", {
    async saveImages(inputs) {
      return inputs.map(input => ({ attachmentId: `sha256:${String(++imageCount).padStart(64, "0")}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 64, height: 32, name: input.name }))
    },
  })
  const browserFiber = ctx.plugin(browserPlugin, { approvalMode: "off", headless: true, maxContextDeltas: 2 })
  await browserFiber
  disposeBrowser = () => browserFiber.dispose()
  const agent = ctx.agentLoop.create(SessionId("host-browser-smoke"), { provider: "fixture", model: "fixture" })
  agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Inspect the local fixture and preserve extracted facts." }] }))
  await agent.whenIdle()
  assert.equal(adapter.requests.length, actions.length + 1, JSON.stringify(agent.session.events.slice(-4)))
  const allResults = agent.session.events.filter(e => e.type === "tool/result" && e.surfaceOp === "append")
  assert.ok(!agent.session.events.some(e => e.type === "tool/call" && ["browser_define_task", "browser_record_facts", "browser_check_coverage"].includes(e.data.name)))
  assert.ok(allResults.every(e => !e.data.message.content[0].isError), JSON.stringify(allResults))
  const results = allResults.filter(e => e.data.meta?.browserContext)
  assert.equal(results.length, actions.length)
  assert.ok(results.every(e => !e.data.message.content[0].isError), JSON.stringify(results))
  const observed = results.filter(e => e.data.meta?.browserContext?.observation)
  assert.equal(observed[0].data.meta.browserContext.observation.mode, "full")
  assert.equal(observed[1].data.meta.browserContext.observation.mode, "incremental")
  assert.equal(observed[2].data.meta.browserContext.observation.mode, "full")
  assert.deepEqual(observed.slice(3, 6).map(e => e.data.meta.browserContext.observation.mode), ["nochange", "nochange", "full"])
  assert.match(JSON.stringify(adapter.requests[2]), /Stable row 0/)
  assert.doesNotMatch(JSON.stringify(adapter.requests[3]), /Stable row 0/)
  assert.match(JSON.stringify(adapter.requests[3]), /Changed row 0/)
  assert.match(JSON.stringify(adapter.requests[3]), /Browser working note: selected item 42/)
  assert.match(JSON.stringify(adapter.requests.at(-1)), /fact: selected item 42/)
  assert.match(JSON.stringify(adapter.requests.at(-1)), /runtime is no longer live/)
  assert.equal(imageCount, 2)
  assert.ok(agent.session.events.some(e => typeof e.surfaceOp === "object"))
  const replay = Session.create(agent.id, JSON.parse(JSON.stringify(agent.session.events)))
  assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages())
  assert.ok(agent.session.events.some(e => e.type === "compaction/prune"), "browser replacements price the old content for host token projections")
  const { logRevision: replayRevision, ...replayMeter } = ctx.tokenMeter.measure(replay)
  const { logRevision: liveRevision, ...liveMeter } = ctx.tokenMeter.measure(agent.session)
  // Revision is a live-object cache key; replay must reproduce prices and nodes.
  assert.deepEqual(replayMeter, liveMeter)
  const breakdown = ctx.sessionProjections.snapshot(agent.session, ["contextBreakdown"]).values.contextBreakdown
  assert.equal(breakdown.messageTokens, agent.session.deriveMessages().reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0))
  const otherAdapter = new ScriptedAdapter([["browser_start", { url: "data:text/html,<title>Independent session</title><h1>Other agent</h1>" }]])
  ctx.llm.registerAdapter(["other"], otherAdapter)
  const other = ctx.agentLoop.create(SessionId("host-browser-other"), { provider: "other", model: "fixture" })
  other.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "Open the other browser" }] }))
  await other.whenIdle()
  assert.equal(otherAdapter.requests.length, 2)
  assert.notEqual(ctx.browserRuntime.getManager(String(other.id)), ctx.browserRuntime.getManager(String(agent.id)))
  await ctx.browserRuntime.cleanupSession(String(agent.id))
  assert.equal(await ctx.browserRuntime.getManager(String(other.id)).getActiveTab().page.title(), "Independent session")
  console.log(JSON.stringify({ status: "success", hostRequests: adapter.totalRequests + otherAdapter.totalRequests, browserOperations: results.length + 1, images: imageCount, replayExact: true, isolatedSessions: true }))
} finally {
  if (disposeBrowser) await disposeBrowser()
  await ctx.fiber.dispose()
}

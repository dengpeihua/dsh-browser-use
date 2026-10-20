import assert from "node:assert/strict"
import test from "node:test"
import { snapshotSession } from "./modern-session-fixture.mjs"
import { EventEmitter } from "node:events"
import { CDPClient, CDPTape, CDPStats, DomService, PageSettleMonitor, replayDomTape } from "../lib/diagnostics.js"
import { apply, BrowserRuntime } from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"

function session(send, children = new Map()) {
  return Object.assign(new EventEmitter(), { send, detach: async () => {}, connection: () => ({ session: id => children.get(id) }) })
}

test("equal backend IDs in different frames keep distinct stable references and interaction history", async () => {
  const client = new CDPClient(session(async () => ({})))
  const service = new DomService({}, client)
  const make = (frameId, id, name = "BUTTON") => ({
    nodeId: id, backendNodeId: id, nodeType: 1, nodeName: name, nodeValue: "", uuid: `${frameId}-${id}`,
    frameId, attributes: { title: frameId }, whitelistedAttributes: { title: frameId }, childrenNodes: [],
    renderInfo: { isVisible: true, isInteractive: true, isTopElement: true, isShadowHost: false, isIframeHost: false, isCandidate: name === "BUTTON" },
  })
  const main = make("main-frame", 42), child = make("child-frame", 42)
  const root = make("main-frame", 1, "BODY")
  root.childrenNodes = [main, child]
  try {
    const first = await service.renderDomTree(root, { highlight: false })
    assert.equal(first.selectorMap.size, 2)
    const mainId = [...first.selectorMap].find(([, node]) => node.frameId === "main-frame")[0]
    const childId = [...first.selectorMap].find(([, node]) => node.frameId === "child-frame")[0]
    assert.notEqual(mainId, childId)
    // Seed the normal snapshot store, then record a child-only operation.
    service.cache.set("fixture", { timestamp: 1, interactions: [] })
    service.recordInteraction(42, "click", undefined, undefined, "child-frame")
    root.childrenNodes.reverse()
    const next = await service.renderDomTree(root, { highlight: false })
    assert.equal(next.selectorMap.get(mainId).frameId, "main-frame")
    assert.equal(next.selectorMap.get(childId).frameId, "child-frame")
    const mainLine = next.html.split("\n").find(line => line.includes("main-frame"))
    const childLine = next.html.split("\n").find(line => line.includes("child-frame"))
    assert.doesNotMatch(mainLine, /clicked|click ×|click x|click@/i)
    assert.match(childLine, /click/i)
  } finally { await service.destroySettle() }
})

test("CDP routing and retries stay in the requested child session and unknown sessions fail closed", async () => {
  let main = 0, child = 0
  const nested = session(async () => { if (++child === 1) throw new Error("temporary"); return "child-result" })
  const client = new CDPClient(session(async () => { main++; return "wrong frame" }, new Map([["child", nested]])))
  const stats = new CDPStats()
  client.setStats(stats)
  try {
    assert.equal(await client.sendCommandWithRetry("Runtime.evaluate", {}, { sessionId: "child", retryDelay: 1 }), "child-result")
    assert.equal(main, 0)
    assert.equal(child, 2)
    assert.equal(stats.totalCalls, 2)
    await assert.rejects(client.sendCommand("Runtime.evaluate", {}, 100, "missing"), /No session/)
    assert.equal(main, 0)
    await client.cleanup()
    await assert.rejects(client.sendCommand("DOM.getDocument"), /closed/)
  } finally { await client.cleanup() }
})

test("element scripts propagate page and transport errors and always release remote objects", async () => {
  for (const transportError of [false, true]) {
    let releases = 0
    const client = new CDPClient(session(async method => {
      if (method === "DOM.resolveNode") return { object: { objectId: "element" } }
      if (method === "Runtime.callFunctionOn") {
        if (transportError) throw new Error("transport failed")
        return { result: {}, exceptionDetails: { exception: { description: "page script failed" } } }
      }
      if (method === "Runtime.releaseObject") releases++
      return {}
    }))
    const service = new DomService({}, client)
    try {
      await assert.rejects(service.executeOnElement({ backendNodeId: 42 }, "function() { throw new Error('page script failed') }"), transportError ? /transport failed/ : /page script failed/)
      assert.equal(releases, 1)
    } finally { await service.destroySettle() }
  }
})

test("CDP timeout records failure while successful commands clean up their timers", async () => {
  const tape = new CDPTape()
  const client = new CDPClient(session(async () => new Promise(() => {})))
  client.setTape(tape, "record")
  try {
    await assert.rejects(client.sendCommand("Runtime.evaluate", {}, 5), /timed out/)
    assert.equal(tape.replay(tape.key("Runtime.evaluate", {})).ok, false)
  } finally { await client.cleanup() }
})

test("CDP tapes key parameters canonically, alias child sessions and replay without sockets", async () => {
  const tape = new CDPTape()
  tape.noteSession("old-session", "target")
  tape.record(tape.key("DOM.getDocument", { depth: -1, pierce: true }, "old-session"), { ok: true, value: { root: "child" } })
  tape.reset()
  tape.noteSession("new-session", "target")
  let live = 0
  const client = new CDPClient(session(async () => { live++; throw new Error("socket") }))
  client.setTape(tape)
  try {
    assert.deepEqual(await client.sendCommand("DOM.getDocument", { pierce: true, depth: -1 }, 100, "new-session"), { root: "child" })
    assert.equal(live, 0)
    await assert.rejects(client.sendCommand("missing"), /no recorded response/)
    assert.equal(tape.misses().length, 1)
  } finally { await client.cleanup() }
})

test("offline pipeline rejects an incomplete tape rather than silently accepting a degraded DOM", async () => {
  await assert.rejects(replayDomTape(new CDPTape()), /no recorded response|Incomplete CDP tape/)
})

test("settle suspension ignores tool DOM writes but still observes network requests", async () => {
  const events = new EventEmitter()
  const monitor = new PageSettleMonitor(events, { quietWindow: 5 })
  try {
    await monitor.waitForSettle(100)
    monitor.suspend()
    events.emit("message", null, "DOM.attributeModified", {})
    assert.equal(monitor.dirty, false)
    events.emit("message", null, "Network.requestWillBeSent", { requestId: "r", type: "Document", request: { url: "https://fixture.test" } })
    assert.equal(monitor.dirty, true)
    monitor.resume()
    events.emit("message", null, "Network.loadingFinished", { requestId: "r" })
    await monitor.waitForSettle(100)
    assert.equal(monitor.dirty, false)
  } finally { monitor.stop() }
})

test("URL notices are session-scoped, deduplicated, clearable and work with snapshot-only hosts", async () => {
  const runtime = new BrowserRuntime({ headless: true, noSandbox: false, viewport: { width: 100, height: 100 }, maxContextDeltas: 8 })
  const first = Session.create(SessionId("one"))
  const other = Session.create(SessionId("two"))
  const manager = runtime.getManager("one")
  let changes = [{ tabId: "tab0", lastUrl: "https://a.test", currentUrl: "https://b.test" }]
  manager.detectStateChanges = () => changes
  try {
    const host = snapshotSession(first)
    runtime.prepareContext(host)
    const length = first.events.length
    runtime.prepareContext(host)
    assert.equal(first.events.length, length)
    assert.match(JSON.stringify(first.deriveMessages()), /browser_observe/)
    runtime.prepareContext(other)
    assert.doesNotMatch(JSON.stringify(other.deriveMessages()), /Browser URL changed/)
    changes = []
    runtime.prepareContext(host)
    assert.match(JSON.stringify(first.deriveMessages()), /notice cleared/)
    assert.doesNotMatch(JSON.stringify(first.deriveMessages()), /https:\/\/b.test/)
  } finally { await runtime.dispose() }
})

test("guide-only calls require no browser approval and observe validates format before touching Chromium", async () => {
  const registered = []
  const context = {
    provide(name, value) { this[name] = value; return () => {} },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    systemPrompt: { section() { return () => {} } }, on() { return () => {} }, get() {},
  }
  const dispose = apply(context, { approvalMode: "mutating" })
  const exec = { agent: { id: "guide", session: Session.create(SessionId("guide")) }, signal: new AbortController().signal }
  try {
    const result = await registered.find(t => t.name === "browser_execute_script").execute({ guide: true }, exec)
    assert.match(result.output, /__data/)
    assert.equal(context.browserRuntime.getManager("guide").hasActiveTab(), false)
    await assert.rejects(registered.find(t => t.name === "browser_observe").execute({ format: "invalid" }, exec), /format.*must/)
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"))
    await assert.rejects(registered.find(t => t.name === "browser_observe").execute({}, { ...exec, signal: aborted.signal }), /cancelled/)
  } finally { await dispose() }
})

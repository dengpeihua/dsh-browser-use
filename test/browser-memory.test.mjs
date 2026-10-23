import test from "node:test"
import assert from "node:assert/strict"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import * as browser from "../lib/index.js"
import { Context } from "@deepseek-ai/cordis"
import SessionStore from "@deepseek-ai/dsh-session"
import { PersistenceCoordinator } from "@deepseek-ai/dsh-session-persistence"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fresh = () => Session.create(SessionId("memory-test"))
function observe(session, name, price, url = `https://shop.test/${name}`, text = `Product ${name}: ${price} yuan`) {
  const domId = `dom${session.seq}`
  const callId = `call${session.seq}`
  const observation = { version: 1, runtimeId: "live", tabId: "tab0", domId, mode: "full", output: text, fullOutput: text, url, title: name, capturedAt: "2026-09-08T00:00:00.000Z" }
  session.append("tool/call", { turn: 1, step: 1, callId, name: "browser_goto", arguments: "{}" })
  const event = session.append("tool/result", {
    turn: 1, step: 1, meta: { browserContext: { version: 1, observation } },
    message: createUserMessage({ source: { kind: "tool", callId }, content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }] }),
  }, { surfaceOp: "append" })
  return { event, observation, text }
}
const review = (o, name, price) => ({ observationId: browser.browserObservationId(o.observation), facts: [{ entity: name, attribute: "price", value: `${price} yuan`, evidence: o.text }] })
const messages = s => JSON.stringify(s.deriveMessages())

test("cross-page prices survive DOM retirement with source URLs and exact evidence", () => {
  assert.equal(typeof browser.recordBrowserFacts, "function", "Host needs a durable fact recording API")
  const s = fresh()
  const a = observe(s, "A", 100)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  const b = observe(s, "B", 200)
  browser.recordBrowserFacts(s, { observations: [review(b, "B", 200)] })
  browser.prepareBrowserContext(s, "live", undefined, browser.readBrowserMemory(s).reviewed)
  browser.prepareBrowserMemory(s)
  assert.doesNotMatch(messages(s), /Product A: 100 yuan/)
  const facts = browser.recallBrowserMemory(s, {}).facts
  assert.deepEqual(facts.map(f => [f.entity, f.value, f.source.url]), [["A", "100 yuan", "https://shop.test/A"], ["B", "200 yuan", "https://shop.test/B"]])
  assert.match(messages(s), /100 yuan/)
  assert.match(messages(s), /200 yuan/)
})

test("unreviewed old observations leave working context but remain recallable", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  observe(s, "B", 200)
  browser.prepareBrowserContext(s, "live")
  assert.doesNotMatch(messages(s), /Product A: 100 yuan/)
  assert.equal(browser.recallBrowserMemory(s, { observationId: browser.browserObservationId(a.observation) }).observation.content, a.text)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  assert.equal(browser.recallBrowserMemory(s, {}).facts[0].value, "100 yuan")
})

test("unsupported quotes, fabricated values and unknown sources fail atomically", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const before = s.events.length
  const good = review(a, "A", 100)
  for (const bad of [
    { ...good, observationId: "unknown" },
    { ...good, facts: [{ ...good.facts[0], evidence: "Product A: 999 yuan" }] },
    { ...good, facts: [{ ...good.facts[0], value: "999 yuan" }] },
    { ...good, facts: [] },
  ]) assert.throws(() => browser.recordBrowserFacts(s, { observations: [good, bad] }))
  assert.equal(s.events.length, before)
})

test("batch evidence errors identify every invalid fact and provide verbatim recovery context", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const good = review(a, "A", 100)
  const before = s.events.length
  const bad = { ...good, facts: [
    { ...good.facts[0], evidence: "A costs one hundred yuan" },
    { ...good.facts[0], entity: "cheapest product", value: "999 yuan" },
  ], reason: "This reason must not bypass invalid facts" }
  assert.throws(() => browser.recordBrowserFacts(s, { observations: [good, bad] }), error => {
    assert.match(error.message, /2 invalid fact\(s\)/)
    assert.match(error.message, /observations\[1\]\.facts\[0\].*\.evidence/)
    assert.match(error.message, /observations\[1\]\.facts\[1\]/)
    assert.match(error.message, /Missing fields: entity, value/)
    assert.ok(error.message.includes(JSON.stringify(a.text)))
    assert.match(error.message, /browser_recall.*"observationId":"obs-/)
    assert.match(error.message, /entire batch is unchanged/)
    return true
  })
  assert.equal(s.events.length, before)
  const recalled = browser.recallBrowserMemory(s, { observationId: good.observationId })
  browser.recordBrowserFacts(s, { observations: [{ ...good, facts: [{ ...good.facts[0], evidence: recalled.observation.content }] }] })
  assert.equal(browser.readBrowserMemory(s).facts.length, 1)
})

test("tool fact records defer until results are committed and survive cold replay", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const before = s.events.length
  const contexts = []
  const result = browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] }, message => contexts.push(message))
  assert.equal(result.recordedFacts, 1)
  assert.equal(s.events.length, before, "tool execution must not insert a user message before its result")
  assert.equal(contexts.length, 1)
  s.append("user/message", contexts[0], { surfaceOp: "append" })
  browser.prepareBrowserMemory(s)
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(s.events)))
  assert.equal(browser.recallBrowserMemory(replay, {}).facts[0].value, "100 yuan")
  assert.equal(browser.readBrowserMemory(replay).reviewed.has(browser.browserObservationId(a.observation)), true)
  assert.throws(() => browser.recordBrowserFacts(s, { observations: [review(a, "A", 999)] }, message => contexts.push(message)))
  assert.equal(contexts.length, 1, "invalid batches must not defer a record")
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] }, message => contexts.push(message))
  assert.equal(contexts.length, 1, "already committed records remain idempotent")
})

test("evidence recovery finds late-page values and preserves markup and source boundaries", () => {
  const s = fresh()
  const text = "x".repeat(13000) + "\n<h1>Product A</h1>\n<span>100 yuan</span>"
  const a = observe(s, "A", 100, undefined, text)
  const good = review(a, "A", 100)
  good.facts[0].evidence = "Product A: 100 yuan"
  assert.throws(() => browser.recordBrowserFacts(s, { observations: [good] }), error => {
    const args = JSON.parse(error.message.match(/browser_recall (\{[^\n]+\})\.\n/)[1])
    assert.ok(args.offset > 12000)
    assert.match(browser.recallBrowserMemory(s, args).observation.content, /<span>100 yuan<\/span>/)
    return true
  })
  browser.recordBrowserFacts(s, { observations: [{ ...good, facts: [{ ...good.facts[0], evidence: "<h1>Product A</h1> <span>100 yuan</span>" }] }] })
  assert.equal(browser.readBrowserMemory(s).facts.length, 1)
})

test("recording old evidence later cannot overwrite a newer price; history remains queryable", () => {
  const s = fresh()
  const a100 = observe(s, "A", 100)
  const a90 = observe(s, "A", 90)
  browser.recordBrowserFacts(s, { observations: [review(a90, "A", 90)] })
  browser.recordBrowserFacts(s, { observations: [review(a100, "A", 100)] })
  assert.deepEqual(browser.recallBrowserMemory(s, {}).facts.map(f => f.value), ["90 yuan"])
  assert.equal(browser.recallBrowserMemory(s, { includeHistory: true }).facts.length, 2)
  const other = observe(s, "A", 80, "https://another-shop.test/A")
  browser.recordBrowserFacts(s, { observations: [review(other, "A", 80)] })
  assert.equal(browser.recallBrowserMemory(s, {}).facts.length, 2, "different vendors keep separate claims")
})

test("generic compaction and session replay restore facts without reviving old tool calls", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  browser.prepareBrowserMemory(s)
  const nodes = [...s.surface.nodes]
  s.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: "test-compactor" }, content: [{ type: "text", text: "Generic summary" }] }), { surfaceOp: { op: "replace", start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes })
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(s.events)))
  browser.prepareBrowserMemory(replay)
  assert.match(messages(replay), /100 yuan/)
  assert.match(messages(replay), /https:\/\/shop.test\/A/)
  const size = replay.events.length
  browser.prepareBrowserMemory(replay)
  assert.equal(replay.events.length, size, "memory projection is idempotent")
  assert.deepEqual(browser.recallBrowserMemory(replay, {}), browser.recallBrowserMemory(s, {}))
})

test("forgotten observations are readable from the archive; irrelevant reviews are explicit", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const id = browser.browserObservationId(a.observation)
  const record = browser.recallBrowserMemory(s, { observationId: id })
  assert.equal(record.observation.content, a.text)
  assert.equal(record.observation.source.url, "https://shop.test/A")
  browser.recordBrowserFacts(s, { observations: [{ observationId: id, facts: [], reason: "This product is outside the user's requested comparison." }] })
  assert.equal(browser.readBrowserMemory(s).reviewed.has(id), true)
  assert.deepEqual(browser.recallBrowserMemory(s, {}).facts, [])
  assert.throws(() => browser.recallBrowserMemory(fresh(), { observationId: id }), /Unknown browser observation/)
})

test("empty fact recording calls direct reads to recall without writing", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  observe(s, "B", 200)
  const before = s.events.length
  assert.throws(() => browser.recordBrowserFacts(s, {}), /browser_recall mode bundles/)
  assert.equal(s.events.length, before)
})

test("observation recall limit is a character window independent of fact pagination", () => {
  const s = fresh()
  const a = observe(s, "A", 100, undefined, "x".repeat(5000))
  const id = browser.browserObservationId(a.observation)
  const first = browser.recallBrowserMemory(s, { observationId: id, limit: 3000 })
  assert.equal(first.observation.content.length, 3000)
  assert.equal(first.nextOffset, 3000)
  const second = browser.recallBrowserMemory(s, { observationId: id, offset: first.nextOffset, limit: 3000 })
  assert.equal(second.observation.content.length, 2000)
  assert.equal(second.nextOffset, null)
  assert.throws(() => browser.recallBrowserMemory(s, { observationId: id, limit: 12001 }), /between 1 and 12000/)
  assert.throws(() => browser.recallBrowserMemory(s, { limit: 31 }), /between 1 and 30/)
})

test("memory output is paginated without deleting old facts and rejects invalid paging", () => {
  const s = fresh()
  for (let i = 0; i < 25; i++) {
    const o = observe(s, `Product${i}`, i)
    browser.recordBrowserFacts(s, { observations: [review(o, `Product${i}`, i)] })
  }
  browser.prepareBrowserMemory(s)
  assert.ok(messages(s).length < 30000)
  assert.equal(browser.recallBrowserMemory(s, { limit: 10 }).nextOffset, 10)
  assert.equal(browser.recallBrowserMemory(s, { offset: 20, limit: 10 }).facts.length, 5)
  assert.equal(browser.recallBrowserMemory(s, { query: "Product0" }).facts.length, 1)
  assert.throws(() => browser.recallBrowserMemory(s, { offset: -1 }))
  assert.throws(() => browser.recallBrowserMemory(s, { limit: 0 }))
  const updated = observe(s, "Product0", 999)
  browser.recordBrowserFacts(s, { observations: [review(updated, "Product0", 999)] })
  browser.prepareBrowserMemory(s)
  const snapshot = s.deriveMessages().find(m => m.source.kind === "dsh-browser:task-memory")
  assert.match(snapshot.content[0].text, /"entity":"Product0".*"value":"999 yuan"/, "updated facts must return to the recent working-memory preview")
})

test("facts survive the real DSH persistence cold-load gate from a disk artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-memory-persistence-"))
  const file = join(directory, "session.json")
  const context = new Context()
  try {
    const s = fresh()
    const a = observe(s, "A", 100)
    browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
    browser.prepareBrowserMemory(s)
    const stored = { meta: { id: s.id, version: 0, createdAt: Date.now() }, events: s.events }
    await writeFile(file, JSON.stringify(stored))
    await context.plugin(SessionStore)
    const load = async () => JSON.parse(await readFile(file, "utf8"))
    const backend = {
      name: "disk-fixture",
      async loadStored(id) { return id === s.id ? { ...await load(), revision: "disk-fixture:1" } : undefined },
      async readStoredRevision(id) { return id === s.id ? "disk-fixture:1" : undefined },
      async appendBatch() { throw new Error("This cold-read fixture must not append") },
      async commitRepair() { throw new Error("Complete fixture needs no repair") },
      async list() { return [stored.meta] },
    }
    const persistence = new PersistenceCoordinator(context, backend)
    const loaded = await persistence.load(s.id)
    const replay = Session.create(s.id, loaded.events)
    assert.equal(browser.recallBrowserMemory(replay, {}).facts[0].value, "100 yuan")
    assert.deepEqual(browser.recallBrowserMemory(replay, {}), browser.recallBrowserMemory(s, {}))
  } finally {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

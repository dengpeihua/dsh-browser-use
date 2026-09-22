import assert from "node:assert/strict"
import { apply } from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"

const registered = []
let savedImages = 0
const attachments = {
  async saveImages(inputs) {
    savedImages += inputs.length
    return inputs.map((input, index) => ({
      attachmentId: `sha256:${String(index + 1).padStart(64, "0")}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 64,
      height: 32,
      name: input.name,
    }))
  },
}
const context = {
  provide(name, value) {
    context[name] = value
    return () => { delete context[name] }
  },
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {
        const index = registered.indexOf(tool)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
  systemPrompt: {
    section() {
      return () => {}
    },
  },
  on() {
    return () => {}
  },
  get(name) {
    return name === "attachments" ? attachments : undefined
  },
  logger: {
    warn(message) {
      process.stderr.write(`${message}\n`)
    },
  },
}

const dispose = apply(context, {
  approvalMode: "off",
  headless: true,
  toolTimeoutMs: 60_000,
})

let sequence = 0
const session = Session.create(SessionId("smoke-session"))
function execution(name) {
  const callId = `smoke-${++sequence}`
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: {},
    agent: { id: "smoke-session", session },
    signal: new AbortController().signal,
    token: Symbol(callId),
    deferContext() {},
    concludeTurn() {},
  }
}

function tool(name) {
  const found = registered.find(item => item.name === name)
  assert.ok(found, `${name} was not registered`)
  return found
}

try {
  const html = encodeURIComponent("<!doctype html><title>DSH Browser Smoke</title><main><h1>ready</h1><button>Continue</button><svg width='64' height='32' aria-label='smoke chart'><rect width='64' height='32' fill='navy'/></svg></main>")
  const started = await tool("browser_start").execute(
    { url: `data:text/html,${html}` },
    execution("browser_start"),
  )
  assert.equal(started.status, "success")
  assert.match(started.output, /DSH Browser Smoke|ready|Navigated to data:/)
  assert.match(started.output, /Match element labels or nearby text, and use DOM indentation/)
  assert.match(started.output, /inspect the updated DOM instead of guessing or reusing stale indices/)
  assert.match(started.output, /Use `browser_reveal_offscreen` with their `\[container:N\]` and optional `target`/)
  assert.match(started.output, /Record important information in your text output before taking actions that change the page/)
  assert.match(started.browserContext.observation.output, /Record any important data \(answers, values, navigation cues\) in your text output now/)
  assert.match(started.browserContext.observation.fullOutput, /Record any important data \(answers, values, navigation cues\) in your text output now/)

  const scripted = await tool("browser_execute_script").execute(
    { script: "return document.title" },
    execution("browser_execute_script"),
  )
  assert.equal(scripted.status, "success")
  assert.match(scripted.output, /DSH Browser Smoke/)
  assert.match(scripted.browserContext.observation.output, /Record any important data \(answers, values, navigation cues\) in your text output now/)

  const viewId = [...started.output.matchAll(/\[view:([^\]]+)\]/g)]
    .map(match => match[1])
    .find(id => id !== "ID")
  assert.ok(viewId, "the SVG should be indexed as a visual element")
  const viewed = await tool("browser_view_elements").execute(
    { viewIds: [viewId] },
    execution("browser_view_elements"),
  )
  assert.equal(viewed.status, "success")
  assert.equal(viewed.images.length, 1)
  assert.equal(viewed.artifacts.length, 1)
  assert.equal(savedImages, 1)

  const opened = await tool("browser_new_tab").execute({}, execution("browser_new_tab"))
  const otherTabId = opened.metadata.tabId
  const originalTabId = started.browserContext.observation.tabId
  for (const tabId of [originalTabId, `tab:${otherTabId}`, `[tab:${originalTabId}]`]) {
    const switched = await tool("browser_switch_tab").execute({ tabId }, execution("browser_switch_tab"))
    assert.equal(switched.status, "success")
    assert.equal(switched.metadata.tabId, tabId.includes(otherTabId) ? otherTabId : originalTabId)
  }
  await assert.rejects(tool("browser_close_tab").execute({ tabIds: [`tab:${otherTabId}`, "tab999"] }, execution("browser_close_tab")), /Tab tab999 not found/)
  assert.ok(context.browserRuntime.getManager("smoke-session").getTab(otherTabId), "invalid batch must not close valid targets")
  const closed = await tool("browser_close_tab").execute({ tabIds: [`[tab:${otherTabId}]`] }, execution("browser_close_tab"))
  assert.equal(closed.status, "success")

  process.stdout.write(JSON.stringify({
    status: "success",
    registeredTools: registered.length,
    startSummary: started.summary,
    scriptSummary: scripted.summary,
    screenshotSummary: viewed.summary,
    persistedImages: savedImages,
    tabMarkerAliases: true,
    invalidCloseBatchPreserved: true,
  }, null, 2) + "\n")
} finally {
  await dispose()
}

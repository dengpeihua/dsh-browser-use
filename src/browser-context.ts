import { appendBrowserEvent } from "./host-compat.js"
/** Host-side context policy: append replayable surface replacements before model requests. */
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"
import { createUserMessage, type Message } from "@deepseek-ai/dsh-llm"
import type {} from "@deepseek-ai/dsh-compaction"
import type { BrowserContextMeta, BrowserObservation } from "./browser-observation.js"
import { browserObservationId, browserSessionEvents } from "./browser-observation.js"
import { TOOL_IDS } from "./tool-schemas.js"

type Result = SessionEvent<"tool/result">
interface Entry { event: Result; meta: BrowserContextMeta; observation?: BrowserObservation }
const RECOVERY_SOURCE = "dsh-browser:recovery"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Metadata is read from durable storage, so unknown versions and malformed records stay untouched. */
function readMeta(value: unknown): BrowserContextMeta | undefined {
  if (!record(value) || !record(value.browserContext)) return
  const meta = value.browserContext
  if (meta.version !== 1) return
  if (meta.observation !== undefined) {
    const o = meta.observation
    if (!record(o) || o.version !== 1 || !["full", "incremental", "nochange"].includes(String(o.mode))) return
    if (![o.runtimeId, o.tabId, o.domId, o.output, o.fullOutput].every(x => typeof x === "string" && x.length > 0)) return
    if (o.mode !== "full" && typeof o.baseDomId !== "string") return
  }
  if ([meta.imageRuntimeId, meta.imageDomId, meta.imageTabId].some(x => x !== undefined && typeof x !== "string")) return
  return meta as unknown as BrowserContextMeta
}

export interface BrowserContextReport {
  replacedResults: number
  removedImages: number
  recoveredBaselines: number
}

/** Only browser-owned observation blocks are changed; actions, errors, facts and raw log remain intact. */
export function prepareBrowserContext(session: Session, runtimeId?: string, estimateMessage?: (message: Message) => number, reviewed?: ReadonlySet<string>): BrowserContextReport {
  const report = { replacedResults: 0, removedImages: 0, recoveredBaselines: 0 }
  // The host's bounded token projections need an adjacent price for every replacement.
  const priceReplacement = (seq: number, message: Message) => {
    if (!estimateMessage) return
    appendBrowserEvent(session, "compaction/prune", {
      shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq],
      shadowedTokenCount: estimateMessage(message),
    })
  }
  const entries: Entry[] = []
  // Current hosts expose snapshots; the pinned 0.1.2 host exposes the events getter.
  const events = browserSessionEvents(session)
  const browserCalls = new Set(events.flatMap(event => event.type === "tool/call" && (TOOL_IDS as readonly string[]).includes(event.data.name) ? [event.data.callId] : []))
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event?.type !== "tool/result") continue
    if (!browserCalls.has(event.data.message.source.callId)) continue
    const meta = readMeta(event.data.meta)
    if (!meta) continue
    let observation = meta.observation
    // Surface rewrites may change content only. Recognize a previously materialized
    // baseline from the recorded fullOutput without rewriting its original metadata.
    if (observation && event.data.message.content[0].content.some(b => b.type === "text" && b.text === observation!.fullOutput)) {
      observation = { ...observation, mode: "full", output: observation.fullOutput }
    }
    entries.push({ event, meta, observation })
  }
  const observations = entries.filter((e): e is Entry & { observation: BrowserObservation } => !!e.observation)
  const latest = observations.at(-1)
  // A whole-history compactor can replace every tool node with a summary. Recover
  // the last logged observation as a new user snapshot, without inventing a tool call.
  const loggedLatest = [...events].reverse().find(event => event.type === "tool/result" && event.surfaceOp === "append"
    && browserCalls.has(event.data.message.source.callId) && readMeta(event.data.meta)?.observation)
  const loggedObservation = loggedLatest?.type === "tool/result" ? readMeta(loggedLatest.data.meta)?.observation : undefined
  const needsSnapshot = loggedObservation && loggedObservation.runtimeId === runtimeId
    && (!latest || latest.observation.runtimeId !== runtimeId || latest.observation.domId !== loggedObservation.domId || latest.observation.tabId !== loggedObservation.tabId)
  const recoveryText = needsSnapshot ? loggedObservation.fullOutput : runtimeId
    ? "[Browser recovery snapshot superseded; use the current browser observation.]"
    : "[Browser runtime is no longer live; call browser_start and observe again before using element references.]"
  const recoveryNodes = session.surface.nodes.flatMap(seq => {
    const e = events[seq]
    return e?.type === "user/message" && e.data.source.kind === "plugin" && e.data.source.plugin === RECOVERY_SOURCE ? [e] : []
  })
  const existingRecovery = recoveryNodes.at(-1)
  if (needsSnapshot || existingRecovery) {
    if (existingRecovery?.data.content.length !== 1 || existingRecovery.data.content[0]?.type !== "text" || existingRecovery.data.content[0].text !== recoveryText) {
      if (existingRecovery) priceReplacement(existingRecovery.seq, existingRecovery.data)
      appendBrowserEvent(session, "user/message", createUserMessage({
        source: { kind: "plugin", plugin: RECOVERY_SOURCE, form: "snapshot", sections: [{ name: "browser-state", text: recoveryText }] },
        content: [{ type: "text", text: recoveryText }],
      }), existingRecovery ? {
        surfaceOp: { op: "replace", start: existingRecovery.seq, end: existingRecovery.seq },
        sourceEventSeqs: [...new Set([existingRecovery.seq, ...(loggedLatest ? [loggedLatest.seq] : [])])],
      } : { surfaceOp: "append", sourceEventSeqs: [loggedLatest!.seq] })
      if (needsSnapshot) report.recoveredBaselines++
    }
  }
  const keep = new Set<Entry>()
  let recover = false
  if (latest && latest.observation.runtimeId === runtimeId) {
    let cursor = latest
    keep.add(cursor)
    recover = !cursor.event.data.message.content[0].content.some(b => b.type === "text" && b.text === cursor.observation.output)
    while (!recover && cursor.observation.mode !== "full") {
      const index = observations.indexOf(cursor)
      const base = observations.slice(0, index).reverse().find(e =>
        e.observation.runtimeId === runtimeId && e.observation.tabId === cursor.observation.tabId
        && e.observation.domId === cursor.observation.baseDomId)
      if (!base || !base.event.data.message.content[0].content.some(b => b.type === "text" && b.text === base.observation.output)) {
        recover = true
        keep.clear()
        keep.add(latest)
        break
      }
      keep.add(base)
      cursor = base
    }
  }
  // Keep only the latest screenshot batch for the current observation, never an old page's image.
  const imageEntry = latest && keep.has(latest) ? [...entries].reverse().find(e =>
    e.meta.imageRuntimeId === runtimeId && e.meta.imageDomId === latest.observation.domId
    && e.meta.imageTabId === latest.observation.tabId
    && e.event.data.message.content[0].content.some(b => b.type === "image")) : undefined

  for (const entry of entries) {
    const { event, observation } = entry
    const result = event.data.message.content[0]
    let changed = false
    let recovered = false
    const content = result.content.map(block => {
      if (block.type === "image" && entry.meta.imageRuntimeId && entry !== imageEntry) {
        changed = true
        report.removedImages++
        return { type: "text" as const, text: "[Older browser image omitted; inspect the current page for visual evidence.]" }
      }
      if (block.type !== "text" || !observation || block.text !== observation.output) return block
      if (entry === latest && recover) {
        changed = true
        recovered = true
        return { ...block, text: observation.fullOutput }
      }
      if (keep.has(entry)) return block
      // The native runtime supplies reviewed IDs. Never silently retire unrecorded task evidence.
      // A dead browser's element references still expire; its raw observation is readable via browser_recall.
      if (reviewed && observation.runtimeId === runtimeId && !reviewed.has(browserObservationId(observation))) return block
      changed = true
      return { ...block, text: `[Browser observation ${observation.tabId}/${observation.domId} omitted. ${runtimeId ? "Use the latest observation and its baseline." : "Browser runtime is no longer live; call browser_start and observe again before using element references."}]` }
    })
    // Another host pruner may already have shortened this exact observation block.
    // Recover without guessing byte ranges or overwriting action/fact text.
    if (entry === latest && recover && !recovered) {
      content.push({ type: "text", text: observation!.fullOutput })
      changed = true
      recovered = true
    }
    if (!changed) continue
    if (recovered) report.recoveredBaselines++
    priceReplacement(event.seq, event.data.message)
    appendBrowserEvent(session, "tool/result", {
      ...event.data,
      message: { ...event.data.message, content: [{ ...result, content }] },
    }, { surfaceOp: { op: "replace", start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] })
    report.replacedResults++
  }
  return report
}

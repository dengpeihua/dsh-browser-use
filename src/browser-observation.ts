import { legacyEvent } from "./host-compat.js"
import { createHash } from "node:crypto"
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"

/** Versioned, replayable browser observations; never infer ownership from page text. */
export interface BrowserObservation {
  version: 1
  runtimeId: string
  tabId: string
  domId: string
  mode: "full" | "incremental" | "nochange"
  baseDomId?: string
  output: string
  /** Complete same-instant observation used when a delta's baseline is no longer visible. */
  fullOutput: string
  url?: string
  title?: string
  capturedAt?: string
  /** Host-generated main-frame visit; survives scrolling and DOM checkpoints. */
  visitId?: string
  /** Bounded, untruncated script return captured before the accompanying DOM. */
  extraction?: unknown
}

export function browserObservationId(observation: Pick<BrowserObservation, "runtimeId" | "tabId" | "domId">): string {
  return `obs-${createHash("sha256").update(JSON.stringify([observation.runtimeId, observation.tabId, observation.domId])).digest("hex").slice(0, 20)}`
}

export function browserSessionEvents(session: Session): readonly SessionEvent[] {
  const reader = session as Session & { snapshotEvents?: () => readonly SessionEvent[] }
  return typeof reader.snapshotEvents === "function" ? reader.snapshotEvents().map(legacyEvent) : session.events
}

export interface BrowserContextMeta {
  version: 1
  observation?: BrowserObservation
  imageRuntimeId?: string
  imageDomId?: string
  imageTabId?: string
}

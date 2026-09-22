/** Host-owned registry: browser instances and context policy share the DSH Session identity. */
import type { Session } from "@deepseek-ai/dsh-session"
import type { Message } from "@deepseek-ai/dsh-llm"
import { BrowserManager, type BrowserLaunchConfig } from "./browser/manager.js"
import { prepareBrowserContext } from "./browser-context.js"
import { prepareBrowserStateNotice } from "./browser-state-notice.js"
import { prepareBrowserMemory } from "./browser-memory.js"

declare module "@deepseek-ai/cordis" {
  interface Context { browserRuntime: BrowserRuntime }
}

export class BrowserRuntime {
  private readonly managers = new Map<string, BrowserManager>()
  private readonly closing = new Map<string, Promise<void>>()
  private disposed = false
  constructor(private readonly launchConfig: BrowserLaunchConfig) {}

  getManager(sessionId: string): BrowserManager {
    if (this.disposed || this.closing.has(sessionId)) throw new Error("Browser runtime is closing")
    let manager = this.managers.get(sessionId)
    if (!manager) {
      manager = new BrowserManager(this.launchConfig)
      this.managers.set(sessionId, manager)
    }
    return manager
  }

  prepareContext(session: Session, estimateMessage?: (message: Message) => number) {
    const manager = this.managers.get(String(session.id))
    const report = prepareBrowserContext(session, manager?.hasActiveTab() ? manager.runtimeId : undefined, estimateMessage)
    prepareBrowserMemory(session, estimateMessage)
    prepareBrowserStateNotice(session, manager, estimateMessage)
    return report
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const pending = this.closing.get(sessionId)
    if (pending) return pending
    const manager = this.managers.get(sessionId)
    if (!manager) return
    const cleanup = manager.cleanup().finally(() => {
      this.managers.delete(sessionId)
      this.closing.delete(sessionId)
    })
    this.closing.set(sessionId, cleanup)
    return cleanup
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([...this.managers.keys()].map(id => this.cleanupSession(id)))
    const errors = results.flatMap(r => r.status === "rejected" ? [r.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Browser runtime cleanup failed")
  }
}

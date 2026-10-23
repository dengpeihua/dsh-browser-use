import type { ContextFormed } from "@deepseek-ai/dsh-llm"

type BrowserSource<K extends string> = { readonly kind: K } & ContextFormed

declare module "@deepseek-ai/dsh-llm/message" {
  interface MessageSourceMap {
    "dsh-browser:recovery": BrowserSource<"dsh-browser:recovery">
    "dsh-browser:evidence-record": BrowserSource<"dsh-browser:evidence-record">
    "dsh-browser:fact-record": BrowserSource<"dsh-browser:fact-record">
    "dsh-browser:task-memory": BrowserSource<"dsh-browser:task-memory">
    "dsh-browser:state-change": BrowserSource<"dsh-browser:state-change">
  }
}

/** Read legacy v3 archives as well as producer-owned v4 sources. New writes use v4. */
export function isBrowserSource(source: { kind: string; plugin?: string }, name: string): boolean {
  return source.kind === name || (source.kind === "plugin" && source.plugin === name)
}

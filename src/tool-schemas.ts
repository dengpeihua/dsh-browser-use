import type { ParameterSchemaSpec, ValueSchemaSpec } from "@deepseek-ai/dsh-tools"

export const BROWSER_TOOL_IDS = [
  "browser_start",
  "browser_goto",
  "browser_refresh",
  "browser_restore_state",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_click",
  "browser_input",
  "browser_reveal_offscreen",
  "browser_scroll_next_screen",
  "browser_scroll_to_page",
  "browser_execute_script",
  "browser_observe",
  "browser_view_elements",
  "browser_wait",
] as const

export const MEMORY_TOOL_IDS = ["browser_recall"] as const
export const TOOL_IDS = [...BROWSER_TOOL_IDS, ...MEMORY_TOOL_IDS] as const

export type BrowserToolId = (typeof TOOL_IDS)[number]

export const PARAMETER_SCHEMAS: Record<BrowserToolId, ParameterSchemaSpec> = {
  browser_start: {
    url: { type: "string", required: true, description: "URL to open in Chromium." },
  },
  browser_goto: {
    url: { type: "string", required: true, description: "URL to navigate the active tab to." },
  },
  browser_refresh: {},
  browser_restore_state: {
    stateId: { type: "string", required: true, description: "Exact checkpoint state ID, including its subversion when present, such as tab0-dom3.2." },
  },
  browser_new_tab: {
    url: { type: "string", description: "Optional URL to open in the new tab." },
  },
  browser_switch_tab: {
    tabId: { type: "string", required: true, description: "Tab ID to activate, e.g. tab1 from [tab:tab1]. The displayed tab:tab1 and [tab:tab1] forms are also accepted." },
  },
  browser_close_tab: {
    tabIds: { type: "array", items: { type: "string" }, description: "Tab IDs to close, e.g. tab1 (also accepts tab:tab1 or [tab:tab1]); omit for the active tab." },
  },
  browser_click: {
    elementIndex: { type: "integer", required: true, description: "Numeric [N] or <N> element marker from the current DOM snapshot." },
    expectText: { type: "string", description: "Optional visible text required after the click; checked for up to 5 seconds." },
    expectUrl: { type: "string", description: "Optional exact final URL required after the click; checked for up to 5 seconds." },
  },
  browser_input: {
    elementIndex: { type: "integer", required: true, description: "Numeric <N> input marker from the current DOM snapshot." },
    text: { type: "string", required: true, description: "Text or value to enter." },
    clear: { type: "boolean", description: "Clear the existing value first; defaults to true." },
    pressEnter: { type: "boolean", description: "Press Enter after input; defaults to false." },
    expectText: { type: "string", description: "Optional visible text required after input; checked for up to 5 seconds." },
    expectUrl: { type: "string", description: "Optional exact final URL required after input; checked for up to 5 seconds." },
  },
  browser_reveal_offscreen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction of the OFF-SCREEN block." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
    target: { type: "string", description: "Optional element/text copied from the OFF-SCREEN block." },
  },
  browser_scroll_next_screen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction to explore." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_scroll_to_page: {
    page: { type: "number", required: true, description: "Target P page position from the scroll map." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_execute_script: {
    script: { type: "string", description: "JavaScript function body executed in the active page; omit to load the guide only." },
    guide: { type: "boolean", description: "Load the extraction guide for structured data and repeating lists." },
  },
  browser_observe: {
    format: { type: "string", enum: ["html", "markdown"], description: "Snapshot representation; defaults to html. Markdown fetches the full accessibility tree." },
  },
  browser_view_elements: {
    viewIds: { type: "array", required: true, items: { type: "string" }, description: "View IDs from [view:ID] markers." },
  },
  browser_wait: {
    seconds: { type: "number", required: true, description: "Seconds to wait before continuing." },
  },
  browser_recall: {
    mode: { type: "string", enum: ["facts", "bundles", "records"], description: "Default facts for older Session memory; bundles lists archived page visits; records reads older source-backed task records." },
    bundleId: { type: "string", description: "Read one archived page visit's observation sources." },
    recordOffset: { type: "integer", description: "With observationId, zero-based structured source-record index." },
    query: { type: "string", description: "With observationId: exact source text to locate in the archived page; otherwise search older saved facts." },
    includeHistory: { type: "boolean", description: "Include earlier observed values as well as current per-source values." },
    observationId: { type: "string", description: "Read an archived page observation after navigation, compaction or browser restart." },
    offset: { type: "integer", description: "Zero-based record offset for facts/unreviewed sources, or character offset when reading an observation." },
    limit: { type: "integer", description: "For facts/unreviewed sources: records per page, 1-30 (default 20). With observationId: characters to return, 1-12000 (default 12000)." },
  },
}

export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", required: true, enum: ["success", "error", "partial"] },
    summary: { type: "string", required: true },
    output: { type: "string", required: true },
    next_actions: { type: "array", required: true, items: { type: "string" } },
    artifacts: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
          media_type: { type: "string", required: true },
        },
      },
    },
    metadata: { type: "json", required: true },
    browserContext: { type: "json" },
    images: { type: "array", required: true, items: { type: "json" } },
  },
} as const satisfies ValueSchemaSpec

import { n as CDPClient, t as DomService } from "./service-7NegKwh5.js";
import "@deepseek-ai/dsh-tools";
import { Message, UserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { CDPSession, Page } from "puppeteer-core";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
//#region src/config.d.ts
type ApprovalMode = "off" | "mutating" | "always";
/** User-configurable browser launch, approval, timeout, and output limits. */
interface Config {
  chromePath?: string;
  headless?: boolean;
  noSandbox?: boolean;
  approvalMode?: ApprovalMode;
  viewportWidth?: number;
  viewportHeight?: number;
  toolTimeoutMs?: number;
  maxWaitSeconds?: number;
  scriptMaxLines?: number;
  scriptMaxBytes?: number;
  outputDir?: string;
  maxContextDeltas?: number;
}
/** Cordis configuration schema exported for DSH config validation and defaults. */
declare const Config: z<Config>;
//#endregion
//#region src/browser-access.d.ts
type AccessProblem = "access_denied" | "captcha" | "network";
/** Deliberately narrow signatures; the word 'captcha' in an ordinary page is not a block. */
declare function detectAccessProblem(text: string): AccessProblem | null;
declare class BrowserAccessGuard {
  private readonly failures;
  private origin;
  check(url?: string): void;
  failed(url: string | undefined, reason: AccessProblem): void;
  succeeded(url?: string): void;
}
/** Read only host-tagged failures, never infer control instructions from arbitrary page prose. */
declare function accessFailureCount(session: Session, turn: number): number;
//#endregion
//#region src/browser-context.d.ts
interface BrowserContextReport {
  replacedResults: number;
  removedImages: number;
  recoveredBaselines: number;
}
/** Only browser-owned observation blocks are changed; actions, errors, facts and raw log remain intact. */
declare function prepareBrowserContext(session: Session, runtimeId?: string, estimateMessage?: (message: Message) => number, reviewed?: ReadonlySet<string>): BrowserContextReport;
//#endregion
//#region src/browser/manager.d.ts
/**
 * Session-scoped Chromium lifecycle manager.
 *
 * Each Session owns one manager, browser, tab map, and serialized action queue.
 * Lazy startup launches Chromium and registers newly opened pages through one
 * deduplicated TabState path. syncActiveTab reconciles cached state with pages
 * the user may have switched or closed manually. Cleanup releases each tab's
 * DOM and CDP resources before closing the owned browser.
 */
interface TabState {
  id: string;
  page: Page;
  cdpSession: CDPSession;
  cdpClient: CDPClient;
  domService: DomService;
  lastDomId?: string;
  contextDeltas?: number;
  visitId?: string;
}
/** Launch settings resolved once by the DSH plugin and fixed for one Session manager. */
interface BrowserLaunchConfig {
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  viewport: {
    width: number;
    height: number;
  };
  maxContextDeltas: number;
}
declare class BrowserManager {
  private readonly launchConfig;
  runtimeId: `${string}-${string}-${string}-${string}-${string}`;
  private browser;
  private tabs;
  private pageRegistrations;
  private activeTabId;
  private tabCounter;
  private pending;
  private chain;
  private cleanupPromise;
  private guideShown;
  constructor(launchConfig: BrowserLaunchConfig);
  /** Bound delta chains with periodic complete observations. */
  get maxContextDeltas(): number;
  /** URL changes only: same-URL DOM edits still require an explicit observation. */
  detectStateChanges(): Array<{
    tabId: string;
    lastUrl: string;
    currentUrl: string;
  }>;
  /** Return true once per DSH Session so the browser usage guide is not repeated on every start. */
  consumeGuide(): boolean;
  /**
   * Delays to start visible Chromium and integrates new tabs that are opened on the page into a single life cycle.
   * Each tab has a stand-alone CDP session, a protocol client and DOM Service to avoid swaggering with citation numbers.
   */
  /**
   * Lazily launch Chromium and install the shared target-created listener.
   * All later tab operations reuse this browser instance and listener registration.
   */
  private ensureBrowser;
  /**
   * Page is for registration, etc.: the event listening and newTab create only one CDPSession/CDPClient/DomService even if it arrives simultaneously.
   */
  private registerPage;
  private findChromePath;
  /**
   * Create and register a tab in this order: Page -> CDP session -> CDPClient -> DomService.
   * When a URL is provided, navigate to it and wait for DOMContentLoaded.
   */
  newTab(url?: string): Promise<TabState>;
  switchTab(tabId: string): Promise<TabState>;
  closeTab(tabId: string): Promise<void>;
  /**
   * Aligns with the real browser front desk state. Users may manually close or switch pages, so the cache activeTabId cannot be trusted until the tool is called.
   * Keep DOM settle listener CDP client Map recorded in the cleanup order to prevent remaining subscriptions to the closed page.
   */
  /**
   * Synchronize tab state before DOM access: remove closed tabs, repair activeTabId,
   * and, when necessary, adopt the currently visible page as the active tab.
   */
  syncActiveTab(): Promise<void>;
  getActiveTab(): TabState;
  getTab(tabId: string): TabState | undefined;
  listTabs(): {
    id: string;
    title: string;
    url: string;
    isActive: boolean;
  }[];
  hasActiveTab(): boolean;
  isStarted(): boolean;
  /**
   * Browser-action guard. Tool calls must pass ensureStarted before executing:
   * - If the browser has not started, fail with an instruction to start it first.
   * - Disconnected: First reset cleanup, then re-enter browser mode.
   */
  ensureStarted(): void;
  private reset;
  /**
   * Serialized browser side effects. The side distribution tool can still line up, but only the tailing tool can generate DOM by isLast() ,
   * The preceding tool returns the position of "delayed extraction", thus avoiding multiple actions based on the same old snapshot repeated extraction and contamination of the context.
   */
  /**
   * Serialize browser actions on a promise chain so concurrent operations cannot corrupt
   * tab or DOM state. The next action starts only after the current one finishes.
   */
  enqueue<T>(fn: (isLast: () => boolean) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Dispose each tab's DOM/CDP resources and close the browser. BrowserRuntime
   * removes the Session entry after this promise settles.
   */
  cleanup(): Promise<void>;
  private cleanupInternal;
}
//#endregion
//#region src/browser-runtime.d.ts
declare module "@deepseek-ai/cordis" {
  interface Context {
    browserRuntime: BrowserRuntime;
  }
}
declare class BrowserRuntime {
  private readonly launchConfig;
  private readonly managers;
  private readonly closing;
  private disposed;
  constructor(launchConfig: BrowserLaunchConfig);
  getManager(sessionId: string): BrowserManager;
  prepareContext(session: Session, estimateMessage?: (message: Message) => number): BrowserContextReport;
  cleanupSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
//#endregion
//#region src/browser-observation.d.ts
/** Versioned, replayable browser observations; never infer ownership from page text. */
interface BrowserObservation {
  version: 1;
  runtimeId: string;
  tabId: string;
  domId: string;
  mode: "full" | "incremental" | "nochange";
  baseDomId?: string;
  output: string;
  /** Complete same-instant observation used when a delta's baseline is no longer visible. */
  fullOutput: string;
  url?: string;
  title?: string;
  capturedAt?: string;
  /** Host-generated main-frame visit; survives scrolling and DOM checkpoints. */
  visitId?: string;
  /** Bounded, untruncated script return captured before the accompanying DOM. */
  extraction?: unknown;
}
declare function browserObservationId(observation: Pick<BrowserObservation, "runtimeId" | "tabId" | "domId">): string;
interface BrowserContextMeta {
  version: 1;
  observation?: BrowserObservation;
  imageRuntimeId?: string;
  imageDomId?: string;
  imageTabId?: string;
}
//#endregion
//#region src/browser-memory.d.ts
interface FactInput {
  entity: string;
  attribute: string;
  value: string;
  evidence: string;
}
interface FactSource {
  observationId: string;
  eventSeq: number;
  url: string;
  title: string;
  capturedAt: string;
}
interface BrowserFact extends FactInput {
  id: string;
  source: FactSource;
}
interface ArchivedObservation {
  id: string;
  observation: BrowserObservation;
  source: FactSource;
}
declare function readBrowserMemory(session: Session): {
  observations: ArchivedObservation[];
  reviewed: Set<string>;
  facts: BrowserFact[];
  history: BrowserFact[];
};
declare function recordBrowserFacts(session: Session, input: unknown, deferContext?: (message: UserMessage) => void): {
  recordedFacts: number;
  reviewedObservations: string[];
};
/** @deprecated Pending observations are archived and advisory; retained for API compatibility. */
declare function guardBrowserMemory(_session: Session): void;
declare function recallBrowserMemory(session: Session, input: unknown): {
  observation: {
    source: FactSource;
    content: string;
    totalChars: number;
  };
  nextOffset: number | null;
  facts?: undefined;
  totalFacts?: undefined;
  observations?: undefined;
  totalUnreviewed?: undefined;
  nextObservationOffset?: undefined;
} | {
  facts: BrowserFact[];
  totalFacts: number;
  nextOffset: number | null;
  observations: FactSource[];
  totalUnreviewed: number;
  nextObservationOffset: number | null;
  observation?: undefined;
};
/** Rebuild a bounded working-memory message even when another host compactor removed its prior projection. */
declare function prepareBrowserMemory(session: Session, estimateMessage?: (message: Message) => number): void;
//#endregion
//#region src/browser-evidence.d.ts
interface EvidenceBundle {
  id: string;
  runtimeId: string;
  tabId: string;
  visitId: string;
  url: string;
  observationIds: string[];
  firstEventSeq: number;
  lastEventSeq: number;
}
type SourceRef = {
  observationId: string;
  recordId: string;
  field: string;
} | {
  observationId: string;
  start: number;
  end: number;
};
interface SourceField {
  name: string;
  value: string | number | boolean | null;
  sourceRef: SourceRef;
}
interface SourceRecord {
  recordId: string;
  fields: SourceField[];
}
/** Group by actual main-frame visit, not URL alone or full-DOM checkpoints. */
declare function evidenceBundles(session: Session): EvidenceBundle[];
/** References address immutable JSON leaves. Never execute a supplied reference. */
declare function observationRecords(session: Session, observationId: string): SourceRecord[];
declare function resolveSourceRef(session: Session, input: unknown): {
  value: string | number | boolean | null;
  sourceRef: SourceRef;
  source: FactSource;
  bundleId: string;
};
interface EvidenceTask {
  mode: "records" | "interaction";
  objective: string;
  requiredFields: string[];
  minRecords: number;
  turn: number;
}
declare function defineEvidenceTask(session: Session, input: unknown, defer?: (m: UserMessage) => void): EvidenceTask;
declare function recordEvidence(session: Session, input: unknown, defer?: (m: UserMessage) => void): {
  recordedRecords: number;
  records: {
    recordId: string;
    fields: {
      value: string | number | boolean | null;
      sourceRef: SourceRef;
      source: FactSource;
      bundleId: string;
      name: string;
    }[];
  }[];
};
declare function taskRecords(session: Session, turn?: number): {
  recordId: string;
  fields: {
    value: string | number | boolean | null;
    sourceRef: SourceRef;
    source: FactSource;
    bundleId: string;
    name: string;
  }[];
}[];
declare function checkEvidenceCoverage(session: Session, turn?: number): {
  status: "partial" | "complete";
  task: EvidenceTask | undefined;
  recordCount: number;
  missing: {
    recordId: string | null;
    field: string;
    reason: string;
  }[];
  scope: string;
};
//#endregion
//#region src/browser-evidence-recall.d.ts
declare function recallEvidence(session: Session, input: Record<string, unknown>): {
  observation: {
    source: FactSource;
    content: string;
    totalChars: number;
  };
  nextOffset: number | null;
  facts?: undefined;
  totalFacts?: undefined;
  observations?: undefined;
  totalUnreviewed?: undefined;
  nextObservationOffset?: undefined;
} | {
  facts: BrowserFact[];
  totalFacts: number;
  nextOffset: number | null;
  observations: FactSource[];
  totalUnreviewed: number;
  nextObservationOffset: number | null;
  observation?: undefined;
} | {
  sourceRecords: SourceRecord[];
  totalSourceRecords: number;
  nextRecordOffset: number | null;
  sourceIndexScope: string;
  sourceSpans?: {
    value: string;
    sourceRef: SourceRef;
  }[] | undefined;
  nextMatchOffset?: number | null | undefined;
  observation: {
    source: FactSource;
    content: string;
    totalChars: number;
  };
  nextOffset: number | null;
  facts?: undefined;
  totalFacts?: undefined;
  observations?: undefined;
  totalUnreviewed?: undefined;
  nextObservationOffset?: undefined;
  bundle?: undefined;
  total?: undefined;
} | {
  sourceRecords: SourceRecord[];
  totalSourceRecords: number;
  nextRecordOffset: number | null;
  sourceIndexScope: string;
  sourceSpans?: {
    value: string;
    sourceRef: SourceRef;
  }[] | undefined;
  nextMatchOffset?: number | null | undefined;
  facts: BrowserFact[];
  totalFacts: number;
  nextOffset: number | null;
  observations: FactSource[];
  totalUnreviewed: number;
  nextObservationOffset: number | null;
  observation?: undefined;
  bundle?: undefined;
  total?: undefined;
} | {
  bundle: {
    observationIds: undefined;
    observationCount: number;
    id: string;
    runtimeId: string;
    tabId: string;
    visitId: string;
    url: string;
    firstEventSeq: number;
    lastEventSeq: number;
  };
  observations: FactSource[];
  nextOffset: number | null;
  total?: undefined;
} | {
  [input.mode]: {
    observationIds: undefined;
    observationCount: number;
    latestObservationId: string | undefined;
    id: string;
    runtimeId: string;
    tabId: string;
    visitId: string;
    url: string;
    firstEventSeq: number;
    lastEventSeq: number;
  }[] | {
    recordId: string;
    fields: {
      value: string | number | boolean | null;
      sourceRef: SourceRef;
      source: FactSource;
      bundleId: string;
      name: string;
    }[];
  }[];
  total: number;
  nextOffset: number | null;
  bundle?: undefined;
  observations?: undefined;
};
//#endregion
//#region src/tool-schemas.d.ts
declare const TOOL_IDS: readonly ["browser_start", "browser_goto", "browser_refresh", "browser_restore_state", "browser_new_tab", "browser_switch_tab", "browser_close_tab", "browser_click", "browser_input", "browser_reveal_offscreen", "browser_scroll_next_screen", "browser_scroll_to_page", "browser_execute_script", "browser_observe", "browser_view_elements", "browser_wait", "browser_recall"];
type BrowserToolId = (typeof TOOL_IDS)[number];
//#endregion
//#region src/browser/operations/start.d.ts
declare const BROWSER_GUIDE = "# Browser Mode\n\nThe DSH browser plugin controls a real Chromium instance isolated to the current Agent Session.\n\n- DOM markers `[N]` are clickable and `<N>` are inputs.\n- Match element labels or nearby text, and use DOM indentation to distinguish parents, children, and siblings; do not choose by marker order alone.\n- Use only markers valid in the current DOM state. After navigation or a changed snapshot, inspect the updated DOM instead of guessing or reusing stale indices.\n- Elements in `=== OFF-SCREEN ... ===` blocks are not currently visible. Use `browser_reveal_offscreen` with their `[container:N]` and optional `target`, then interact using the refreshed DOM.\n- Visual markers `[view:ID]` can be inspected with `browser_view_elements`.\n- Use the container index from `[container:N]` with the scroll tools.\n- The host keeps the current DOM and required baselines while older observations remain recallable from the Session log. Pending archived observations never block browsing.\n- Prefer `browser_click` and `browser_input`; use `browser_execute_script` for targeted inspection.\n- Call `browser_restore_state` with the exact versioned stateId to restore supported form and scroll state. Inspect restoration failures and omissions; arbitrary SPA memory is not restored.\n- Scroll coverage is tied to captured DOM content and layout, not a count of all data items. Dynamic changes invalidate old coverage; record item identities when completeness matters.\n- A successful tool call is not task completion. Click/input accept expectText and expectUrl postconditions; inspect verification metadata, error and partial results before continuing.\n\n## Decision Process\n\n1. Review the user's task and current goal\n2. Analyze the current page DOM to see what elements are available\n3. **Record important information in your text output before taking actions that change the page** — the current DOM snapshot will be replaced after your next action. Any unrecorded data is lost. Write down answers, clues, navigation waypoints, or any useful observations before proceeding.\n4. Prefer targeted actions (filters, sorting, dropdowns) over browsing items one by one\n5. Execute the next action based on your reasoning";
//#endregion
//#region src/index.d.ts
declare const name = "dsh-browser";
declare const inject: string[];
/**
 * Register browser tools and bind Chromium cleanup to Cordis and Session lifecycles.
 * Arrow form keeps Cordis 4 from treating the function plugin as a class constructor.
 */
declare const apply: (ctx: Context, config?: Config) => () => Promise<void>;
//#endregion
export { BROWSER_GUIDE, BrowserAccessGuard, type BrowserContextMeta, type BrowserObservation, type Config as BrowserPluginConfig, Config, BrowserRuntime, type BrowserToolId, TOOL_IDS, accessFailureCount, apply, browserObservationId, checkEvidenceCoverage, defineEvidenceTask, detectAccessProblem, evidenceBundles, guardBrowserMemory, inject, name, observationRecords, prepareBrowserContext, prepareBrowserMemory, readBrowserMemory, recallBrowserMemory, recallEvidence, recordBrowserFacts, recordEvidence, resolveSourceRef, taskRecords };
//# sourceMappingURL=index.d.ts.map
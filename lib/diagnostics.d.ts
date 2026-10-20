import { a as CDPStatRow, i as CDPTapeMiss, n as CDPClient, o as CDPStats, r as CDPTape, t as DomService } from "./service-7NegKwh5.js";
import { Page } from "puppeteer-core";
//#region src/browser/dom/settle-monitor.d.ts
type CdpDebugger = {
  on(event: 'message', listener: (...args: any[]) => void): void;
  off(event: 'message', listener: (...args: any[]) => void): void;
};
interface PageSettleMonitorOptions {
  quietWindow?: number;
  /** OOPIF sessionId is known; Network/DOM listening will be activated immediately upon startup. */
  oopifSessionIds?: string[];
  /** Enables Network and DOM events for initial and subsequent OOPIF sessions. */
  enableOOPIFSession?: (sessionId: string) => Promise<void>;
}
/**
 * Background page level page stability monitor.
 *
 * Key order of implementation:
 * 1. Construct: Tie message listening, register OOPIF and start the first silent meter in a state that is dirty.
 * Event stream:
 * - Target.attachedToTarget (iframe): Enable sub-session listening and reset silent time.
 * - DOM Change event: mark dirty + reset silent timer.
 * - Network.requestWillBeSent: Recording pending requests and reset silent time.
 * - loadingFinished/loadingFailed: Delete the record at the end of the request.
 * - responseReceived: Type of request updated; delete if not critical.
 * 3. onQuiet to point: Call hasCriticalInflight to determine whether critical requests are still being transmitted.
 * - There are still key requests: continue to reset the count (waiting longer silence)
 * - No critical request: Mark clean and notify all waiters.
 * 4. waitForSettle: If currently returned directly clean ; otherwise hang up Promise and wait for clean or timeout to trigger.
 */
declare class PageSettleMonitor {
  private readonly debugger_;
  private dirty;
  private suspended;
  /** Ignore only our synchronous DOM annotations; network activity still counts. */
  suspend(): void;
  resume(): void;
  private inflightRequests;
  private quietTimer;
  private cleanWaiters;
  private readonly onMessageBound;
  private readonly quietWindow;
  private readonly enableOOPIFSession?;
  constructor(debugger_: CdpDebugger, options?: PageSettleMonitorOptions);
  /**
   * Wait for the page to enter clean; or return after timeoutMs (overtime).
   * If clean has been returned immediately.
   */
  waitForSettle(timeoutMs: number): Promise<void>;
  stop(): void;
  private onMessage;
  private hasCriticalInflight;
  private resetTimer;
  private onQuiet;
}
//#endregion
//#region src/diagnostics.d.ts
/** Capture an isolated pipeline baseline, excluding the live Agent's interaction history. */
declare function captureDomTape(page: Page, fullAX?: boolean): Promise<{
  tape: CDPTape;
  result: {
    html: string;
    elementIds: number[];
    stagesMs: {
      extract: number;
      render: number;
      total: number;
    };
  };
  stats: CDPStatRow[];
}>;
/** Uses the same extraction/rendering methods as getPageDom, with live stage timings. */
declare function runDomPipeline(service: DomService, fullAX?: boolean): Promise<{
  html: string;
  elementIds: number[];
  stagesMs: {
    extract: number;
    render: number;
    total: number;
  };
}>;
/** A socket-free replay. Any missing request fails verification, even if production code tolerates it. */
declare function replayDomTape(tape: CDPTape, fullAX?: boolean): Promise<{
  html: string;
  elementIds: number[];
  stagesMs: {
    extract: number;
    render: number;
    total: number;
  };
}>;
//#endregion
export { CDPClient, CDPStats, CDPTape, CDPTapeMiss, DomService, PageSettleMonitor, captureDomTape, replayDomTape, runDomPipeline };
//# sourceMappingURL=diagnostics.d.ts.map
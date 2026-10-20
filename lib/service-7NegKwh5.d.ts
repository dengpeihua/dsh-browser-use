import { EventEmitter } from "events";
import { CDPSession, Page } from "puppeteer-core";
//#region src/browser/cdp/stats.d.ts
/**
 * CDP Call Stats
 *
 * Counts and times CDP commands by method. Used to establish a baseline for
 * round-trip-bound work: replay hides this cost entirely (responses come from
 * memory), so it can only be measured against a live browser.
 *
 * Commands are issued concurrently, so the summed latency exceeds the wall
 * clock of the stage that issued them — read it as "time spent waiting on this
 * method", not as elapsed time.
 */
interface CDPStatRow {
  method: string;
  count: number;
  ms: number;
}
declare class CDPStats {
  private byMethod;
  record(method: string, ms: number): void;
  reset(): void;
  get totalCalls(): number;
  get totalMs(): number;
  /** Rows sorted by time spent, descending. */
  rows(): CDPStatRow[];
}
//#endregion
//#region src/browser/cdp/tape.d.ts
/**
 * CDP Tape
 *
 * Records every CDP request/response pair during a live extraction, then
 * replays them offline so the DOM pipeline runs deterministically without a
 * browser. Used by the DOM regression harness (script/dom-regression.ts) to
 * prove that refactors do not change the extracted DOM.
 *
 * Entries are keyed by (sessionId, method, params) rather than by call order,
 * because the pipeline issues most CDP commands concurrently and the
 * completion order is not stable between runs.
 */
type TapeMode = 'record' | 'replay';
interface TapeResult {
  ok: boolean;
  /** Response payload when ok, error message otherwise */
  value: unknown;
}
declare class CDPTapeMiss extends Error {
  readonly key: string;
  constructor(key: string);
}
declare class CDPTape {
  private data;
  private cursor;
  private missed;
  /** sessionId → targetId, rebuilt from Target.attachToTarget on every run */
  private sessionAlias;
  url: string;
  capturedAt: string;
  /**
   * Chrome hands out a fresh sessionId every time a target is attached, so a
   * raw sessionId in the key would make the tape usable by exactly the run that
   * produced it. Keys use the target the session belongs to instead, which is
   * stable for as long as the page is loaded.
   */
  noteSession(sessionId: string, targetId: string): void;
  key(method: string, params?: Record<string, unknown>, sessionId?: string): string;
  record(key: string, result: TapeResult): void;
  /**
   * Return the next recorded response for a key. Repeated calls past the end of
   * the recorded list reuse the last response — CDP reads here are idempotent,
   * and concurrency can change how often a given key is hit.
   */
  replay(key: string): TapeResult;
  /** Keys that were requested during replay but never recorded. */
  misses(): string[];
  /** Rewind so the tape can be replayed again from the start. */
  reset(): void;
  /**
   * Rewrite every recorded response for one CDP method in place.
   *
   * Used by ablation experiments: strip a field out of a recorded payload to
   * see what the pipeline would produce had the browser never sent it.
   */
  mapResults(method: string, fn: (value: unknown, key: string) => unknown): void;
  get size(): number;
  save(filepath: string): void;
  static load(filepath: string): CDPTape;
}
//#endregion
//#region src/browser/cdp/client.d.ts
interface CDPClientOptions {
  debug?: boolean;
}
/**
 * Adapter that converts Playwright CDPSession per-method events
 * into Electron-style unified 'message' events.
 * Used by PageSettleMonitor which expects `on('message', (event, method, params) => ...)`.
 */
declare class CDPEventBridge extends EventEmitter {
  private session;
  private handlers;
  constructor(session: CDPSession);
  startForwarding(): void;
  stopForwarding(): void;
}
declare class CDPClient {
  private session;
  private debug;
  private eventBridge;
  private closed;
  private tape;
  private stats;
  constructor(session: CDPSession, options?: CDPClientOptions);
  attach(): Promise<void>;
  detach(): Promise<void>;
  /**
   * Attach a record/replay tape. Used by the DOM regression harness only;
   * with no tape set this client behaves exactly as before.
   */
  setTape(tape: CDPTape | null, mode?: TapeMode): void;
  /** Attach a per-method call counter. Diagnostics only; off by default. */
  setStats(stats: CDPStats | null): void;
  sendCommand<T = unknown>(method: string, params?: Record<string, unknown>, timeout?: number, sessionId?: string): Promise<T>;
  /**
   * Resolve the session a command must run in.
   *
   * Out-of-process iframes are attached with flatten:true, which gives each one
   * its own session; puppeteer tracks those on the connection. Commands aimed
   * at a frame have to go through its session — sending them on the page
   * session silently answers for the main frame instead, which is worse than
   * failing, so an unknown sessionId throws.
   */
  private sessionFor;
  private dispatch;
  sendCommandWithRetry<T = unknown>(method: string, params?: Record<string, unknown>, options?: {
    maxRetries?: number;
    retryDelay?: number;
    timeout?: number;
    sessionId?: string;
  }): Promise<T>;
  isDebuggerAttached(): boolean;
  /**
   * Returns the event bridge that emits unified 'message' events.
   * Compatible with settle-monitor's CdpDebugger interface.
   */
  getDebugger(): CDPEventBridge;
  getSession(): CDPSession;
  cleanup(): Promise<void>;
}
//#endregion
//#region src/browser/page-state.d.ts
type Locator = {
  path: string[];
  signature: string;
};
type Field = Locator & {
  value?: string;
  checked?: boolean;
  selected?: string[];
  open?: boolean;
};
type Scroll = Locator & {
  x: number;
  y: number;
};
interface PageCheckpoint {
  url: string;
  fields: Field[];
  scrolls: Scroll[];
  window: {
    x: number;
    y: number;
  };
  omitted: number;
}
//#endregion
//#region src/browser/dom/types/cdp.d.ts
/**
 * Module overview
 * Responsibility: CDP types for converting CDP page data into stable snapshots and model-facing text.
 * Usage: Called for the active tab by the browser manager and observe, interact, and scroll tools; coordinates tree extraction, snapshot caching, stability checks, rendering, and element references.
 * State and failure boundaries: Browser disconnection, frame reconstruction, page instability, and oversized DOMs must all be handled explicitly.
 * Maintenance: Keep CDP nodeId, backendNodeId, and frameId distinct from model-facing elementIndex values; verify adjacent tests and public types after changes.
 *
 * Execute order (run link):
 * The floor (e.g. browser_observe / browser_get_dom / browser_scroll / browser_reveal_offscreen / browser_interact) requests BrowserManager, after which the current Page session will be read from tab to CDP.
 * 2) The tool determines which to call according to needs CDP domain:
 * - To obtain the full document tree, call DOM.getDocument and read the returned DOM.Node hierarchy.
 * - Layout/geometry information required: call DOMSnapshot.captureSnapshot, get DocumentSnapshot, NodeTreeSnapshot and LayoutTreeSnapshot.
 * - Accessible syntax: call Accessibility.getFullAXTree and get role/name/value/properties from AXNode.
 * - Need page sizes and visuals: Call Page.getLayoutMetrics and get contentSize and visual/layout visuals.
 * - Script performance results are required: Call Runtime.evaluate and get RemoteObject+ possible abnormal stacks.
 * - Page cut/window context management: maintain session boundaries by target/attach associated metadata.
 * The browser tool decodes the original structure of CDP by "index table + parallel arrays " :
 * - DOMSnapshot.CaptureSnapshotResponse.documents is a document-level array with a single DocumentSnapshot holding a large number of index arrays (nodeType, nodeName, nodeValue, styles, etc.).
 * - strings Table provides StringIndex-> actual string map (high compression text pool).
 * - Each of the subshots (nodeIndex, parentIndex, layoutIndex, bounds etc.) progresses in an index and must be aligned with the subscripts of the same array.
 * The upstream caller consolidates the decoded structure into an internal DOM model (e.g., visibility, clickability, text box, input box state) and makes a differential/stability judgement compared to the previous snapshot.
 * 5) The final output is modelled by Markdown/TextRenderer to readable description and binds the map relationship between elementIndex (model reference) and the real DOM node reference (backendNodeId/nodeId).
 *
 * Calculate logical elements:
 * - Index Drive is the core: large arrays are not single object arrays, but flat arrays.
 * For example, nodeType [i] corresponds to the logical node i in NodeTreeSnapshot, attributes [i] may be an attribute string indexing list.
 * - The type conversion must be preceded by the identification of fields: DOM, Accessibility, Layout and Runtime data from different categories domain, which, although stated in the same document, cannot be confused with each other.
 * - Under the page instability scene, priority should be given to multi-step snapshots + retry strategy: read layout viewport/scroll information first, confirm the visibility range, then explain the click, input, scrolling command and reduce off-screen/overlap error.
 * - backendNodeId is not the semantic of nodeId calculations: the former is closer to the life-cycle positioning of CDP runtime and the latter is more DOM Query returns; elementIndex is the serialized index on the side of the model.
 * - Options (depth/pierce/timeout/include*) in all domain interface parameters directly affect downstream complexity and stability; too deep or too much switches magnify DOM construction and diff costs.
 *
 * Other Organiser
 * - This document defines only TypeScript types and does not directly execute network requests; real failure retry, reconnection, DOM differential, filtering and rendering are all done at the call end.
 * - Any cross-file modification needs to be synchronized to update the decomposition constraints in the running time code to avoid decode errors due to changes in field name or numbering.
 *
 * DOM Type distinction (mean):
 * - DOMSnapshot: CDP Quickshot of the domain Compressed binary array structure for high performance differential modelling.
 * - DOM: A more intuitive tree structure response that allows for retrieving and fast searching for paternity.
 * - Accessibility: Auxiliary technology tree (role/name/relationship) used for operational extrapolation and model hint noise reduction.
 * - Page: The visual and layout indicators are determined by region and coordinates.
 * - Target: Tab/session target metadata determine which targetId/sessionId to send to.
 * - Runtime: Script execution capability to provide return values, anomalies and stacks to support dynamic reading on page.
 */
declare namespace DOMSnapshot {
  interface CaptureSnapshotParams {
    computedStyles: string[];
    includePaintOrder?: boolean;
    includeDOMRects?: boolean;
    includeBlendedBackgroundColors?: boolean;
    includeTextColorOpacities?: boolean;
  }
  interface RareBooleanData {
    index: number[];
  }
  interface NodeTreeSnapshot {
    parentIndex?: number[];
    nodeType?: number[];
    shadowRootType?: StringIndex[];
    nodeName?: StringIndex[];
    nodeValue?: StringIndex[];
    backendNodeId?: number[];
    attributes?: ArrayOfStrings[];
    textValue?: StringIndex[];
    inputValue?: StringIndex[];
    inputChecked?: RareBooleanData;
    optionSelected?: RareBooleanData;
    contentDocumentIndex?: number[];
    pseudoElementIndexes?: ArrayOfArrayOfIntegers[];
    layoutNodeIndex?: number[];
    isClickable?: RareBooleanData;
    currentSourceURL?: StringIndex[];
    originURL?: StringIndex[];
  }
  interface LayoutTreeSnapshot {
    nodeIndex: number[];
    bounds: number[][];
    text?: StringIndex[];
    paintOrders?: number[];
    offsetRects?: number[][];
    scrollRects?: number[][];
    clientRects?: number[][];
    blendedBackgroundColors?: StringIndex[];
    textColorOpacities?: number[];
    styles?: ArrayOfStrings[];
    stackingContexts?: RareBooleanData;
  }
  interface TextBoxSnapshot {
    layoutIndex: number[];
    bounds: number[][];
    start: number[];
    length: number[];
  }
  interface DocumentSnapshot {
    documentURL: number;
    title: number;
    baseURL: number;
    contentLanguage: number;
    encodingName: number;
    publicId: number;
    systemId: number;
    frameId: number;
    nodes: NodeTreeSnapshot;
    layout: LayoutTreeSnapshot;
    textBoxes: TextBoxSnapshot;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    contentWidth?: number;
    contentHeight?: number;
  }
  interface CaptureSnapshotResponse {
    documents: DocumentSnapshot[];
    strings: string[];
  }
  type StringIndex = number;
  type ArrayOfStrings = StringIndex[];
  type ArrayOfArrayOfIntegers = number[][];
}
declare namespace DOM {
  interface GetDocumentParams {
    depth?: number;
    pierce?: boolean;
  }
  interface Node {
    nodeId: number;
    parentId?: number;
    backendNodeId: number;
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    childNodeCount?: number;
    children?: Node[];
    attributes?: string[];
    documentURL?: string;
    baseURL?: string;
    publicId?: string;
    systemId?: string;
    internalSubset?: string;
    xmlVersion?: string;
    name?: string;
    value?: string;
    contentDocument?: Node;
    shadowRoots?: Node[];
    pseudoElements?: Node[];
    shadowRootType?: "user-agent" | "open" | "closed";
    frameId?: string;
    isSVG?: boolean;
    isScrollable?: boolean;
  }
  interface GetDocumentResponse {
    root: Node;
  }
}
declare namespace Accessibility {
  interface GetFullAXTreeParams {
    depth?: number;
    frameId?: string;
  }
  interface AXNode {
    nodeId: string;
    backendDOMNodeId?: number;
    ignored: boolean;
    ignoredReasons?: AXProperty[];
    role?: AXValue;
    chromeRole?: AXValue;
    name?: AXValue;
    description?: AXValue;
    value?: AXValue;
    properties?: AXProperty[];
    parentId?: string;
    childIds?: string[];
    frameId?: string;
  }
  interface AXProperty {
    name: string;
    value: AXValue;
  }
  interface AXValue {
    type: string;
    value?: any;
    relatedNodes?: AXRelatedNode[];
    sources?: AXValueSource[];
  }
  interface AXRelatedNode {
    backendDOMNodeId: number;
    idref?: string;
    text?: string;
  }
  interface AXValueSource {
    type: string;
    value?: AXValue;
    attribute?: string;
    attributeValue?: AXValue;
    superseded?: boolean;
    nativeSource?: string;
    nativeSourceValue?: AXValue;
    invalid?: boolean;
    invalidReason?: string;
  }
  interface GetFullAXTreeResponse {
    nodes: AXNode[];
  }
}
declare namespace Page$1 {
  interface LayoutViewport {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  }
  interface VisualViewport {
    offsetX: number;
    offsetY: number;
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    scale: number;
    zoom?: number;
  }
  interface CSSVisualViewport {
    offsetX: number;
    offsetY: number;
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    scale: number;
    zoom?: number;
  }
  interface CSSLayoutViewport {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
  }
  interface GetLayoutMetricsResponse {
    layoutViewport: LayoutViewport;
    visualViewport: VisualViewport;
    contentSize: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    cssContentSize?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    cssVisualViewport?: CSSVisualViewport;
    cssLayoutViewport?: CSSLayoutViewport;
  }
  interface FrameTree {
    frame: Frame;
    childFrames?: FrameTree[];
  }
  interface Frame {
    id: string;
    parentId?: string;
    loaderId: string;
    name?: string;
    url: string;
    urlFragment?: string;
    domainAndRegistry?: string;
    securityOrigin: string;
    mimeType: string;
    unreachableUrl?: string;
  }
  interface GetFrameTreeResponse {
    frameTree: FrameTree;
  }
}
declare namespace Target {
  type TargetID = string;
  type SessionID = string;
  interface TargetInfo {
    targetId: TargetID;
    type: string;
    title: string;
    url: string;
    attached: boolean;
    openerId?: TargetID;
    canAccessOpener: boolean;
    openerFrameId?: string;
    browserContextId?: string;
    subtype?: string;
  }
  interface AttachedToTargetEvent {
    sessionId: SessionID;
    targetInfo: TargetInfo;
    waitingForDebugger: boolean;
  }
  interface SetAutoAttachParams {
    autoAttach: boolean;
    waitForDebuggerOnStart: boolean;
    flatten: boolean;
  }
  interface GetFrameOwnerResponse {
    backendNodeId: number;
    nodeId?: number;
  }
}
//#endregion
//#region src/browser/dom/types/ax.d.ts
/**
 * Module overview
 * Responsibility: accessibility types for converting CDP page data into stable snapshots and model-facing text.
 * Usage: Called for the active tab by the browser manager and observe, interact, and scroll tools; coordinates tree extraction, snapshot caching, stability checks, rendering, and element references.
 * State and failure boundaries: Browser disconnection, frame reconstruction, page instability, and oversized DOMs must all be handled explicitly.
 * Maintenance: Keep CDP nodeId, backendNodeId, and frameId distinct from model-facing elementIndex values; verify adjacent tests and public types after changes.
 */
/**
 * Accessibility (AX) Tree Type Definitions
 *
 * Types for accessibility tree data from CDP Accessibility domain.
 */
/**
 * AX property names that are commonly used
 */
type AXPropertyName = 'busy' | 'disabled' | 'editable' | 'focusable' | 'focused' | 'hidden' | 'hiddenRoot' | 'invalid' | 'keyshortcuts' | 'settable' | 'roledescription' | 'live' | 'atomic' | 'relevant' | 'root' | 'autocomplete' | 'hasPopup' | 'level' | 'multiselectable' | 'orientation' | 'multiline' | 'readonly' | 'required' | 'valuemin' | 'valuemax' | 'valuetext' | 'checked' | 'expanded' | 'modal' | 'pressed' | 'selected' | 'activedescendant' | 'controls' | 'describedby' | 'details' | 'errormessage' | 'flowto' | 'labelledby' | 'owns' | 'url' | 'value';
/**
 * Enhanced AX property
 */
interface EnhancedAXProperty {
  name: AXPropertyName;
  value: string | boolean | number | null;
}
/**
 * Enhanced AX node with extracted data
 */
interface EnhancedAXNode {
  axNodeId: string;
  ignored: boolean;
  role?: string;
  name?: string;
  description?: string;
  properties?: EnhancedAXProperty[];
  childIds?: string[];
}
//#endregion
//#region src/browser/dom/types/dom-node.d.ts
/**
 * Node type defined by DOM
 */
declare enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12
}
/**
 * ShadowRoot Type
 */
type ShadowRootType = 'user-agent' | 'open' | 'closed';
/**
 * Rectangular structure (location and dimensions) for recording geometry of elements
 */
interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * DOM, AX and Snapshot enhanced tree festivals Points
 */
interface EnhancedDOMTreeNode {
  nodeId: number;
  backendNodeId: number;
  /** Hit-test targets for ::before/::after belong to their originating element. */
  pseudoElementIds?: number[];
  nodeType: NodeType;
  nodeName: string;
  nodeValue: string;
  attributes: Record<string, string>;
  uuid: string;
  absolutePosition?: DOMRect;
  targetId?: string;
  frameId?: string;
  contentDocument?: EnhancedDOMTreeNode;
  shadowRootType?: ShadowRootType;
  shadowRoots?: EnhancedDOMTreeNode[];
  axNode?: EnhancedAXNode;
  snapshotNode?: EnhancedSnapshotNode;
  whitelistedAttributes?: Record<string, string>;
  renderInfo: RenderInfo;
  boundaryAncestors?: BoundaryAncestor[];
  xpath?: string;
  /** Temporary build-period fields only: written at build stage, ultimately consumed by assignXPaths() */
  _xpathPrefix?: string;
  oopifSessionId?: string;
  parentNode?: EnhancedDOMTreeNode;
  childrenNodes?: EnhancedDOMTreeNode[];
}
/**
 * An ancestor that introduces an iframe or shadow-root boundary.
 */
interface BoundaryAncestor {
  backendNodeId: number;
  type: 'iframe' | 'shadow';
}
/**
 * Rendering information for DOM node
 * Include all properties required to render HTML and to be selected for judgment
 */
interface RenderInfo {
  isVisible: boolean;
  isInteractive: boolean;
  /** Mark isInteractive as the true/false cause of determination */
  interactiveReason?: string;
  isTopElement: boolean;
  isShadowHost: boolean;
  isIframeHost: boolean;
  isCandidate?: boolean;
  isFill?: boolean;
  /** Original control hidden by UI frame (e. g. replace with checkbox/radio style) */
  isVisuallyHiddenNativeControl?: boolean;
  isDuplicateListener?: boolean;
  isListenerHost?: boolean;
  /** Holds candidate backendNodeId for a click tap */
  listenerHostId?: number;
  /** Click to listen to the signature, e. g. native:scriptId:line:col or framework:handler ` */
  clickListenerSignatures?: string[];
  highlightIndex?: number;
  /** The position of the element relative to the mouth in the spread range */
  expandedViewportPosition?: 'above' | 'below' | 'left' | 'right';
  /** Whether or not to be a scrollable container (as judged by the scrollRects/clientRects + overflow rule) */
  isScrollable?: boolean;
  /** Whether or not to be a lateral scrollable container (from subnode extension) */
  isHorizontalScroll?: boolean;
  /** Recent Scrollable ancestor backendNodeId */
  scrollableContainerId?: number;
  /** Are the elements select */
  isSelect?: boolean;
  /** Whether or not to stand for option */
  isSelectOption?: boolean;
  /** Whether this node is recognized as an overlay. */
  isOverlay?: boolean;
  /** Whether this candidate is blocked by an overlay such as a modal or dialog. */
  isBlockedByOverlay?: boolean;
  hitBackendNodeId?: number;
  ancestorBackendIds?: number[];
  /** Debug information: Reason why nodes have been cut ( debug copy tree only set) */
  pruneReason?: string;
  /** Scroll container number of the current extension node */
  scrollContainerIndex?: number;
  /** DOMSpecify the difference in comparison */
  diffStatus?: 'added' | 'removed';
  /** Reasons for variance */
  diffReason?: string;
  /** Anticipated text of the removed node (without sub-trees when rendered) */
  cachedText?: string;
  /** Elements written at HTML line */
  renderedLine?: string;
}
/**
 * Marks in the cache recording the interaction of elements (click/input/select).
 */
interface InteractionRecord {
  frameId?: string;
  backendNodeId: number;
  action: 'click' | 'input' | 'select';
  renderedLine?: string;
  params?: Record<string, unknown>;
  timestamp: number;
}
//#endregion
//#region src/browser/dom/types/snapshot.d.ts
/**
 * Enhanced snapshot node with extracted layout/style data
 */
interface EnhancedSnapshotNode {
  isClickable: boolean;
  cursorStyle?: string;
  bounds?: DOMRect;
  clientRects?: DOMRect;
  scrollRects?: DOMRect;
  computedStyles?: Record<string, string>;
  paintOrder?: number;
  stackingContexts?: number;
  inputValue?: string;
}
/**
 * Data captured from a single OOPIF (cross-origin iframe) session
 */
interface OOPIFTreeData {
  sessionId: string;
  frameId: string;
  frameUrl: string;
  /** backendNodeId of the IFRAME element in the main DOM tree */
  ownerBackendNodeId: number;
  snapshot: DOMSnapshot.CaptureSnapshotResponse;
  domTree: DOM.GetDocumentResponse;
  axTree: Accessibility.GetFullAXTreeResponse;
}
/**
 * All trees fetched from CDP for a target
 */
interface TargetAllTrees {
  snapshot: DOMSnapshot.CaptureSnapshotResponse;
  domTree: DOM.GetDocumentResponse;
  axTree: Accessibility.GetFullAXTreeResponse;
  devicePixelRatio: number;
  /** DOM data from cross-origin iframe sessions */
  oopifTrees?: OOPIFTreeData[];
}
//#endregion
//#region src/browser/cdp/oopif-manager.d.ts
interface OOPIFSession {
  sessionId: string;
  targetInfo: Target.TargetInfo;
  frameId: string;
  frameUrl: string;
  /** The main tree DOM corresponds to IFRAME elements. */
  ownerBackendNodeId: number;
}
declare class OOPIFManager {
  private sessions;
  private cdpClient;
  /** The old sessionId map to the current sessionId; rediscovery with the corresponding host node at ownerBackendNodeId. */
  private sessionIdRemap;
  /**
   * Found and connected to all OOPIF subs target.
   * To ensure that the discovery process is stable, calls Target.getTargets() and Target.attachToTarget () are made on their own initiative;
   * An event-based Target.setAutoAttach does not always have a reliable trigger in Electron.
   *
   * @parammode - tag: buildTree was first discovered and marked with sessionId elements.
   * `remap : Rediscover before interaction, read old tags and create a new sessionId map.
   */
  discoverOOPIFs(cdpClient: CDPClient, mode?: 'tag' | 'remap'): Promise<OOPIFSession[]>;
  private static readonly SESSION_ATTR;
  /**
   * Parsing a newly created pending confirmation session: find its frameId and the corresponding IFRAME host element in the main DOM.
   * The tag mode will write sessionId to iframe properties; the remap mode will read old properties and create a map of the old ID to the new ID.
   * Any failure of a key positioning step returns null, which means that this round ignores OOPIF.
   */
  private resolveSession;
  /**
   * All data found in OOPIF session are collected in parallel.
   * Converts a single OOPIF to null when a single OOPIF fails, filters all failed entries after completion and returns only the successful result.
   */
  captureAllOOPIFTrees(fullAX?: boolean): Promise<OOPIFTreeData[]>;
  /**
   * Separate OOPIF session parallel collection of DOM snapshots, complete DOM trees and AX accessible trees.
   * The snapshot and the tree DOM are key data, and failure will cause the OOPIF to fail as a whole; the AX tree failure is allowed to fall back to an empty node array.
   */
  private captureOOPIFTree;
  /**
   * Send CDP commands to specified OOPIF session.
   * The possibly expired sessionId will be automatically resolved to the current ID by a map sheet before sending.
   */
  sendCommand<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>;
  /**
   * Converts sessionId which may have expired to the current ID; returns as it is when no map is available.
   */
  resolveSessionId(sessionId: string): string;
  /**
   * Returns all session found in the current round and converts it to a new array, avoiding the caller changing the internal Map directly.
   */
  getSessions(): OOPIFSession[];
  /**
   * Check if at least one OOPIF session has been found in this round.
   */
  hasOOPIFs(): boolean;
  /**
   * Check if the manager still holds activity CDPClient, i.e. not completed cleanup.
   */
  isConnected(): boolean;
  /**
   * Cleans up the manager and disconnects the sub target.
   * Cleanup order: detach each child target, clear current sessions, preserve the old-to-new ID remap, and release the CDPClient reference.
   */
  cleanup(): Promise<void>;
}
//#endregion
//#region src/browser/cdp/commands.d.ts
/**
 * DOM command sealer extracted from CDP.
 */
declare class CDPCommands {
  private client;
  constructor(client: CDPClient);
  /**
   * Parallel access to all tree and layout data required for the current page: DOM Snapshot, DOM Tree, AX Accessible Tree and visual indicators.
   * The order of implementation is:
   * Parameters for resolution (maxIframes, timeout, oopifManager);
   * 2) Promise.all and issuing 4 core requests;
   * 3) Crop snapshot.documents to prevent iframe data expansion;
   * 4) Calculate devicePixelRatio based on Page.getLayoutMetrics;
   * assembly TargetAllTrees;
   * 6) Add an extension tree based on OOPIFManager (in case of failure, fallback silently);
   * 7) returns the final result.
   */
  getAllTrees(options?: {
    maxIframes?: number;
    timeout?: number;
    oopifManager?: OOPIFManager;
    fullAX?: boolean;
  }): Promise<TargetAllTrees>;
  /**
   * Catch DOM snapshot.
   * Specifies the calculation style and geometry information you want, and then collects it by retrying the CDP command; the default single timeout 15 seconds, and an additional retry 2 times.
   */
  captureSnapshot(options?: {
    timeout?: number;
  }): Promise<DOMSnapshot.CaptureSnapshotResponse>;
  /**
   * Get the full DOM document tree.
   * depth Defaults -1 for unlimited depth; pierce Defaults true for attempting to penetrate borders such as iframe and shadow root.
   */
  getDocument(options?: {
    depth?: number;
    pierce?: boolean;
    timeout?: number;
  }): Promise<DOM.GetDocumentResponse>;
  /**
   * Access all AX (Accessibility, accessible) trees.
   * In the order of implementation, read frame Tree - > Recursive collection frameId - > Parallel collection of AX Trees - > Merge all nodes.
   * Replace the individual frame with an empty node when the individual frame fails; also return to an empty tree when the whole process fails so that the DOM main process can continue.
   */
  getAccessibilityTreeForAllFrames(options?: {
    timeout?: number;
  }): Promise<Accessibility.GetFullAXTreeResponse>;
  /**
   * Get the frame tree on the page and provide frameId for subsequent frame data.
   */
  getFrameTree(options?: {
    timeout?: number;
  }): Promise<Page$1.GetFrameTreeResponse>;
  /**
   * Acquiring page layout and visual indicators, mainly for device pixels and for top coordinate processing.
   */
  getLayoutMetrics(options?: {
    timeout?: number;
  }): Promise<Page$1.GetLayoutMetricsResponse>;
  /**
   * Computes device pixels based on layout indicators.
   * When both the physical and CSS visions are present and CSS width is greater than 0 return the ratio of the widths, otherwise the security fallback is 1.
   */
  private calculateDevicePixelRatio;
  /**
   * Direct acquisition device pixels: Read layout indicators before computing; return the default value 1 when the query fails, avoiding the interruption of the coordinate conversion process.
   */
  getDevicePixelRatio(): Promise<number>;
  /**
   * Execute the JavaScript expression in the current page context.
   * Default requests CDP to return the result by value; if the response contains exceptionDetails converts the page script abnormally to a visible error by the caller.
   */
  evaluate<T = unknown>(expression: string, options?: {
    returnByValue?: boolean;
    timeout?: number;
  }): Promise<T>;
  /**
   * Copy each select element's current selected text into its value attribute so DOM snapshots record the live selection.
   * This method is called before captureSnapshot; each round of snapshots re-covers these properties.
   */
  injectSelectValues(): Promise<void>;
  /**
   * Syncs the real-time status of input back to the HTML attribute before generating the snapshot.
   * CDP DOMSnapshot captures properties, rather than real time DOM property and therefore requires visible synchronization checked or value.
   */
  injectInputValues(): Promise<void>;
}
//#endregion
//#region src/browser/dom/tree/render-info.d.ts
/**
 * Options for computeRenderInfo
 */
interface ComputeRenderInfoOptions {
  /** Expand viewport range in pages (1 = one viewport height/width) for marking elements outside visible area */
  expand?: number;
  fullAX?: boolean;
}
//#endregion
//#region src/browser/dom/tree/scroll-container.d.ts
/** Maps scroll container index → container node */
type ScrollContainerMap = Map<number, EnhancedDOMTreeNode>;
//#endregion
//#region src/browser/dom/tree/visual-element.d.ts
/** Maps encoded view ID (e.g. "ife") → node for visual top elements */
type VisualElementMap = Map<string, EnhancedDOMTreeNode>;
//#endregion
//#region src/browser/dom/tree/diff.d.ts
/** Controls which diff sides to include in the output tree. */
type DiffShow = 'both' | 'added' | 'removed';
//#endregion
//#region src/browser/dom/tree/highlight.d.ts
type DOMSelectorMap = Map<number, EnhancedDOMTreeNode>;
//#endregion
//#region src/browser/dom/service.d.ts
interface ScrollContainerPages {
  index: number;
  pagesAbove: number;
  pagesBelow: number;
  viewportSize?: number;
  contentSize?: number;
}
type ViewportStats = ScrollContainerPages[];
declare class DomService {
  private client;
  readonly commands: CDPCommands;
  private oopifManager;
  private cache;
  private maxCacheSize;
  private domIdCounter;
  private domSubCounter;
  private lastNavigationUrl;
  private clientRefCount;
  private settleMonitor;
  private settleReady;
  readonly page: Page;
  /**
   * Initialisation order: Save page/client for creating commands and OOPIF manager - > for creating stability monitor -> to enable listening fields by walk.
   * settleReady stores the initialization promise; later acquireClient() calls await it so collection cannot start before monitoring is ready.
   */
  constructor(page: Page, client: CDPClient, maxCacheSize?: number);
  /** Holds a client reference for continuous monitoring and allows the Network and DOM events of the main session. */
  private initSettle;
  /** Stop stability monitoring and release its references; shared CDP resources are disposed only after their final owner releases them. */
  destroySettle(): Promise<void>;
  /**
   * Removes the previous round of model-numbered overlays before collecting new snapshots and avoids miscalculating the tool's own DIV/text node into page increments.
   * Cleanup removes only tool-owned data-hl-idx attributes, overlays, and listeners;
   * it does not alter the page elements referenced by selectorMap.
   */
  cleanupHighlightsBeforeSnapshot(): Promise<void>;
  setPageCheckpoint(domId: string, checkpoint: PageCheckpoint): void;
  getPageCheckpoint(domId: string): PageCheckpoint | undefined;
  getCachedUrl(domId: string): string | undefined;
  captureHistoryEntry(domId: string): Promise<void>;
  /** Return false when Chrome has evicted the entry; the caller then navigates by URL. */
  restoreHistoryEntry(domId: string, signal: AbortSignal): Promise<boolean>;
  getLatestSelectorMap(): DOMSelectorMap | undefined;
  getLatestScrollContainerMap(): ScrollContainerMap;
  getLatestVisualElementMap(): VisualElementMap;
  getLatestExpand(): number | null;
  getScrollContainerNode(index: number): EnhancedDOMTreeNode | undefined;
  scrollToOffscreenElementByIndex(target: string, container: number, direction: 'up' | 'down'): Promise<EnhancedDOMTreeNode | undefined>;
  scrollToPositionByIndex(container: number, x: number, y: number): Promise<void>;
  getScrollInfoByIndex(container: number): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }>;
  /**
   * Finds the outer nodes of the mouth by rendering text in the given scscrolling container and direction.
   * Down to below/right and up to above/left; return the first matching node as soon as found.
   */
  /**
   * In the given scscrolling container and direction, the external nodes of the mouth are found according to renderedLine text.
   * down below/right, up above/left for expandedViewportPosition.
   */
  findOffscreenNodeByRenderedLine(target: string, container: number, direction: 'up' | 'down'): EnhancedDOMTreeNode | undefined;
  /**
   * domId: For continuous snapshots of the same URL, use domN.1, domN.2; URL change the main number to domN + 1.
   */
  generateDomId(): string;
  /**
   * The expression JavaScript is executed by CDP Runtime.evaluate.
   * It must be called within the life cycle of withClient()
   */
  evaluate(expression: string): Promise<void>;
  evaluateWithReturn(expression: string): Promise<any>;
  /**
   * Moves the scrolling container to absolute position by page JavaScript.
   * It must be called within the life cycle of withClient()
   */
  scrollContainerTo(node: EnhancedDOMTreeNode, x: number, y: number): Promise<void>;
  /**
   * CDP query the real-time scrolling position, visual size and full size of the scrolling container.
   * It must be called within the life cycle of withClient()
   */
  getContainerScrollInfo(node: EnhancedDOMTreeNode): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }>;
  /**
   * Click on the coordinates (x, y) by CDP Input.dispatchMouseEvent.
   * Coordinates use CSS pixels relative to the view; the order of execution is to move the mouse, press the left key and release the left key.
   * It must be called within the life cycle of withClient()
   */
  click(x: number, y: number): Promise<void>;
  /**
   * Scroll through the event mouseWheel CDP Input.dispatchMouseEvent.
   * Move the mouse first to (x, y) and then send a scrolling event with deltaX/deltaY.
   * It must be called within the life cycle of withClient()
   */
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  /**
   * Press Enter through CDP Input.dispatchKeyEvent.
   * Simulates the complete button process by keyDown, char and keyUp; it must be called within withClient().
   */
  pressEnter(): Promise<void>;
  /**
   * Scroll the elements to the centre of the view while supporting OOPIF nodes.
   * It must be called within the life cycle of withClient()
   */
  showClickAnnotation(x: number, y: number, type: 'click' | 'input', elementIndex: number): Promise<void>;
  /**
   * Show a camera viewfinder overlay and shutter flash effect for screenshot capture.
   * The rect is in viewport-relative CSS pixels.
   * Must be called within withClient().
   */
  showCaptureAnnotation(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;
  /**
   * Scroll element into view (centered), supports OOPIF.
   * Must be called within withClient().
   */
  scrollToElement(node: EnhancedDOMTreeNode): Promise<void>;
  /**
   * Select one of the original option on the page context DOM API.
   * After selection, dispatch input and change events to synchronize framework state with the native DOM; call this only within withClient().
   */
  selectOption(node: EnhancedDOMTreeNode): Promise<{
    value: string;
    text: string;
    multiple: boolean;
  }>;
  /**
   * Set values for controls that are not suitable for keyboard text, such as range, color, date etc.
   * Original input uses property setter to trigger a response update such as React; ARIA slider is adjusted by a directional event.
   * It must be called within the life cycle of withClient()
   */
  setInputValue(node: EnhancedDOMTreeNode, value: string): Promise<void>;
  /**
   * Gets absolute real-time position of node by CDP DOM.getBoxModel.
   * The calculation is the same as absolutePosition: the boundary of the element in itself frame plus the deviation of the host at each level iframe.
   * It must be called within the life cycle of withClient()
   */
  getElementRect(node: EnhancedDOMTreeNode): Promise<DOMRect>;
  /**
   * truncate the page area by CDP Page.captureScreenshot without scrolling first.
   * clip Use the absolute CSS pixel coordinates of the page instead of the relative coordinates of the mouth of view; they must be called within withClient().
   */
  captureClip(clip: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string>;
  /**
   * Recheck the hit target at the live click position in its owning document.
   * The coordinates are the same as the checkTopElements used to generate the snapshot; they must be called within withClient().
   */
  hitTestAtPoint(node: EnhancedDOMTreeNode, rect?: DOMRect): Promise<boolean>;
  /** Centre of a viewport rect, moved into the main document's coordinates. */
  private toDocumentPoint;
  /**
   * Execute a JS function on the given node, with the element as `this`.
   * Returns the JSON-serializable return value of the function.
   */
  executeOnElement(node: EnhancedDOMTreeNode, functionDeclaration: string): Promise<any>;
  getElementState(node: EnhancedDOMTreeNode): Promise<{
    connected: boolean;
    disabled: boolean;
    readOnly: boolean;
    value: string;
  }>;
  /**
   * All complex operations that require CDP are entered through here: confirm that the main session is available, then find OOPIF and then execute it in the same client context.
   * The caller should not cache the internal session; navigation or cross-domain iframe will refresh the router when rebuilt.
   */
  withClient<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * If OOPIF session has been cleared, rediscover and create old, new sessionId maps as required.
   * All operations CDP commands that need to be sent to the OOPIF node should be called first and must be located in withClient().
   */
  private ensureOOPIF;
  /**
   * Write complete DOM snapshots and associated data such as selector roller containers, visual elements and viewports according to domId.
   */
  setCachedDomTree(domId: string, domTree: EnhancedDOMTreeNode, selectorMap: DOMSelectorMap, scrollContainerMap: ScrollContainerMap, visualElementMap: VisualElementMap, url?: string, viewportStats?: ViewportStats, expand?: number, hasOverlay?: boolean, topElementCount?: number): void;
  /**
   * Record a click or input interaction on the latest cache snapshot.
   * Recording backendNodeId to enable subsequent consumers to track operationally operated elements.
   */
  recordInteraction(backendNodeId: number, action: InteractionRecord['action'], renderedLine?: string, params?: Record<string, unknown>, frameId?: string): void;
  /**
   * Groups cached interactions by owning frame and backendNodeId.
   */
  private collectInteractions;
  /**
   * To build an exploratory progress data for all scrolling containers, which page breaks have been viewed.
   * Scans only caches with the same root backendNodeId.
   * `#` marks previously viewed pages, `>` marks the current viewport, and `_` marks unexplored pages.
   */
  getExplorationBars(domId: string): Map<number, {
    explored: number[];
    current: number[];
    unexplored: number[];
  }> | null;
  /**
   * Builds DOM trees and calculates rendering information; pre-call is assumed to be CDPClient connected.
   * @param options.expand - Widen view range in pages; 1 indicates an outward extension of the view height or width to mark elements outside the visual area.
   */
  extractCurrentDomTree(options?: ComputeRenderInfoOptions): Promise<EnhancedDOMTreeNode>;
  /**
   * Render DOM tree to HTML text, and calculate selectorMap, scrolling container and visual element mapping.
   * Pre-call assumes CDPClient is connected.
   */
  renderDomTree(domTree: EnhancedDOMTreeNode, options?: {
    highlight?: boolean;
    incrementalDiff?: boolean;
  }): Promise<{
    html: string;
    selectorMap: DOMSelectorMap;
    scrollContainerMap: ScrollContainerMap;
    visualElementMap: VisualElementMap;
    hasOverlay: boolean;
    topElementCount: number;
  }>;
  /**
   * The layout indicator is obtained by CDP and the remaining upper and lower ranges of the main page and the scrolling containers are calculated by “pages per page”.
   * It must be called within the life cycle of withClient()
   */
  computeViewportStats(scrollContainerMap: ScrollContainerMap): Promise<ViewportStats>;
  /**
   * Compare two caches DOM with a snapshot and create a difference tree.
   * returns null when the snapshot is missing, or origin is different and can be considered different pages.
   */
  renderMarkdown(domTree: EnhancedDOMTreeNode): string;
  getDiffTree(oldDomId: string, newDomId: string, show?: DiffShow): EnhancedDOMTreeNode | null;
  /**
   * Counts the number of new and deleted elements between the two cache snapshots and their relative proportion to the total number of old and new visible elements.
   */
  getDiffStats(oldDomId: string, newDomId: string, precomputed?: EnhancedDOMTreeNode | null): {
    added: number;
    removed: number;
    addedRatio: number;
    removedRatio: number;
  } | null;
  /**
   * Shared tree construction process: Waiting for page stabilization, synchronizing real-time form status, collecting CDP data and building DOM trees.
   */
  /**
   * Snapshot collection entry point: wait for DOM and network stability, synchronize live
   * form values, then collect CDP data from the main frame and OOPIFs before building the tree.
   * Preserve this order so cross-origin iframe data is complete and current when serialized.
   */
  private buildTree;
  private getSnapshot;
  private setSnapshot;
  /** The LRU phase-out is the longest without access to snapshots, limiting DOM memory in long missions; the old stateId may not recover locally after phase-out. */
  private evictIfNeeded;
}
//#endregion
export { CDPStatRow as a, CDPTapeMiss as i, CDPClient as n, CDPStats as o, CDPTape as r, DomService as t };
//# sourceMappingURL=service-7NegKwh5.d.ts.map
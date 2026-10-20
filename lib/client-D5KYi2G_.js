import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
//#region src/browser/dom/types/dom-node.ts
/**
* Set of HTML tags considered interactive
*/
const INTERACTIVE_TAGS = /* @__PURE__ */ new Set([
	"button",
	"input",
	"select",
	"textarea",
	"a",
	"details",
	"summary",
	"option",
	"optgroup"
]);
/**
* An interactive ARIA role set
*/
const INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
	"button",
	"link",
	"menuitem",
	"option",
	"radio",
	"checkbox",
	"tab",
	"textbox",
	"combobox",
	"slider",
	"spinbutton",
	"searchbox",
	"listbox"
]);
//#endregion
//#region src/browser/dom/tree/clickable-detector.ts
/**
* You need to set value directly by JavaScript instead of the type input that you entered by simulating keyboard text.
* These elements are still filled in controls, but are interactive using <.value = str and dispatching events instead of insertText.
*/
const VALUE_SETTABLE_INPUT_TYPES = /* @__PURE__ */ new Set([
	"range",
	"color",
	"date",
	"time",
	"datetime-local",
	"month",
	"week"
]);
/**
* Shows the event properties of HTML elements that are interactive.
*/
const INTERACTIVE_ATTRIBUTES = /* @__PURE__ */ new Set([
	"onclick",
	"onmousedown",
	"onmouseup",
	"onkeydown",
	"onkeyup"
]);
/**
* Recursively check regular children, shadow roots, and iframe documents for a non-text
* descendant with an explicit cursor. Text nodes are ignored because they are not a more
* specific interactive target.
*/
function hasNonTextDescendantWithCursor(node, cursor) {
	for (const child of node.childrenNodes ?? []) {
		if (child.nodeType !== 3 && child.snapshotNode?.cursorStyle === cursor) return true;
		if (hasNonTextDescendantWithCursor(child, cursor)) return true;
	}
	for (const shadow of node.shadowRoots ?? []) {
		if (shadow.nodeType !== 3 && shadow.snapshotNode?.cursorStyle === cursor) return true;
		if (hasNonTextDescendantWithCursor(shadow, cursor)) return true;
	}
	if (node.contentDocument) {
		if (node.contentDocument.nodeType !== 3 && node.contentDocument.snapshotNode?.cursorStyle === cursor) return true;
		if (hasNonTextDescendantWithCursor(node.contentDocument, cursor)) return true;
	}
	return false;
}
/**
* Recursively inspect regular children, shadow roots, and iframe documents for a descendant
* whose DOMSnapshot data marks it as clickable. This reads snapshotNode.isClickable directly,
* so it does not depend on the order in which descendant renderInfo values are computed.
*/
function hasClickableDescendant(node) {
	for (const child of node.childrenNodes ?? []) {
		if (child.snapshotNode?.isClickable) return true;
		if (hasClickableDescendant(child)) return true;
	}
	for (const shadow of node.shadowRoots ?? []) {
		if (shadow.snapshotNode?.isClickable) return true;
		if (hasClickableDescendant(shadow)) return true;
	}
	if (node.contentDocument) {
		if (node.contentDocument.snapshotNode?.isClickable) return true;
		if (hasClickableDescendant(node.contentDocument)) return true;
	}
	return false;
}
/**
* Interactive element detector.
*/
var ClickableElementDetector = class {
	/**
	* Determines whether the node is interactive or clickable.
	* Each branch returns by a short route of priority and records the reasons for the first hit or rejection through interactiveReason for debugging the interactive rule.
	*/
	static isInteractive(node) {
		const setReason = (reason) => {
			if (node.renderInfo) node.renderInfo.interactiveReason = reason;
		};
		if (node.nodeType !== 1) {
			setReason("not element node");
			return false;
		}
		const tagName = node.nodeName.toLowerCase();
		if (tagName === "html" || tagName === "body") {
			setReason(`skip ${tagName} tag`);
			return false;
		}
		if (node.attributes) {
			if (node.attributes.disabled !== void 0 || node.attributes["aria-disabled"] === "true") {
				setReason("disabled");
				return false;
			}
			if (node.attributes["aria-hidden"] === "true") {
				setReason("aria-hidden");
				return false;
			}
		}
		if (INTERACTIVE_TAGS.has(tagName)) {
			setReason(`interactive tag: ${tagName}`);
			return true;
		}
		if (node.attributes) {
			const matchedAttr = Array.from(INTERACTIVE_ATTRIBUTES).find((attr) => attr in node.attributes);
			if (matchedAttr) {
				setReason(`interactive attribute: ${matchedAttr}`);
				return true;
			}
			const role = node.attributes.role;
			if (role && INTERACTIVE_ROLES.has(role)) {
				setReason(`interactive role: ${role}`);
				return true;
			}
		}
		if (node.snapshotNode?.cursorStyle === "pointer") {
			setReason("cursor: pointer");
			return true;
		}
		if (node.snapshotNode?.cursorStyle === "text") {
			if (!hasNonTextDescendantWithCursor(node, "text")) {
				setReason("cursor: text");
				return true;
			}
		}
		if (node.snapshotNode?.isClickable) {
			if (!hasClickableDescendant(node)) {
				setReason("isClickable");
				return true;
			}
		}
		setReason("no interactive indicators");
		return false;
	}
	/**
	* Determines whether the element can be filled in, i.e. receive text input or directly set values by value.
	* This function determines only the type of control and is not responsible for visibility, disablement, shielding and final candidate numbering.
	*/
	static isFillable(node) {
		if (node.nodeType !== 1) return false;
		const tagName = node.nodeName.toLowerCase();
		if (tagName === "textarea") return true;
		if (tagName === "input") {
			const inputType = (node.attributes?.type ?? "text").toLowerCase();
			return !(/* @__PURE__ */ new Set([
				"button",
				"submit",
				"reset",
				"image",
				"checkbox",
				"radio",
				"file",
				"hidden"
			])).has(inputType);
		}
		if (node.attributes?.role === "slider") return true;
		if (node.attributes?.contenteditable === "true") return true;
		if (node.attributes?.role === "textbox") return true;
		if (node.snapshotNode?.cursorStyle === "text") {
			if (!hasNonTextDescendantWithCursor(node, "text")) return true;
		}
		return false;
	}
};
//#endregion
//#region src/browser/dom/exploration.ts
/** Compare complete captured content, not the viewport-pruned renderer or transient highlight IDs. */
function explorationFingerprint(root) {
	const hash = createHash("sha256");
	const visit = (node) => {
		if (node.attributes?.id === "__elements_highlight_container__") return;
		const attributes = Object.entries(node.attributes ?? {}).filter(([key]) => key !== "data-hl-idx").sort(([a], [b]) => a.localeCompare(b));
		hash.update(JSON.stringify([
			node.frameId,
			node.backendNodeId,
			node.nodeName,
			node.nodeValue,
			attributes
		]));
		for (const child of node.childrenNodes ?? []) visit(child);
		for (const shadow of node.shadowRoots ?? []) visit(shadow);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return hash.digest("hex");
}
//#endregion
//#region src/browser/dom/types/snapshot.ts
/**
* Required computed styles for interactivity and visibility detection
*/
const REQUIRED_COMPUTED_STYLES = [
	"display",
	"visibility",
	"opacity",
	"overflow",
	"overflow-x",
	"overflow-y",
	"cursor",
	"pointer-events",
	"position",
	"background-color",
	"background-image"
];
//#endregion
//#region src/browser/cdp/commands.ts
/**
* DOM command sealer extracted from CDP.
*/
var CDPCommands = class {
	client;
	constructor(client) {
		this.client = client;
	}
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
	async getAllTrees(options) {
		const { maxIframes = 100, timeout = 1e4, oopifManager } = options ?? {};
		const [snapshot, domTree, axTree, metrics] = await Promise.all([
			this.captureSnapshot({ timeout }),
			this.getDocument({ timeout }),
			options?.fullAX ? this.getAccessibilityTreeForAllFrames({ timeout }) : Promise.resolve({ nodes: [] }),
			this.getLayoutMetrics({ timeout })
		]);
		if (snapshot.documents.length > maxIframes) snapshot.documents = snapshot.documents.slice(0, maxIframes);
		const result = {
			snapshot,
			domTree,
			axTree,
			devicePixelRatio: this.calculateDevicePixelRatio(metrics)
		};
		if (oopifManager?.hasOOPIFs()) try {
			result.oopifTrees = await oopifManager.captureAllOOPIFTrees(options?.fullAX);
		} catch (error) {}
		return result;
	}
	/**
	* Catch DOM snapshot.
	* Specifies the calculation style and geometry information you want, and then collects it by retrying the CDP command; the default single timeout 15 seconds, and an additional retry 2 times.
	*/
	async captureSnapshot(options) {
		const params = {
			computedStyles: [...REQUIRED_COMPUTED_STYLES],
			includePaintOrder: true,
			includeDOMRects: true,
			includeBlendedBackgroundColors: false,
			includeTextColorOpacities: false
		};
		return this.client.sendCommandWithRetry("DOMSnapshot.captureSnapshot", params, {
			timeout: options?.timeout ?? 15e3,
			maxRetries: 2
		});
	}
	/**
	* Get the full DOM document tree.
	* depth Defaults -1 for unlimited depth; pierce Defaults true for attempting to penetrate borders such as iframe and shadow root.
	*/
	async getDocument(options) {
		const params = {
			depth: options?.depth ?? -1,
			pierce: options?.pierce ?? true
		};
		return this.client.sendCommand("DOM.getDocument", params, options?.timeout ?? 1e4);
	}
	/**
	* Access all AX (Accessibility, accessible) trees.
	* In the order of implementation, read frame Tree - > Recursive collection frameId - > Parallel collection of AX Trees - > Merge all nodes.
	* Replace the individual frame with an empty node when the individual frame fails; also return to an empty tree when the whole process fails so that the DOM main process can continue.
	*/
	async getAccessibilityTreeForAllFrames(options) {
		try {
			const frameTree = await this.getFrameTree({ timeout: options?.timeout });
			const frameIds = [];
			const collectFrameIds = (node) => {
				if (node.frame?.id) frameIds.push(node.frame.id);
				if (node.childFrames) node.childFrames.forEach(collectFrameIds);
			};
			collectFrameIds(frameTree.frameTree);
			const axTreePromises = frameIds.map((frameId) => this.client.sendCommand("Accessibility.getFullAXTree", { frameId }, options?.timeout ?? 1e4).catch(() => ({ nodes: [] })));
			return { nodes: (await Promise.all(axTreePromises)).flatMap((tree) => tree.nodes) };
		} catch (error) {
			return { nodes: [] };
		}
	}
	/**
	* Get the frame tree on the page and provide frameId for subsequent frame data.
	*/
	async getFrameTree(options) {
		return this.client.sendCommand("Page.getFrameTree", {}, options?.timeout ?? 1e4);
	}
	/**
	* Acquiring page layout and visual indicators, mainly for device pixels and for top coordinate processing.
	*/
	async getLayoutMetrics(options) {
		return this.client.sendCommand("Page.getLayoutMetrics", {}, options?.timeout ?? 1e4);
	}
	/**
	* Computes device pixels based on layout indicators.
	* When both the physical and CSS visions are present and CSS width is greater than 0 return the ratio of the widths, otherwise the security fallback is 1.
	*/
	calculateDevicePixelRatio(metrics) {
		const visualViewport = metrics.visualViewport;
		const cssVisualViewport = metrics.cssVisualViewport;
		if (visualViewport && cssVisualViewport) {
			const deviceWidth = visualViewport.clientWidth;
			const cssWidth = cssVisualViewport.clientWidth;
			if (cssWidth > 0) return deviceWidth / cssWidth;
		}
		return 1;
	}
	/**
	* Direct acquisition device pixels: Read layout indicators before computing; return the default value 1 when the query fails, avoiding the interruption of the coordinate conversion process.
	*/
	async getDevicePixelRatio() {
		try {
			const metrics = await this.getLayoutMetrics();
			return this.calculateDevicePixelRatio(metrics);
		} catch {
			return 1;
		}
	}
	/**
	* Execute the JavaScript expression in the current page context.
	* Default requests CDP to return the result by value; if the response contains exceptionDetails converts the page script abnormally to a visible error by the caller.
	*/
	async evaluate(expression, options) {
		const params = {
			expression,
			returnByValue: options?.returnByValue ?? true
		};
		const response = await this.client.sendCommand("Runtime.evaluate", params, options?.timeout ?? 1e4);
		if (response.exceptionDetails) throw new Error(`[CDP] JavaScript evaluation failed: ${response.exceptionDetails.text}`);
		return response.result.value;
	}
	/**
	* Copy each select element's current selected text into its value attribute so DOM snapshots record the live selection.
	* This method is called before captureSnapshot; each round of snapshots re-covers these properties.
	*/
	async injectSelectValues() {
		try {
			await this.evaluate(`
        document.querySelectorAll('select').forEach(sel => {
          const idx = sel.selectedIndex;
          if (idx >= 0 && sel.options[idx]) {
            sel.setAttribute('value', sel.options[idx].text);
          }
        })
      `);
		} catch {}
	}
	/**
	* Syncs the real-time status of input back to the HTML attribute before generating the snapshot.
	* CDP DOMSnapshot captures properties, rather than real time DOM property and therefore requires visible synchronization checked or value.
	*/
	async injectInputValues() {
		try {
			await this.evaluate(`
        document.querySelectorAll('input').forEach(el => {
          const type = el.type;
          if (type === 'checkbox' || type === 'radio') {
            if (el.checked) el.setAttribute('checked', 'checked');
            else el.removeAttribute('checked');
          } else if (type !== 'file' && type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image') {
            if (el.value !== el.defaultValue) el.setAttribute('value', el.value);
          }
        })
      `);
		} catch {}
	}
};
//#endregion
//#region src/browser/cdp/oopif-manager.ts
var OOPIFManager = class OOPIFManager {
	sessions = /* @__PURE__ */ new Map();
	cdpClient = null;
	/** The old sessionId map to the current sessionId; rediscovery with the corresponding host node at ownerBackendNodeId. */
	sessionIdRemap = /* @__PURE__ */ new Map();
	/**
	* Found and connected to all OOPIF subs target.
	* To ensure that the discovery process is stable, calls Target.getTargets() and Target.attachToTarget () are made on their own initiative;
	* An event-based Target.setAutoAttach does not always have a reliable trigger in Electron.
	*
	* @parammode - tag: buildTree was first discovered and marked with sessionId elements.
	* `remap : Rediscover before interaction, read old tags and create a new sessionId map.
	*/
	async discoverOOPIFs(cdpClient, mode = "tag") {
		this.cdpClient = cdpClient;
		this.sessions.clear();
		try {
			const { targetInfos } = await cdpClient.sendCommand("Target.getTargets");
			const iframeTargets = targetInfos.filter((t) => t.type === "iframe");
			if (iframeTargets.length === 0) return [];
			for (const targetInfo of iframeTargets) try {
				const { sessionId } = await cdpClient.sendCommand("Target.attachToTarget", {
					targetId: targetInfo.targetId,
					flatten: true
				});
				const session = await this.resolveSession(cdpClient, sessionId, targetInfo, mode);
				if (session) this.sessions.set(session.sessionId, session);
			} catch (error) {}
			return [...this.sessions.values()];
		} catch (error) {
			return [];
		}
	}
	static SESSION_ATTR = "data-oopif-session";
	/**
	* Parsing a newly created pending confirmation session: find its frameId and the corresponding IFRAME host element in the main DOM.
	* The tag mode will write sessionId to iframe properties; the remap mode will read old properties and create a map of the old ID to the new ID.
	* Any failure of a key positioning step returns null, which means that this round ignores OOPIF.
	*/
	async resolveSession(cdpClient, sessionId, targetInfo, mode) {
		let frameId;
		try {
			frameId = (await cdpClient.sendCommand("Page.getFrameTree", {}, 5e3, sessionId)).frameTree.frame.id;
		} catch {
			return null;
		}
		let ownerBackendNodeId;
		try {
			ownerBackendNodeId = (await cdpClient.sendCommand("DOM.getFrameOwner", { frameId })).backendNodeId;
		} catch {
			return null;
		}
		try {
			const { object } = await cdpClient.sendCommand("DOM.resolveNode", { backendNodeId: ownerBackendNodeId });
			if (mode === "tag") await cdpClient.sendCommand("Runtime.callFunctionOn", {
				objectId: object.objectId,
				functionDeclaration: `function(attr, id) { this.setAttribute(attr, id); }`,
				arguments: [{ value: OOPIFManager.SESSION_ATTR }, { value: sessionId }],
				returnByValue: true
			});
			else {
				const oldSessionId = (await cdpClient.sendCommand("Runtime.callFunctionOn", {
					objectId: object.objectId,
					functionDeclaration: `function(attr) { return this.getAttribute(attr); }`,
					arguments: [{ value: OOPIFManager.SESSION_ATTR }],
					returnByValue: true
				})).result?.value;
				if (oldSessionId && oldSessionId !== sessionId) this.sessionIdRemap.set(oldSessionId, sessionId);
			}
			await cdpClient.sendCommand("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
		} catch {}
		return {
			sessionId,
			targetInfo,
			frameId,
			frameUrl: targetInfo.url,
			ownerBackendNodeId
		};
	}
	/**
	* All data found in OOPIF session are collected in parallel.
	* Converts a single OOPIF to null when a single OOPIF fails, filters all failed entries after completion and returns only the successful result.
	*/
	async captureAllOOPIFTrees(fullAX = false) {
		if (!this.cdpClient || this.sessions.size === 0) return [];
		return (await Promise.all([...this.sessions.values()].map((session) => this.captureOOPIFTree(session, fullAX).catch(() => {
			return null;
		})))).filter((r) => r !== null);
	}
	/**
	* Separate OOPIF session parallel collection of DOM snapshots, complete DOM trees and AX accessible trees.
	* The snapshot and the tree DOM are key data, and failure will cause the OOPIF to fail as a whole; the AX tree failure is allowed to fall back to an empty node array.
	*/
	async captureOOPIFTree(session, fullAX) {
		const cdpClient = this.cdpClient;
		const { sessionId } = session;
		const [snapshot, domTree, axTree] = await Promise.all([
			cdpClient.sendCommandWithRetry("DOMSnapshot.captureSnapshot", {
				computedStyles: [...REQUIRED_COMPUTED_STYLES],
				includePaintOrder: true,
				includeDOMRects: true,
				includeBlendedBackgroundColors: false,
				includeTextColorOpacities: false
			}, {
				timeout: 1e4,
				maxRetries: 1,
				sessionId
			}),
			cdpClient.sendCommand("DOM.getDocument", {
				depth: -1,
				pierce: true
			}, 1e4, sessionId),
			fullAX ? cdpClient.sendCommand("Accessibility.getFullAXTree", {}, 1e4, sessionId).catch(() => ({ nodes: [] })) : Promise.resolve({ nodes: [] })
		]);
		return {
			sessionId: session.sessionId,
			frameId: session.frameId,
			frameUrl: session.frameUrl,
			ownerBackendNodeId: session.ownerBackendNodeId,
			snapshot,
			domTree,
			axTree
		};
	}
	/**
	* Send CDP commands to specified OOPIF session.
	* The possibly expired sessionId will be automatically resolved to the current ID by a map sheet before sending.
	*/
	async sendCommand(sessionId, method, params, timeout = 1e4) {
		if (!this.cdpClient) throw new Error("[OOPIF] Manager not initialized");
		const resolvedId = this.resolveSessionId(sessionId);
		return this.cdpClient.sendCommand(method, params, timeout, resolvedId);
	}
	/**
	* Converts sessionId which may have expired to the current ID; returns as it is when no map is available.
	*/
	resolveSessionId(sessionId) {
		return this.sessionIdRemap.get(sessionId) ?? sessionId;
	}
	/**
	* Returns all session found in the current round and converts it to a new array, avoiding the caller changing the internal Map directly.
	*/
	getSessions() {
		return [...this.sessions.values()];
	}
	/**
	* Check if at least one OOPIF session has been found in this round.
	*/
	hasOOPIFs() {
		return this.sessions.size > 0;
	}
	/**
	* Check if the manager still holds activity CDPClient, i.e. not completed cleanup.
	*/
	isConnected() {
		return this.cdpClient !== null;
	}
	/**
	* Cleans up the manager and disconnects the sub target.
	* Cleanup order: detach each child target, clear current sessions, preserve the old-to-new ID remap, and release the CDPClient reference.
	*/
	async cleanup() {
		if (this.cdpClient) for (const [sessionId] of this.sessions) try {
			await this.cdpClient.sendCommand("Target.detachFromTarget", { sessionId });
		} catch {}
		this.sessions.clear();
		this.cdpClient = null;
	}
};
//#endregion
//#region src/browser/dom/utils/index.ts
/**
* Module overview
* Responsibility: Convert CDP page data to stabilize DOM snapshots, query results and text suitable for model consumption; public entry and export boundary for this document to focus on the current directory.
* Usage: Called for the active tab by browser manager and tools such as observe, interact and scroll; coordinated DOM tree, snapshot cache, stability detection, Markdown rendering and element reference resolution.
* State and failure boundaries: The browser is disconnected, the frame reconstruction, the page instability and the oversized DOM must all be handled explicitly.
* Maintenance: Do not mix CDP nodeId, backendNodeId and frameId with elementIndex as seen in the model; check the adjacent tests and public types after making changes.
*/
/**
* Utils Module - Unified Exports
*
* Utility functions for DOM processing.
*/
const DEBUG_FOLDER = path.join(os.homedir(), "Desktop", "dom_debug");
/** Encode backendNodeId to alpha string: 841 → "ife" */
function encodeViewId(id) {
	return id.toString().split("").map((d) => String.fromCharCode(97 + +d)).join("");
}
/** Top-level visual/structural elements: kept when isTopElement */
const VISUAL_TOP_TAGS = /* @__PURE__ */ new Set([
	"svg",
	"img",
	"table",
	"dl",
	"pre",
	"figure",
	"details",
	"math",
	"canvas",
	"video",
	"audio",
	"picture",
	"object",
	"embed",
	"meter",
	"progress"
]);
/** Visual ARIA roles: elements with these roles are preserved from pruning */
const VISUAL_ROLES = /* @__PURE__ */ new Set([
	"img",
	"graphics-document",
	"graphics-symbol",
	"meter",
	"progressbar",
	"figure",
	"math"
]);
/** Check if node is a visual top element by tag name, ARIA role, or CSS background-image */
function isVisualTopNode(node) {
	const tagName = node.nodeName.toLowerCase();
	if (VISUAL_TOP_TAGS.has(tagName)) return true;
	const role = node.attributes?.role;
	if (role && VISUAL_ROLES.has(role)) return true;
	const bgImage = node.snapshotNode?.computedStyles?.["background-image"];
	if (bgImage && bgImage !== "none" && node.renderInfo?.isTopElement) return true;
	return false;
}
/** Check if node is a visual element that renders separately (requires isTopElement) */
function isVisualElement(node) {
	if (!node.renderInfo?.isTopElement) return false;
	return isVisualTopNode(node) || STRUCTURAL_CHILD_TAGS.has(node.nodeName.toLowerCase());
}
/** Child structural tags: always kept (only exist inside their parent visual element) */
const STRUCTURAL_CHILD_TAGS = /* @__PURE__ */ new Set([
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"colgroup",
	"col",
	"dt",
	"dd",
	"figcaption",
	"summary",
	"code"
]);
/**
* Save debug JSON (removes circular references)
*/
function saveDebugJson(filename, data) {
	if (!process.env.DOM_DEBUG_SAVE) return;
	try {
		if (!fs.existsSync(DEBUG_FOLDER)) fs.mkdirSync(DEBUG_FOLDER, { recursive: true });
		const filepath = path.join(DEBUG_FOLDER, filename);
		const seen = /* @__PURE__ */ new WeakSet();
		const json = JSON.stringify(data, (key, value) => {
			if (key === "parentNode" || key === "originalNode") return;
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		}, 2);
		fs.writeFileSync(filepath, json, "utf-8");
	} catch (error) {}
}
/**
* Generate UUID v4
*/
function generateUUID() {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		return (c === "x" ? r : r & 3 | 8).toString(16);
	});
}
/**
* Deep clone an object
*/
function deepClone(obj) {
	if (obj === null || typeof obj !== "object") return obj;
	if (obj instanceof Date) return new Date(obj.getTime());
	if (obj instanceof Array) return obj.map((item) => deepClone(item));
	if (obj instanceof Map) return new Map(Array.from(obj.entries()).map(([k, v]) => [deepClone(k), deepClone(v)]));
	if (obj instanceof Set) return new Set(Array.from(obj).map((item) => deepClone(item)));
	const clonedObj = {};
	for (const key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) clonedObj[key] = deepClone(obj[key]);
	return clonedObj;
}
/**
* Deep-copy a DOM tree for prune debugging.
* Skips parentNode to avoid circular refs, rebuilds parent links on the copy.
* Returns the copied root and a backendNodeId → copied node lookup map.
*/
function copyDomTree(root) {
	const lookup = /* @__PURE__ */ new Map();
	function clone(node, parent) {
		const copy = {
			...node,
			renderInfo: { ...node.renderInfo },
			parentNode: parent,
			childrenNodes: [],
			shadowRoots: void 0,
			contentDocument: void 0
		};
		if (node.axNode) copy.axNode = { ...node.axNode };
		if (node.whitelistedAttributes) copy.whitelistedAttributes = { ...node.whitelistedAttributes };
		if (node.attributes) copy.attributes = { ...node.attributes };
		lookup.set(copy.backendNodeId, copy);
		copy.childrenNodes = (node.childrenNodes ?? []).map((c) => clone(c, copy));
		if (node.shadowRoots) copy.shadowRoots = node.shadowRoots.map((sr) => clone(sr, copy));
		if (node.contentDocument) copy.contentDocument = clone(node.contentDocument, copy);
		return copy;
	}
	return {
		copy: clone(root),
		lookup
	};
}
/**
* Mark a node in the debug copy tree with a prune reason.
*/
function markPruneReason(lookup, node, reason) {
	const record = lookup.get(nodeKey(node));
	if (record) record.renderInfo.pruneReason = record.renderInfo.pruneReason ? `${record.renderInfo.pruneReason} | ${reason}` : reason;
}
/**
* Composite key for cross-OOPIF unique identity.
* backendNodeId is only unique within a CDP session; different OOPIFs can overlap.
* Uses frameId (stable across CDP re-attachments) instead of oopifSessionId.
*/
function nodeKey(node) {
	return `${node.frameId ?? ""}:${node.backendNodeId}`;
}
/**
* Build a lookup map from composite nodeKey to node (OOPIF-safe).
*/
function buildNodeKeyLookup(root) {
	const lookup = /* @__PURE__ */ new Map();
	const visit = (node) => {
		lookup.set(nodeKey(node), node);
		for (const child of node.childrenNodes ?? []) visit(child);
		for (const shadow of node.shadowRoots ?? []) visit(shadow);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return lookup;
}
/**
* Flatten nested DOM tree into a flat array.
* Each node includes ancestorBackendNodeIds, childrenBackendNodeIds (direct only),
* ancestorBoundaries tracking shadow/iframe crossings, and full xpath from the node.
*/
function flattenDomTree(root) {
	const result = [];
	const visit = (node, ancestors, boundaries) => {
		const childrenBackendNodeIds = [];
		for (const child of node.childrenNodes ?? []) childrenBackendNodeIds.push(child.backendNodeId);
		const shadowRootBackendNodeIds = [];
		for (const shadow of node.shadowRoots ?? []) shadowRootBackendNodeIds.push(shadow.backendNodeId);
		const contentDocumentBackendNodeId = node.contentDocument?.backendNodeId ?? null;
		const { parentNode, childrenNodes, shadowRoots, contentDocument, ...serializable } = node;
		const flatNode = {
			...deepClone(serializable),
			ancestorBackendNodeIds: [...ancestors],
			childrenBackendNodeIds,
			shadowRootBackendNodeIds,
			contentDocumentBackendNodeId,
			ancestorBoundaries: boundaries.map((b) => ({ ...b }))
		};
		result.push(flatNode);
		const nextAncestors = [...ancestors, node.backendNodeId];
		for (const child of node.childrenNodes ?? []) visit(child, nextAncestors, boundaries);
		for (const shadow of node.shadowRoots ?? []) visit(shadow, nextAncestors, [...boundaries, {
			type: "shadowRoot",
			hostBackendNodeId: node.backendNodeId
		}]);
		if (node.contentDocument) visit(node.contentDocument, nextAncestors, [...boundaries, {
			type: "contentDocument",
			hostBackendNodeId: node.backendNodeId
		}]);
	};
	visit(root, [], []);
	return result;
}
/**
* Render enhanced DOM tree as a minimal debug HTML string.
* Each element shows [backendNodeId]<tag>, text nodes show their nodeValue.
*/
function renderDebugHtml(root) {
	const INDENT = "  ";
	const render = (node, depth) => {
		const pad = INDENT.repeat(depth);
		const lines = [];
		if (node.nodeType === 3) {
			const text = node.nodeValue.trim();
			if (text) {
				const inlineTag = node.snapshotNode?.computedStyles?.display === "inline" ? " [inline]" : "";
				lines.push(`${pad}[${node.backendNodeId}] "${text}"${inlineTag}`);
			}
			return lines.join("\n");
		}
		const tag = node.nodeName.toLowerCase();
		const inlineTag = node.snapshotNode?.computedStyles?.display === "inline" ? " [inline]" : "";
		const childLines = [];
		for (const child of node.childrenNodes ?? []) {
			const s = render(child, depth + 1);
			if (s) childLines.push(s);
		}
		for (const shadow of node.shadowRoots ?? []) {
			childLines.push(`${INDENT.repeat(depth + 1)}#shadow-root`);
			const s = render(shadow, depth + 2);
			if (s) childLines.push(s);
		}
		if (node.contentDocument) {
			childLines.push(`${INDENT.repeat(depth + 1)}#document (iframe)`);
			const s = render(node.contentDocument, depth + 2);
			if (s) childLines.push(s);
		}
		if (childLines.length > 0) {
			lines.push(`${pad}[${node.backendNodeId}] <${tag}>${inlineTag}`);
			lines.push(...childLines);
			lines.push(`${pad}</${tag}>`);
		} else lines.push(`${pad}[${node.backendNodeId}] <${tag} />${inlineTag}`);
		return lines.join("\n");
	};
	return render(root, 0);
}
/**
* Save debug HTML structure to dom_debug folder
*/
function saveDebugHtml(filename, root) {
	if (!process.env.DOM_DEBUG_SAVE) return;
	try {
		if (!fs.existsSync(DEBUG_FOLDER)) fs.mkdirSync(DEBUG_FOLDER, { recursive: true });
		const filepath = path.join(DEBUG_FOLDER, filename);
		fs.writeFileSync(filepath, renderDebugHtml(root), "utf-8");
	} catch (error) {}
}
//#endregion
//#region src/browser/dom/tree/xpath.ts
/**
* Generate XPath for a DOM node
*
* Stops at shadow boundaries or iframes.
*/
function generateXPath(node) {
	const segments = [];
	let current = node;
	while (current) {
		if (current.nodeType === 9 || current.nodeType === 11) break;
		if (current.nodeType === 1) {
			const position = getElementPosition(current);
			const tagName = current.nodeName.toLowerCase();
			const xpathIndex = position > 0 ? `[${position}]` : "";
			segments.unshift(`${tagName}${xpathIndex}`);
		}
		current = current.parentNode;
	}
	return "/" + segments.join("/");
}
/**
* Get element position among siblings with same tag
*
* Returns 0 if only element of its type, otherwise 1-based index.
*/
function getElementPosition(element) {
	if (!element.parentNode?.childrenNodes) return 0;
	const sameTagSiblings = element.parentNode.childrenNodes.filter((child) => child.nodeType === 1 && child.nodeName.toLowerCase() === element.nodeName.toLowerCase());
	if (sameTagSiblings.length <= 1) return 0;
	const index = sameTagSiblings.indexOf(element);
	return index >= 0 ? index + 1 : 0;
}
//#endregion
//#region src/browser/dom/tree/attributes.ts
/**
* Module overview
* Responsibility: Browser DOM attribute filtering used by the DOM service.
* Usage: Runs after CDP DOM, accessibility, and layout snapshots are captured and contributes stable data for snapshot indexes, positioning, and rendering.
* State and failure boundaries: Frame ownership, backend node IDs, model reference numbers, and incremental state must remain consistent across navigation and OOPIF changes.
* Maintenance: When changing heuristics, verify cross-frame, dynamic-page, Shadow DOM, state-restoration, adjacent-test, and public-type paths.
*/
/**
* Attribute Whitelist Filter
*
* Filters element attributes using global + tag-specific whitelist strategy
* to retain only semantically meaningful attributes for DOM serialization.
*/
const GLOBAL_WHITELIST = [
	"role",
	"aria-label",
	"aria-labelledby",
	"title",
	"disabled",
	"id"
];
const IMPORTANT_DATA_ATTRIBUTES = [
	"data-testid",
	"data-id",
	"data-value",
	"data-label",
	"data-name",
	"data-type",
	"data-action",
	"data-target",
	"data-is-selected"
];
const ARIA_ATTRIBUTES = [
	"aria-checked",
	"aria-selected",
	"aria-expanded",
	"aria-pressed",
	"aria-modal",
	"aria-valuemin",
	"aria-valuemax",
	"aria-valuenow",
	"aria-valuetext",
	"aria-required",
	"aria-readonly"
];
const TAG_SPECIFIC_WHITELIST = {
	button: ["type", "aria-pressed"],
	a: [],
	i: ["class"],
	img: ["alt"],
	textarea: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required",
		"maxlength",
		"rows",
		"cols"
	],
	select: [
		"name",
		"value",
		"multiple",
		"aria-expanded"
	],
	option: [
		"value",
		"selected",
		"aria-selected"
	],
	label: ["for"],
	details: ["open"],
	dialog: ["open", "aria-modal"],
	video: [
		"controls",
		"autoplay",
		"muted",
		"loop"
	],
	audio: [
		"controls",
		"autoplay",
		"muted",
		"loop"
	],
	iframe: ["title"],
	progress: ["value", "max"],
	meter: [
		"value",
		"min",
		"max",
		"low",
		"high",
		"optimum"
	],
	form: ["name"],
	th: [
		"scope",
		"colspan",
		"rowspan"
	],
	td: [
		"headers",
		"colspan",
		"rowspan"
	],
	colgroup: ["span"],
	col: ["span"]
};
const INPUT_TYPE_WHITELIST = {
	text: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required",
		"maxlength"
	],
	search: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required"
	],
	email: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required"
	],
	password: [
		"name",
		"placeholder",
		"readonly",
		"required"
	],
	tel: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required"
	],
	url: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required"
	],
	number: [
		"name",
		"value",
		"placeholder",
		"readonly",
		"required",
		"min",
		"max",
		"step"
	],
	checkbox: [
		"name",
		"value",
		"checked",
		"aria-checked"
	],
	radio: [
		"name",
		"value",
		"checked",
		"aria-checked"
	],
	range: [
		"name",
		"value",
		"min",
		"max",
		"step",
		"aria-valuemin",
		"aria-valuemax",
		"aria-valuenow",
		"aria-valuetext"
	],
	submit: ["type", "value"],
	button: ["type", "value"],
	file: [
		"name",
		"accept",
		"multiple"
	],
	date: [
		"name",
		"value",
		"min",
		"max"
	],
	time: [
		"name",
		"value",
		"min",
		"max"
	],
	"datetime-local": [
		"name",
		"value",
		"min",
		"max"
	],
	color: ["name", "value"],
	hidden: []
};
/** Tags where global `id` is noise (auto-generated, not semantic) */
const SKIP_ID_TAGS = /* @__PURE__ */ new Set(["svg", "img"]);
/**
* Filter attributes using global + tag-specific whitelist strategy.
*/
function getWhitelistedAttributes(nodeName, attributes) {
	const result = {};
	const tagName = nodeName.toLowerCase();
	const role = attributes.role;
	for (const attr of GLOBAL_WHITELIST) {
		if (attr === "id" && SKIP_ID_TAGS.has(tagName)) continue;
		if (attributes[attr]?.trim()) result[attr] = attributes[attr];
	}
	for (const attr of IMPORTANT_DATA_ATTRIBUTES) if (attributes[attr]?.trim()) result[attr] = attributes[attr];
	if (role) {
		for (const attr of ARIA_ATTRIBUTES) if (attributes[attr]?.trim()) result[attr] = attributes[attr];
	}
	if (tagName === "input") {
		const inputType = attributes.type || "text";
		if (inputType === "hidden") return {};
		if (inputType !== "text") result["type"] = inputType;
		const typeWhitelist = INPUT_TYPE_WHITELIST[inputType] || INPUT_TYPE_WHITELIST["text"];
		for (const attr of typeWhitelist) if (attributes[attr]?.trim()) result[attr] = attributes[attr];
	} else if (TAG_SPECIFIC_WHITELIST[tagName]) {
		for (const attr of TAG_SPECIFIC_WHITELIST[tagName]) if (attributes[attr]?.trim()) result[attr] = attributes[attr];
	}
	if (tagName === "button" || role === "button") {
		if (attributes.type) result.type = attributes.type;
		if (attributes["aria-pressed"]) result["aria-pressed"] = attributes["aria-pressed"];
	}
	if (role === "slider") {
		for (const attr of [
			"value",
			"aria-valuemin",
			"aria-valuemax",
			"aria-valuenow",
			"aria-valuetext"
		]) if (attributes[attr]) result[attr] = attributes[attr];
	}
	if (tagName === "a" || role === "link") delete result.href;
	return result;
}
//#endregion
//#region src/browser/dom/types/ax.ts
/** Roles that compute name from descendant text content (WAI-ARIA "Name from Content") */
const NAME_FROM_CONTENT_ROLES = /* @__PURE__ */ new Set([
	"button",
	"cell",
	"checkbox",
	"columnheader",
	"gridcell",
	"heading",
	"link",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"row",
	"rowheader",
	"switch",
	"tab",
	"tooltip",
	"treeitem"
]);
/**
* Build enhanced AX node from CDP AX node
*/
function buildEnhancedAXNode(axNode) {
	const result = {
		axNodeId: axNode.nodeId,
		ignored: axNode.ignored
	};
	if (axNode.role?.value) result.role = axNode.role.value;
	if (axNode.name?.value) result.name = axNode.name.value;
	if (axNode.description?.value) result.description = axNode.description.value;
	if (axNode.childIds?.length) result.childIds = axNode.childIds;
	if (axNode.properties?.length) {
		const properties = [];
		for (const prop of axNode.properties) try {
			const value = prop.value?.value ?? null;
			properties.push({
				name: prop.name,
				value
			});
		} catch {}
		if (properties.length > 0) result.properties = properties;
	}
	return result;
}
/**
* Build AX tree lookup from CDP AX tree response
*/
function buildAXTreeLookup(axNodes) {
	const lookup = /* @__PURE__ */ new Map();
	for (const axNode of axNodes) if (axNode.backendDOMNodeId !== void 0) lookup.set(axNode.backendDOMNodeId, buildEnhancedAXNode(axNode));
	return lookup;
}
//#endregion
//#region src/browser/dom/snapshot/lookup.ts
/**
* Parse rare boolean data from snapshot
* Returns true if index is in the rare data array, false otherwise
*/
function parseRareBooleanData(rareData, index) {
	if (!rareData?.index) return false;
	return rareData.index.includes(index);
}
/**
* Parse computed styles from layout tree using string indices
*/
function parseComputedStyles(strings, styleIndices) {
	const styles = {};
	for (let i = 0; i < styleIndices.length; i++) {
		const styleIndex = styleIndices[i];
		if (i < REQUIRED_COMPUTED_STYLES.length && styleIndex >= 0 && styleIndex < strings.length) styles[REQUIRED_COMPUTED_STYLES[i]] = strings[styleIndex];
	}
	return styles;
}
/**
* Parse bounds array to DOMRect, applying device pixel ratio scaling
*/
function parseBounds(bounds, devicePixelRatio) {
	if (!bounds || bounds.length < 4) return null;
	return {
		x: bounds[0] / devicePixelRatio,
		y: bounds[1] / devicePixelRatio,
		width: bounds[2] / devicePixelRatio,
		height: bounds[3] / devicePixelRatio
	};
}
/**
* Parse rect data (client/scroll rects) - these don't need device pixel ratio scaling
*/
function parseRects(rectData) {
	if (!rectData || rectData.length < 4) return null;
	return {
		x: rectData[0],
		y: rectData[1],
		width: rectData[2],
		height: rectData[3]
	};
}
/**
* Build snapshot lookup from CDP snapshot response
*
* Creates a map from backendNodeId to EnhancedSnapshotNode with all
* layout, style, and interactivity data pre-calculated.
*/
function buildSnapshotLookup(snapshot, devicePixelRatio = 1) {
	const snapshotLookup = /* @__PURE__ */ new Map();
	if (!snapshot.documents || snapshot.documents.length === 0) return snapshotLookup;
	const strings = snapshot.strings;
	for (const document of snapshot.documents) {
		const nodes = document.nodes;
		const layout = document.layout;
		const backendNodeToSnapshotIndex = /* @__PURE__ */ new Map();
		if (nodes.backendNodeId) for (let i = 0; i < nodes.backendNodeId.length; i++) backendNodeToSnapshotIndex.set(nodes.backendNodeId[i], i);
		const layoutIndexMap = /* @__PURE__ */ new Map();
		if (layout?.nodeIndex) for (let layoutIdx = 0; layoutIdx < layout.nodeIndex.length; layoutIdx++) {
			const nodeIndex = layout.nodeIndex[layoutIdx];
			if (!layoutIndexMap.has(nodeIndex)) layoutIndexMap.set(nodeIndex, layoutIdx);
		}
		for (const [backendNodeId, snapshotIndex] of backendNodeToSnapshotIndex) {
			const enhancedNode = { isClickable: parseRareBooleanData(nodes.isClickable, snapshotIndex) };
			const layoutIdx = layoutIndexMap.get(snapshotIndex);
			if (layoutIdx !== void 0 && layout) {
				if (layout.bounds && layoutIdx < layout.bounds.length) {
					const bounds = parseBounds(layout.bounds[layoutIdx], devicePixelRatio);
					if (bounds) enhancedNode.bounds = bounds;
				}
				if (layout.styles && layoutIdx < layout.styles.length) {
					const styleIndices = layout.styles[layoutIdx];
					const computedStyles = parseComputedStyles(strings, styleIndices);
					if (Object.keys(computedStyles).length > 0) {
						enhancedNode.computedStyles = computedStyles;
						if (computedStyles.cursor) enhancedNode.cursorStyle = computedStyles.cursor;
					}
				}
				if (layout.paintOrders && layoutIdx < layout.paintOrders.length) enhancedNode.paintOrder = layout.paintOrders[layoutIdx];
				if (layout.clientRects && layoutIdx < layout.clientRects.length) {
					const clientRects = parseRects(layout.clientRects[layoutIdx]);
					if (clientRects) enhancedNode.clientRects = clientRects;
				}
				if (layout.scrollRects && layoutIdx < layout.scrollRects.length) {
					const scrollRects = parseRects(layout.scrollRects[layoutIdx]);
					if (scrollRects) enhancedNode.scrollRects = scrollRects;
				}
				if (layout.stackingContexts?.index && layoutIdx < layout.stackingContexts.index.length) enhancedNode.stackingContexts = layout.stackingContexts.index[layoutIdx];
			}
			snapshotLookup.set(backendNodeId, enhancedNode);
		}
	}
	return snapshotLookup;
}
//#endregion
//#region src/browser/dom/tree/builder.ts
/**
* DOM Tree Builder
*
* The enhanced nodal tree is constructed through DOM tree, accessible tree and snapshot data CDP.
*/
var DOMTreeBuilder = class DOMTreeBuilder {
	trees;
	snapshotLookup;
	axTreeLookup;
	enhancedNodeLookup = /* @__PURE__ */ new Map();
	devicePixelRatio;
	/** OOPIF data indexed by the host IFRAME element's ownerBackendNodeId. */
	oopifByOwner = /* @__PURE__ */ new Map();
	constructor(trees) {
		this.trees = trees;
		this.devicePixelRatio = trees.devicePixelRatio;
		this.snapshotLookup = buildSnapshotLookup(trees.snapshot, this.devicePixelRatio);
		this.axTreeLookup = buildAXTreeLookup(trees.axTree.nodes);
		if (trees.oopifTrees) for (const oopif of trees.oopifTrees) this.oopifByOwner.set(oopif.ownerBackendNodeId, oopif);
	}
	/**
	* Build Enhancement DOM Tree
	*
	* @paraminitialFrameOffset - Coordinates calculate the initial offset. The OOPIF sub-tree will follow the cumulative deviation of the father iframe and maintain global alignment.
	* @paramxpathPrefix - Optional prefix xpath currently used only for iframe/shadow path adhesion.
	*/
	async build(initialFrameOffset, xpathPrefix) {
		const root = await this.constructEnhancedNode(this.trees.domTree.root, initialFrameOffset ?? {
			x: 0,
			y: 0,
			width: 0,
			height: 0
		}, 0, xpathPrefix ?? "");
		assignXPaths(root);
		return { root };
	}
	/**
	* Recursively construct enhanced DOM tree nodes
	*
	* This corresponds to _construct_enhanced_node in version Python.
	*/
	async constructEnhancedNode(node, totalFrameOffset, iframeDepth, xpathPrefix) {
		const frameOffset = { ...totalFrameOffset };
		if (this.enhancedNodeLookup.has(node.nodeId)) return this.enhancedNodeLookup.get(node.nodeId);
		const axNode = this.axTreeLookup.get(node.backendNodeId) ?? null;
		const attributes = {};
		if (node.attributes) for (let i = 0; i < node.attributes.length; i += 2) attributes[node.attributes[i]] = node.attributes[i + 1];
		let shadowRootType = null;
		if (node.shadowRootType) shadowRootType = node.shadowRootType;
		const snapshotData = this.snapshotLookup.get(node.backendNodeId) ?? null;
		let absolutePosition = null;
		if (snapshotData?.bounds) absolutePosition = {
			x: snapshotData.bounds.x + frameOffset.x,
			y: snapshotData.bounds.y + frameOffset.y,
			width: snapshotData.bounds.width,
			height: snapshotData.bounds.height
		};
		const whitelistedAttributes = getWhitelistedAttributes(node.nodeName, attributes);
		const enhancedNode = {
			nodeId: node.nodeId,
			backendNodeId: node.backendNodeId,
			nodeType: node.nodeType,
			nodeName: node.nodeName,
			nodeValue: node.nodeValue ?? "",
			attributes,
			whitelistedAttributes: Object.keys(whitelistedAttributes).length > 0 ? whitelistedAttributes : void 0,
			uuid: generateUUID(),
			renderInfo: {
				isVisible: false,
				isInteractive: false,
				isIframeHost: false,
				isTopElement: false,
				isShadowHost: false,
				isCandidate: false,
				isDuplicateListener: false
			}
		};
		if (absolutePosition) enhancedNode.absolutePosition = absolutePosition;
		if (node.frameId) enhancedNode.frameId = node.frameId;
		if (shadowRootType) enhancedNode.shadowRootType = shadowRootType;
		if (axNode) enhancedNode.axNode = axNode;
		if (snapshotData) enhancedNode.snapshotNode = snapshotData;
		if (node.pseudoElements?.length) enhancedNode.pseudoElementIds = node.pseudoElements.map((pseudo) => pseudo.backendNodeId);
		this.enhancedNodeLookup.set(node.nodeId, enhancedNode);
		if (node.parentId !== void 0 && this.enhancedNodeLookup.has(node.parentId)) enhancedNode.parentNode = this.enhancedNodeLookup.get(node.parentId);
		enhancedNode._xpathPrefix = xpathPrefix;
		if (node.nodeType === 1 && node.nodeName === "HTML" && node.frameId) {
			if (snapshotData?.scrollRects) {
				frameOffset.x -= snapshotData.scrollRects.x;
				frameOffset.y -= snapshotData.scrollRects.y;
			}
		}
		const tagName = node.nodeName.toUpperCase();
		if ((tagName === "IFRAME" || tagName === "FRAME") && snapshotData?.bounds) {
			frameOffset.x += snapshotData.bounds.x;
			frameOffset.y += snapshotData.bounds.y;
		}
		if (node.contentDocument) {
			const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
			enhancedNode.contentDocument = await this.constructEnhancedNode(node.contentDocument, frameOffset, iframeDepth + 1, iframePrefix);
			enhancedNode.contentDocument.parentNode = enhancedNode;
		} else if ((tagName === "IFRAME" || tagName === "FRAME") && this.oopifByOwner.has(node.backendNodeId)) {
			const oopifData = this.oopifByOwner.get(node.backendNodeId);
			try {
				const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
				const { root: oopifRoot } = await new DOMTreeBuilder({
					snapshot: oopifData.snapshot,
					domTree: oopifData.domTree,
					axTree: oopifData.axTree,
					devicePixelRatio: this.devicePixelRatio
				}).build(frameOffset, iframePrefix);
				tagOOPIFNodes(oopifRoot, oopifData.sessionId);
				enhancedNode.contentDocument = oopifRoot;
				enhancedNode.contentDocument.parentNode = enhancedNode;
			} catch (error) {}
		}
		if (node.shadowRoots && node.shadowRoots.length > 0) {
			enhancedNode.shadowRoots = [];
			const shadowPrefix = `${enhancedNode.xpath} [SHADOW] `;
			for (const shadowRoot of node.shadowRoots) {
				const shadowRootNode = await this.constructEnhancedNode(shadowRoot, frameOffset, iframeDepth, shadowPrefix);
				shadowRootNode.parentNode = enhancedNode;
				enhancedNode.shadowRoots.push(shadowRootNode);
			}
		}
		if (node.children && node.children.length > 0) {
			enhancedNode.childrenNodes = [];
			const shadowRootNodeIds = /* @__PURE__ */ new Set();
			if (node.shadowRoots) for (const sr of node.shadowRoots) shadowRootNodeIds.add(sr.nodeId);
			for (const child of node.children) {
				if (shadowRootNodeIds.has(child.nodeId)) continue;
				const childNode = await this.constructEnhancedNode(child, frameOffset, iframeDepth, xpathPrefix);
				enhancedNode.childrenNodes.push(childNode);
			}
		}
		return enhancedNode;
	}
	/**
	* Get devicePixelRatio
	*/
	getDevicePixelRatio() {
		return this.devicePixelRatio;
	}
};
/**
* Unified distribution of xpath upon completion of tree construction;
* When parent.childrenNodes is complete, the index can be stabilized.
*/
function assignXPaths(node) {
	const prefix = node._xpathPrefix ?? "";
	const localXpath = generateXPath(node);
	node.xpath = prefix ? `${prefix}${localXpath}` : localXpath;
	delete node._xpathPrefix;
	for (const child of node.childrenNodes ?? []) assignXPaths(child);
	for (const sr of node.shadowRoots ?? []) assignXPaths(sr);
	if (node.contentDocument) assignXPaths(node.contentDocument);
}
/**
* To OOPIF subtree node sessionId;
* The downstream is based on which CDP command routes are routed to the context of the correct session.
*/
function tagOOPIFNodes(node, sessionId) {
	node.oopifSessionId = sessionId;
	for (const child of node.childrenNodes ?? []) tagOOPIFNodes(child, sessionId);
	for (const sr of node.shadowRoots ?? []) tagOOPIFNodes(sr, sessionId);
	if (node.contentDocument) tagOOPIFNodes(node.contentDocument, sessionId);
}
//#endregion
//#region src/browser/dom/tree/inline-merger.ts
/**
* Recursively extract text content from a node and its descendants
*/
function extractTextContent(node) {
	if (node.nodeType === 3) return node.nodeValue;
	const parts = [];
	for (const child of node.childrenNodes ?? []) parts.push(extractTextContent(child));
	return parts.join("");
}
/**
* Find the first TEXT_NODE in a node's subtree (depth-first)
*/
function findFirstTextNode(node) {
	if (node.nodeType === 3) return node;
	for (const child of node.childrenNodes ?? []) {
		const found = findFirstTextNode(child);
		if (found) return found;
	}
	return null;
}
/**
* Recursively remove all TEXT_NODEs from a node's childrenNodes,
* skipping the one to keep.
*/
function removeTextNodes(node, keep) {
	const children = node.childrenNodes;
	if (!children) return;
	for (let i = children.length - 1; i >= 0; i--) if (children[i].nodeType === 3 && children[i] !== keep) children.splice(i, 1);
	else removeTextNodes(children[i], keep);
}
function isInlineDisplay(node) {
	const nodeDisplay = node.snapshotNode?.computedStyles?.display;
	if (!nodeDisplay) return false;
	return nodeDisplay === "inline" || nodeDisplay === "flow-root";
}
/**
* Merge consecutive inline siblings throughout the tree.
*
* For each parent, finds runs of 2+ consecutive inline-display children,
* extracts all text, writes merged text into the first TEXT_NODE found
* at any depth, removes all other TEXT_NODEs in the run, and updates
* axNode.name accordingly.
*
* Processes bottom-up so inner merges happen before outer ones.
*/
function mergeInlineNodes(root) {
	for (const child of root.childrenNodes ?? []) mergeInlineNodes(child);
	for (const shadow of root.shadowRoots ?? []) mergeInlineNodes(shadow);
	if (root.contentDocument) mergeInlineNodes(root.contentDocument);
	const children = root.childrenNodes;
	if (!children || children.length < 2) return;
	let i = 0;
	while (i < children.length) {
		if (!isInlineDisplay(children[i])) {
			i++;
			continue;
		}
		let runEnd = i + 1;
		while (runEnd < children.length && isInlineDisplay(children[runEnd])) runEnd++;
		if (runEnd - i < 2) {
			i++;
			continue;
		}
		let firstTextNode = null;
		for (let j = i; j < runEnd && !firstTextNode; j++) firstTextNode = findFirstTextNode(children[j]);
		if (firstTextNode) {
			const textParts = [];
			for (let j = i; j < runEnd; j++) textParts.push(extractTextContent(children[j]));
			const mergedText = textParts.join("");
			firstTextNode.nodeValue = mergedText;
			if (firstTextNode.axNode) firstTextNode.axNode.name = mergedText;
			for (let j = i; j < runEnd; j++) if (children[j].nodeType === 3 && children[j] !== firstTextNode) {
				children.splice(j, 1);
				j--;
				runEnd--;
			} else removeTextNodes(children[j], firstTextNode);
		}
		i = runEnd;
	}
}
//#endregion
//#region src/browser/dom/tree/pruner.ts
const MAX_ITERATIONS$1 = 100;
/**
* In-situ cropping of DOM trees and repeated execution to nodes without change.
*
* @param root - Tree to prune; boundary fields, childrenNodes, candidate state, and cached text may be modified in place.
* @param lookup - Optional original-tree index; when present, pruneReason is written back to the matching original node.
*/
function pruneTree(root, lookup) {
	mergeInlineNodes(root);
	flattenBoundaries$1(root);
	const effectiveLookup = lookup ?? /* @__PURE__ */ new Map();
	let changed = true;
	let iteration = 0;
	while (changed && iteration < MAX_ITERATIONS$1) {
		iteration++;
		const countBefore = countNodes$1(root);
		root.childrenNodes = pruneChildren$1(root, root.childrenNodes ?? [], effectiveLookup);
		changed = countBefore !== countNodes$1(root);
		if (changed) {}
	}
}
/**
* Recursive elimination of tree boundaries: maintain the original normal subnode order and add Shadow Root and contentDocument direct subnode.
* Boundary containers themselves do not enter the final childrenNodes; the parentNode elevated node is replaced by the current host node.
*/
function flattenBoundaries$1(node) {
	const merged = [];
	for (const child of node.childrenNodes ?? []) merged.push(child);
	if (node.shadowRoots) {
		for (const shadow of node.shadowRoots) for (const child of shadow.childrenNodes ?? []) {
			child.parentNode = node;
			merged.push(child);
		}
		node.shadowRoots = void 0;
	}
	if (node.contentDocument) {
		for (const child of node.contentDocument.childrenNodes ?? []) {
			child.parentNode = node;
			merged.push(child);
		}
		node.contentDocument = void 0;
	}
	node.childrenNodes = merged;
	for (const child of node.childrenNodes) flattenBoundaries$1(child);
}
function countNodes$1(node) {
	let count = 1;
	for (const child of node.childrenNodes ?? []) count += countNodes$1(child);
	return count;
}
function pruneChildren$1(parent, children, lookup) {
	const result = [];
	for (const child of children) {
		const processed = pruneNode$1(child, lookup);
		for (const node of processed) node.parentNode = parent;
		result.push(...processed);
	}
	return result;
}
function pruneNode$1(node, lookup) {
	node.childrenNodes = pruneChildren$1(node, node.childrenNodes ?? [], lookup);
	if (!node.parentNode) return [node];
	if (node.renderInfo?.isBlockedByOverlay) {
		markPruneReason(lookup, node, "blocked-by-overlay: removed");
		return [];
	}
	if (node.nodeType === 3 && (node.renderInfo.isTopElement || node.renderInfo.expandedViewportPosition !== void 0 || node.renderInfo.diffStatus === "removed")) return [node];
	if (isVisualElement(node)) {
		const useHref = extractSvgUseHref(node);
		if (useHref) node.renderInfo.cachedText = useHref;
		return [node];
	}
	if (node.renderInfo?.isCandidate && node.renderInfo.isDuplicateListener && !node.renderInfo.isSelectOption) {
		const ancestor = findAncestorCandidate(node);
		if (ancestor && isSameContent(node, ancestor)) {
			markPruneReason(lookup, node, "duplicate-listener: unwrapped");
			node.renderInfo.isCandidate = false;
		}
	}
	if (node.renderInfo?.isListenerHost) return [node];
	if (node.renderInfo?.isCandidate) {
		if (hasContent(node)) return [node];
		markPruneReason(lookup, node, "empty-candidate: demoted");
		node.renderInfo.isCandidate = false;
	}
	const isOnlyChild = node.parentNode.childrenNodes?.length === 1;
	const hasNoChildren = (node.childrenNodes?.length ?? 0) === 0;
	const noCandidateInSubtree = !hasDescendantCandidate(node);
	if (isOnlyChild) {
		markPruneReason(lookup, node, "only-child: unwrapped");
		return node.childrenNodes ?? [];
	}
	if (hasNoChildren) {
		markPruneReason(lookup, node, "empty-leaf: unwrapped");
		return node.childrenNodes ?? [];
	}
	if (noCandidateInSubtree) {
		markPruneReason(lookup, node, "no-candidate-in-subtree: unwrapped");
		return node.childrenNodes ?? [];
	}
	return [node];
}
/** To determine whether the present node or any descendants still have a candidate to determine the structural significance of the container layer. */
function hasDescendantCandidate(node) {
	if (node.renderInfo?.isCandidate) return true;
	for (const child of node.childrenNodes ?? []) if (hasDescendantCandidate(child)) return true;
	return false;
}
/**
* Determines whether visual elements exist before the current node reaches the lower candidate boundary.
* The branch is discontinued when a candidate child node is encountered, since its visual content should belong to the sub-node and not to the current candidate.
*/
function hasVisualElementTillNextCandidate(node) {
	if (isVisualElement(node)) return true;
	for (const child of node.childrenNodes ?? []) {
		if (child.renderInfo?.isCandidate) continue;
		if (hasVisualElementTillNextCandidate(child)) return true;
	}
	return false;
}
/**
* A node has content when it contributes cached/aggregated text, whitelisted attributes,
* or visual elements before the next candidate boundary.
*/
function hasContent(node) {
	const text = node.renderInfo.cachedText !== void 0 ? node.renderInfo.cachedText : getAllTextTillNextCandidate(node);
	const hasAttrs = hasWhitelistedAttributes(node);
	return !!(text || hasAttrs || hasVisualElementTillNextCandidate(node));
}
/**
* Collects text below the current node, before the next candidate or visual element.
*
* order of calculation: scan each of the direct subnodes; candidate and visual elements each carry the content and do not cross the current node to extract the text; normal text nodes
* After trim insert arrays, and the other nodes are then grouped. Finally removes the empty strings, connects them with spaces and presses them into one space.
* If DOM text is empty and the name AX role allows "from content" then the barrier-free name will be used.
*/
function getAllTextTillNextCandidate(node) {
	const texts = [];
	for (const child of node.childrenNodes ?? []) {
		if (child.renderInfo?.isCandidate) continue;
		if (isVisualElement(child)) continue;
		if (child.nodeType === 3 && child.nodeValue) texts.push(child.nodeValue.trim());
		else texts.push(getAllTextTillNextCandidate(child));
	}
	const result = texts.filter(Boolean).join(" ").replace(/\s+/g, " ");
	if (!result && node.axNode?.role && NAME_FROM_CONTENT_ROLES.has(node.axNode.role)) return node.axNode.name?.trim() ?? "";
	return result;
}
/** As long as there is at least one selected model readable attribute at the node, it is considered to be attribute content. */
function hasWhitelistedAttributes(node) {
	const wa = node.whitelistedAttributes;
	return !!wa && Object.keys(wa).length > 0;
}
/**
* Strictly compare a descendant's whitelisted attributes with an ancestor's: both sets
* must contain the same keys and values.
*/
function hasSameWhitelistedAttributes(desc, ancestor) {
	const descAttrs = desc.whitelistedAttributes ?? {};
	const ancestorAttrs = ancestor.whitelistedAttributes ?? {};
	const descEntries = Object.entries(descAttrs);
	const ancestorEntries = Object.entries(ancestorAttrs);
	if (descEntries.length !== ancestorEntries.length) return false;
	return descEntries.every(([key, value]) => ancestorAttrs[key] === value);
}
/** From the direct parent node, you can look up for the most recent “candidature and non-repeat listening” ancestors. */
function findAncestorCandidate(node) {
	let ancestor = node.parentNode;
	while (ancestor) {
		if (ancestor.renderInfo?.isCandidate && !ancestor.renderInfo.isDuplicateListener) return ancestor;
		ancestor = ancestor.parentNode;
	}
}
/**
* Determine whether a descendant repeats its ancestor: non-empty descendant text must be
* contained in the ancestor text, and the whitelisted attributes must match exactly.
* Empty descendant text skips the text check, but attributes must still match.
*/
function isSameContent(desc, ancestor) {
	const descText = getAllTextTillNextCandidate(desc);
	const ancestorText = getAllTextTillNextCandidate(ancestor);
	if (descText && !ancestorText.includes(descText)) return false;
	return hasSameWhitelistedAttributes(desc, ancestor);
}
/** Collect href/xlink:href values from descendant SVG use elements that reference symbol paths. */
function extractSvgUseHref(node) {
	const hrefs = [];
	collectUseHrefs(node, hrefs);
	return hrefs.length > 0 ? hrefs.join(" ") : void 0;
}
/** Depth priority goes through the subtree SVG and insert all use references in the order in which they appear. */
function collectUseHrefs(node, hrefs) {
	if (node.nodeName.toLowerCase() === "use" && node.attributes) {
		const href = node.attributes["href"] || node.attributes["xlink:href"];
		if (href) hrefs.push(href);
	}
	for (const child of node.childrenNodes ?? []) collectUseHrefs(child, hrefs);
}
//#endregion
//#region src/browser/dom/serializer/renderer.ts
/**
* Reads a unified list of direct subnodes. Upstream pruneTree() has already put normal subnodes, ShadowRoot and iframecontentDocument
* The content is spread to childrenNodes, so there are no more three different borders.
*/
function getAllChildren(node) {
	return node.childrenNodes ?? [];
}
/**
* Check the presence of candidate nodes or independent visual elements among the ancestors. Such ancestors aggregate the text of the next generation, and the current node cannot be re-exported when hit.
* Otherwise the same text appears in both the parent element line and the text node line.
*/
function hasCandidateOrVisualAncestor(node) {
	let ancestor = node.parentNode;
	while (ancestor) {
		if (ancestor.renderInfo.isCandidate || isVisualElement(ancestor)) return true;
		ancestor = ancestor.parentNode;
	}
	return false;
}
/**
* Build the serialized attribute string and remove information duplicated by the node text.
*
* Order of calculation:
* 1. Return an empty attribute string and the original text when no whitelisted attributes exist.
* 2. Shallow-copy the attributes so deduplication never mutates the node's stored data.
* Delete this semantic information if role is identical to the lowercase label name.
* 4. Compare attribute values with text after trim: property values overwrite text and ultimately empty line text; text contains attribute values
* , text overwhelms the attribute, deleting it. When the two are equal, the former situation is followed, with priority being given to retaining the attribute.
* 5. Spell the remaining properties as `key ='value' and connect them in spaces.
*
* returns `{attrsStr, text} '; returned text may be an empty string if the attribute already expresses the same content.
*/
function buildAttributesString(node, text) {
	const attrs = node.whitelistedAttributes;
	if (!attrs || Object.keys(attrs).length === 0) return {
		attrsStr: "",
		text
	};
	const attributesToInclude = { ...attrs };
	if (attributesToInclude.role && node.nodeName.toLowerCase() === attributesToInclude.role) delete attributesToInclude.role;
	const trimmedText = text.trim();
	let suppressText = false;
	if (trimmedText) for (const key of Object.keys(attributesToInclude)) {
		const attrVal = attributesToInclude[key]?.trim();
		if (!attrVal) continue;
		if (attrVal.includes(trimmedText)) suppressText = true;
		else if (trimmedText.includes(attrVal)) delete attributesToInclude[key];
	}
	if (Object.keys(attributesToInclude).length === 0) return {
		attrsStr: "",
		text: suppressText ? "" : text
	};
	return {
		attrsStr: Object.entries(attributesToInclude).map(([key, value]) => `${key}='${value}'`).join(" "),
		text: suppressText ? "" : text
	};
}
const MAX_OFFSCREEN_TEXT = 50;
/**
* Converts the historical interactive records of the same element to a modelable HTML comment.
*
* Number of times click and select only; input start with the three parameters text, clear/append and pressEnter and output each group
* Number of times. The caller has filtered the record with backendNodeId and renderedLine and this function is only about aggregation and fusion.
*/
function buildInteractionAnnotation(records) {
	const parts = [];
	const clicks = records.filter((r) => r.action === "click");
	const selects = records.filter((r) => r.action === "select");
	const inputs = records.filter((r) => r.action === "input");
	if (clicks.length > 0) parts.push(`you already clicked this element ${clicks.length} times`);
	if (selects.length > 0) parts.push(`you already selected this element ${selects.length} times`);
	if (inputs.length > 0) {
		const groups = /* @__PURE__ */ new Map();
		for (const inp of inputs) {
			const text = String(inp.params?.text ?? "");
			const clear = inp.params?.clear !== false ? "clear" : "append";
			const enter = inp.params?.pressEnter ? "+Enter" : "";
			const key = `${text}|${clear}|${enter}`;
			const existing = groups.get(key);
			if (existing) existing.count++;
			else groups.set(key, {
				text,
				clear,
				enter,
				count: 1
			});
		}
		for (const { text, clear, enter, count } of groups.values()) {
			const times = count > 1 ? ` ${count} times` : "";
			parts.push(`you already input "${text}" here${times} (${clear}${enter})`);
		}
	}
	return `<!-- ${parts.join("; ")} -->`;
}
/**
* Public entry point for rendering a DOM tree as text.
*
* @param node - The root that has been calculated upstream renderInfo, cropped and numbered; null indicates an output empty string
* @paramdepth - Initial indent depth, general call 0; one tab for each level Arguments
* @paramlookup - A composite key index of the original DOM tree to write back from the crop copy to the original nodes
* @paraminteractionMap - Historical interactions grouped by owning frame and backendNodeId
* @paramoptions.incrementalDiff - Output only added/removed difference nodes and skip completely undifferentiated subtrees
*/
function renderToHtml(node, depth = 0, lookup, interactionMap, options) {
	const state = {
		currentZone: void 0,
		lines: [],
		interactionMap,
		incrementalDiff: options?.incrementalDiff
	};
	renderNode$1(node, depth, lookup, state);
	if (state.currentZone) state.lines.push("=== END OFF-SCREEN ===");
	return state.lines.join("\n");
}
/** In depth, priority is given to checking for differences among descendants; the incremental mode uses it as a whole to skip a completely unchanged sub-tree. */
function hasDiffDescendant(node) {
	for (const child of getAllChildren(node)) if (child.renderInfo?.diffStatus || hasDiffDescendant(child)) return true;
	return false;
}
function renderNode$1(node, depth, lookup, state) {
	if (!node) return;
	const renderInfo = node.renderInfo;
	if (!(renderInfo && (renderInfo.isTopElement || renderInfo.expandedViewportPosition !== void 0 || renderInfo.diffStatus === "removed" || renderInfo.isVisuallyHiddenNativeControl || renderInfo.isSelectOption))) {
		for (const child of getAllChildren(node)) renderNode$1(child, depth, lookup, state);
		return;
	}
	if (state.incrementalDiff && !renderInfo.diffStatus && !hasDiffDescendant(node)) return;
	const rawZone = renderInfo.expandedViewportPosition;
	const nodeZone = rawZone === "left" ? "above" : rawZone === "right" ? "below" : rawZone;
	if (nodeZone !== state.currentZone) {
		if (state.currentZone) state.lines.push("=== END OFF-SCREEN ===");
		if (nodeZone) {
			const suffix = ` [container:${renderInfo.scrollContainerIndex ?? 0}]`;
			state.lines.push(`=== OFF-SCREEN ${nodeZone}${suffix} (scroll to reveal these elements) ===`);
		}
		state.currentZone = nodeZone;
	}
	const prefix = renderInfo.diffStatus === "added" ? "+|" : renderInfo.diffStatus === "removed" ? "-|" : "";
	const depthStr = "	".repeat(depth);
	if (node.nodeType === 1) {
		const tagName = node.nodeName.toLowerCase();
		const isVisualTop = isVisualTopNode(node);
		const isStructuralChild = STRUCTURAL_CHILD_TAGS.has(tagName);
		const nextDepth = depth + 1;
		let text = "";
		let attrsStr = "";
		if (renderInfo.isCandidate || isVisualTop || isStructuralChild) {
			text = renderInfo.cachedText !== void 0 ? renderInfo.cachedText : getAllTextTillNextCandidate(node);
			({attrsStr, text} = buildAttributesString(node, text));
		}
		const indicator = `${renderInfo.highlightIndex !== void 0 ? renderInfo.isFill ? `<${renderInfo.highlightIndex}>` : `[${renderInfo.highlightIndex}]` : ""}${isVisualTop && renderInfo.isTopElement ? `[view:${encodeViewId(node.backendNodeId)}]` : ""}`;
		const baselineStr = attrsStr ? ` ${attrsStr}>` : ">";
		const truncatedText = nodeZone && text.length > MAX_OFFSCREEN_TEXT ? text.slice(0, MAX_OFFSCREEN_TEXT) + "..." : text;
		const textStr = truncatedText ? ` ${truncatedText} ` : "";
		const closeTagStr = `</${tagName}>`;
		const line = `${depthStr}${prefix}${indicator}<${tagName}${baselineStr}${textStr}${closeTagStr}`;
		renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
		const originalNode = lookup?.get(nodeKey(node));
		if (originalNode?.renderInfo) originalNode.renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
		let annotation = "";
		if (renderInfo.isCandidate && state.interactionMap) {
			const allInteractions = state.interactionMap.get(`${node.frameId ?? node.oopifSessionId ?? "main"}:${node.backendNodeId}`);
			if (allInteractions) {
				const currentRendered = renderInfo.renderedLine;
				const matched = allInteractions.filter((r) => !r.renderedLine || r.renderedLine === currentRendered);
				if (matched.length > 0) annotation = ` ${buildInteractionAnnotation(matched)}`;
			}
		}
		state.lines.push(`${line}${annotation}`);
		if (nodeZone && renderInfo.isCandidate && (attrsStr || text) && renderInfo.diffStatus !== "removed") {
			if (getAllChildren(node).length > 0) state.lines.push(`${depthStr}\t ...`);
			return;
		}
		for (const child of getAllChildren(node)) renderNode$1(child, nextDepth, lookup, state);
	} else if (node.nodeType === 3) {
		if (!hasCandidateOrVisualAncestor(node)) {
			let textContent = node.nodeValue?.trim() ?? "";
			if (nodeZone && textContent.length > MAX_OFFSCREEN_TEXT) textContent = textContent.slice(0, MAX_OFFSCREEN_TEXT) + "...";
			if (textContent) {
				state.lines.push(`${depthStr}${prefix}${textContent}`);
				renderInfo.renderedLine = textContent;
				const originalNode = lookup?.get(nodeKey(node));
				if (originalNode?.renderInfo) originalNode.renderInfo.renderedLine = textContent;
			}
		}
	} else if (node.nodeType === 11) for (const child of getAllChildren(node)) renderNode$1(child, depth, lookup, state);
	else for (const child of getAllChildren(node)) renderNode$1(child, depth, lookup, state);
}
//#endregion
//#region src/browser/dom/tree/visibility.ts
function checkElementVisibility(node, htmlFrames, expand, parentFrameState = "visible") {
	if (!node.snapshotNode) return { isVisible: false };
	const computedStyles = node.snapshotNode.computedStyles ?? {};
	const display = (computedStyles.display ?? "").toLowerCase();
	const visibility = (computedStyles.visibility ?? "").toLowerCase();
	const opacity = computedStyles.opacity ?? "1";
	if (parentFrameState === "hidden") return { isVisible: false };
	if (display === "none" || visibility === "hidden") return { isVisible: false };
	const elementBounds = node.absolutePosition ?? node.snapshotNode.bounds;
	const opacityValue = Number.parseFloat(opacity);
	if (!elementBounds) return { isVisible: false };
	if (!node.renderInfo.isVisuallyHiddenNativeControl && (elementBounds.width <= 0 || elementBounds.height <= 0 || Number.isFinite(opacityValue) && opacityValue <= 0)) return { isVisible: false };
	const frameResult = checkFrameVisibility(node, elementBounds, htmlFrames, expand);
	if (parentFrameState !== "visible") {
		if (frameResult.state === "visible" || frameResult.state === "expand") return {
			isVisible: false,
			expandedViewportPosition: parentFrameState
		};
		return { isVisible: false };
	}
	if (frameResult.state === "visible") return { isVisible: true };
	if (frameResult.state === "expand") return {
		isVisible: false,
		expandedViewportPosition: frameResult.direction
	};
	return { isVisible: false };
}
/**
* The visual rectangle is constructed for nodes in the absolute system of coordinates.
* clientRects provides the visible viewport size, while absolutePosition anchors the
* rectangle in page coordinates.
*
* body/html inside an iframe may report a clientRect smaller than the actual visible area, such as a 384px body inside a 500px iframe.
* At this point, the larger size of the host iframe is used as a visual view, as this part of the window iframe is actually visible.
*/
function getNodeViewportRect(node) {
	const anchor = node.absolutePosition ?? node.snapshotNode?.bounds;
	const clientRect = node.snapshotNode?.clientRects;
	if (!anchor) return null;
	if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
		let width = clientRect.width;
		let height = clientRect.height;
		const tag = node.nodeName.toLowerCase();
		if (tag === "body" || tag === "html") {
			const iframeViewport = getIframeHostViewport(node);
			if (iframeViewport) {
				width = Math.max(width, iframeViewport.width);
				height = Math.max(height, iframeViewport.height);
			}
		}
		return {
			x: anchor.x + clientRect.x,
			y: anchor.y + clientRect.y,
			width,
			height
		};
	}
	if (anchor.width <= 0 || anchor.height <= 0) return null;
	return {
		x: anchor.x,
		y: anchor.y,
		width: anchor.width,
		height: anchor.height
	};
}
/**
* Search the host iframe from inside iframe up along parentNode and return to the width of clientRects.
* Example: body/html -> IFRAME.
*/
function getIframeHostViewport(node) {
	let current = node.parentNode;
	while (current) {
		const tag = current.nodeName.toUpperCase();
		if (tag === "IFRAME" || tag === "FRAME") {
			const cr = current.snapshotNode?.clientRects;
			if (cr && cr.width > 0 && cr.height > 0) return {
				width: cr.width,
				height: cr.height
			};
			return null;
		}
		current = current.parentNode;
	}
	return null;
}
/**
* Returns a local view formed by the nearest scrolling ancestors; continues to search up when no effective rectangle exists.
*/
function getScrollableAncestorViewport(node) {
	let current = node.parentNode;
	while (current) {
		if (current.renderInfo?.isScrollable) {
			const viewport = getNodeViewportRect(current);
			if (viewport) return viewport;
		}
		current = current.parentNode;
	}
	return null;
}
/**
* Returns the HTML view of the current page when there is no scrollable ancestor.
* Find the current HTML along node.parentNode ; if not, find the backup HTML at the end of htmlFrames .
*/
function getPageViewport(node, htmlFrames) {
	let current = node;
	while (current) {
		if (current.nodeType === 1 && current.nodeName === "HTML" && current.snapshotNode?.clientRects) return getNodeViewportRect(current);
		current = current.parentNode;
	}
	for (let i = htmlFrames.length - 1; i >= 0; i--) {
		const frame = htmlFrames[i];
		if (!frame) continue;
		if (frame.nodeType === 1 && frame.nodeName === "HTML" && frame.snapshotNode?.clientRects) return getNodeViewportRect(frame);
	}
	return null;
}
/**
* Calculates the state of the element relative to the local view.
* Returns three-state instead of simple boolean values: visible for rectangle intersections; expand for centrepoints within extension ranges; hidden for both.
*/
function checkFrameVisibility(node, elementBounds, htmlFrames, expand) {
	const containerViewport = getScrollableAncestorViewport(node) ?? getPageViewport(node, htmlFrames);
	if (!containerViewport) return { state: "visible" };
	const vpLeft = containerViewport.x;
	const vpTop = containerViewport.y;
	const vpRight = vpLeft + containerViewport.width;
	const vpBottom = vpTop + containerViewport.height;
	const inH = elementBounds.x + elementBounds.width > vpLeft && elementBounds.x < vpRight;
	const inV = elementBounds.y + elementBounds.height > vpTop && elementBounds.y < vpBottom;
	if (inH && inV) return { state: "visible" };
	if (expand !== void 0 && expand > 0) {
		const expandV = expand * containerViewport.height;
		const expandH = expand * containerViewport.width;
		const centerX = elementBounds.x + elementBounds.width / 2;
		const centerY = elementBounds.y + elementBounds.height / 2;
		const inHExpand = centerX > vpLeft - expandH && centerX < vpRight + expandH;
		const inVExpand = centerY > vpTop - expandV && centerY < vpBottom + expandV;
		if (centerY < vpTop && centerY > vpTop - expandV && inHExpand) return {
			state: "expand",
			direction: "above"
		};
		if (centerY >= vpBottom && centerY < vpBottom + expandV && inHExpand) return {
			state: "expand",
			direction: "below"
		};
		if (centerX < vpLeft && centerX > vpLeft - expandH && inVExpand) return {
			state: "expand",
			direction: "left"
		};
		if (centerX >= vpRight && centerX < vpRight + expandH && inVExpand) return {
			state: "expand",
			direction: "right"
		};
	}
	return { state: "hidden" };
}
//#endregion
//#region src/browser/dom/tree/ax-fetch.ts
/**
* Nodes whose accessible name the pipeline can actually consult.
*
* - candidates reach it through hasContent() during pruning;
* - visual elements reach it through the serializer, which asks for their text;
* - structural children (table cells and friends) reach it the same way, but
*   only matter when they wrap a candidate — that is exactly the case where
*   local text extraction comes back empty, because the walk stops at the
*   nested candidate and the cell's text lives inside it. They qualify even
*   when off-screen, since the serializer still renders the expanded zone.
*
* The root is included so the page title stays available.
*/
function collectNodesNeedingAx(root) {
	const nodes = [root];
	const visit = (node) => {
		let subtreeHasCandidate = !!node.renderInfo?.isCandidate;
		for (const child of node.childrenNodes ?? []) if (visit(child)) subtreeHasCandidate = true;
		for (const shadow of node.shadowRoots ?? []) if (visit(shadow)) subtreeHasCandidate = true;
		if (node.contentDocument && visit(node.contentDocument)) subtreeHasCandidate = true;
		if ((node.renderInfo?.isCandidate || isVisualTopNode(node) || STRUCTURAL_CHILD_TAGS.has(node.nodeName.toLowerCase()) && subtreeHasCandidate) && node !== root) nodes.push(node);
		return subtreeHasCandidate;
	};
	visit(root);
	return nodes;
}
/**
* Attach AX data to the nodes that can use it (assumes CDP is attached and
* computeRenderInfo has run).
*/
async function fetchAxForUsedNodes(root, cdpClient, oopifManager) {
	const nodes = collectNodesNeedingAx(root);
	if (nodes.length === 0) return;
	await Promise.all(nodes.map(async (node) => {
		const axNode = (await (node.oopifSessionId && oopifManager ? (method, params) => oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => cdpClient.sendCommand(method, params))("Accessibility.getPartialAXTree", {
			backendNodeId: node.backendNodeId,
			fetchRelatives: false
		}).catch(() => void 0))?.nodes?.find((n) => n.backendDOMNodeId === node.backendNodeId);
		if (axNode) node.axNode = buildEnhancedAXNode(axNode);
	}));
}
//#endregion
//#region src/browser/dom/tree/render-info.ts
/**
* Compute render info for DOM tree
*/
async function computeRenderInfo(root, cdpClient, options, oopifManager) {
	const expand = options?.expand;
	initRenderInfo(root, void 0, [], expand);
	await checkTopElements(root, cdpClient, oopifManager);
	markInteractiveCandidates(root);
	await fetchClickListenerSignatures(root, cdpClient, oopifManager);
	deduplicateByListeners(root);
	if (!options?.fullAX) await fetchAxForUsedNodes(root, cdpClient, oopifManager);
}
const SCROLLABLE_OVERFLOW_VALUES = /* @__PURE__ */ new Set([
	"auto",
	"scroll",
	"overlay",
	"hidden"
]);
const OVERLAY_COVERAGE_THRESHOLD = .75;
const COMMON_CONTAINER_TAGS = /* @__PURE__ */ new Set([
	"div",
	"main",
	"section",
	"article",
	"aside",
	"nav",
	"body",
	"html"
]);
function getMainViewportSize(root) {
	let bestArea = 0;
	let viewport = null;
	const visit = (node) => {
		if (node.nodeName === "HTML") {
			const clientRects = node.snapshotNode?.clientRects;
			if (clientRects && clientRects.width > 0 && clientRects.height > 0) {
				const area = clientRects.width * clientRects.height;
				if (area > bestArea) {
					bestArea = area;
					viewport = {
						width: clientRects.width,
						height: clientRects.height
					};
				}
			}
		}
		for (const child of node.childrenNodes ?? []) visit(child);
		for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return viewport;
}
function getViewportCoverageRatio(bounds, viewport) {
	const overlapLeft = Math.max(0, bounds.x);
	const overlapTop = Math.max(0, bounds.y);
	const overlapRight = Math.min(viewport.width, bounds.x + bounds.width);
	const overlapBottom = Math.min(viewport.height, bounds.y + bounds.height);
	const overlapArea = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop);
	const viewportArea = viewport.width * viewport.height;
	return viewportArea > 0 ? overlapArea / viewportArea : 0;
}
function isVisuallyHiddenNativeControl(node) {
	if (node.nodeType !== 1) return false;
	const tag = node.nodeName.toLowerCase();
	const isHiddenSelect = tag === "select";
	const isHiddenCheckboxRadio = tag === "input" && ["checkbox", "radio"].includes((node.attributes?.type ?? "text").toLowerCase());
	if (!isHiddenSelect && !isHiddenCheckboxRadio) return false;
	const bounds = node.snapshotNode?.bounds;
	const opacityRaw = node.snapshotNode?.computedStyles?.opacity ?? "1";
	const opacity = Number.parseFloat(opacityRaw);
	const isOpacityHidden = Number.isFinite(opacity) && opacity <= 0;
	const isZeroSize = !!bounds && (bounds.width <= 0 || bounds.height <= 0);
	return isOpacityHidden || isZeroSize;
}
/**
* Check if a node is a scrollable container.
* Compares scrollRects vs clientRects (+1 tolerance for float rounding),
* then validates CSS overflow allows scrolling.
*/
function checkIsScrollable(node, htmlFrames) {
	const tag = node.nodeName.toLowerCase();
	const isInIframe = htmlFrames.some((f) => f.nodeName === "IFRAME" || f.nodeName === "FRAME");
	if ((tag === "html" || tag === "body") && !isInIframe) return false;
	const snapshot = node.snapshotNode;
	if (!snapshot?.scrollRects || !snapshot?.clientRects) return false;
	const hasVerticalScroll = snapshot.scrollRects.height > snapshot.clientRects.height + 1;
	const hasHorizontalScroll = snapshot.scrollRects.width > snapshot.clientRects.width + 1;
	if (!hasVerticalScroll && !hasHorizontalScroll) return false;
	const styles = snapshot.computedStyles;
	if (!styles) return COMMON_CONTAINER_TAGS.has(node.nodeName.toLowerCase());
	const overflowY = styles["overflow-y"] ?? styles["overflow"] ?? "visible";
	const overflowX = styles["overflow-x"] ?? styles["overflow"] ?? "visible";
	return hasVerticalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowY) || hasHorizontalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowX);
}
/**
* Find the first scrollable container inside shadow roots.
* Used to propagate scrollableContainerId to slotted light DOM children.
*/
function findShadowScrollContainer(shadowRoots) {
	for (const shadowRoot of shadowRoots) {
		const result = findFirstScrollable(shadowRoot);
		if (result !== void 0) return result;
	}
}
function findFirstScrollable(node) {
	if (node.renderInfo?.isScrollable) return node.backendNodeId;
	for (const child of node.childrenNodes ?? []) {
		const result = findFirstScrollable(child);
		if (result !== void 0) return result;
	}
}
/**
* Initialize renderInfo on all nodes in the tree.
* Also computes expandedViewportPosition using frame-aware visibility check.
*/
function initRenderInfo(node, parentScrollableId, htmlFrames = [], expand, parentFrameState = "visible") {
	const shadowRoots = node.shadowRoots ?? [];
	const isShadowHost = shadowRoots.length > 0;
	const isIframeHost = node.contentDocument !== void 0;
	const isInteractive = ClickableElementDetector.isInteractive(node);
	const isFill = ClickableElementDetector.isFillable(node);
	node.renderInfo.isVisuallyHiddenNativeControl = isVisuallyHiddenNativeControl(node);
	const isScrollable = checkIsScrollable(node, htmlFrames);
	const scrollableId = isScrollable ? node.backendNodeId : parentScrollableId;
	const visResult = checkElementVisibility(node, htmlFrames, expand, parentFrameState);
	node.renderInfo.isVisible = visResult.isVisible;
	node.renderInfo.isInteractive = isInteractive;
	node.renderInfo.isTopElement = false;
	node.renderInfo.expandedViewportPosition = visResult.expandedViewportPosition;
	node.renderInfo.isScrollable = isScrollable;
	node.renderInfo.scrollableContainerId = parentScrollableId;
	node.renderInfo.isSelectOption = false;
	node.renderInfo.isShadowHost = isShadowHost;
	node.renderInfo.isIframeHost = isIframeHost;
	node.renderInfo.isFill = isFill;
	const upper = node.nodeType === 1 ? node.nodeName.toUpperCase() : "";
	const isFrameElement = upper === "IFRAME" || upper === "FRAME";
	const isFrameHtml = node.nodeType === 1 && node.nodeName === "HTML" && !!node.frameId;
	const updatedFrames = isFrameElement || isFrameHtml ? [...htmlFrames, node] : htmlFrames;
	for (const shadowRoot of shadowRoots) initRenderInfo(shadowRoot, scrollableId, updatedFrames, expand, parentFrameState);
	let childScrollableId = scrollableId;
	if (isShadowHost) {
		const shadowScrollId = findShadowScrollContainer(shadowRoots);
		if (shadowScrollId !== void 0) childScrollableId = shadowScrollId;
	}
	const children = node.childrenNodes ?? [];
	for (const child of children) initRenderInfo(child, childScrollableId, updatedFrames, expand, parentFrameState);
	if (node.contentDocument) {
		let iframeState = parentFrameState;
		if (parentFrameState === "visible") {
			const iframeVis = checkElementVisibility(node, htmlFrames, expand);
			if (iframeVis.isVisible) iframeState = "visible";
			else if (iframeVis.expandedViewportPosition) iframeState = iframeVis.expandedViewportPosition;
			else iframeState = "hidden";
		}
		initRenderInfo(node.contentDocument, scrollableId, updatedFrames, expand, iframeState);
	}
}
/**
* Walk up hit node's parent chain via CDP to check if it's related to the target.
* Needed when hit node is not in our tree (e.g., shadow DOM internals, pseudo-elements).
*/
async function checkHitNodeParentChain(sendCmd, hitBackendNodeId, targetBackendNodeId, targetAncestors, nodeByBackendId, maxDepth = 20) {
	let currentBackendNodeId = hitBackendNodeId;
	for (let depth = 0; depth < maxDepth; depth++) try {
		const parentNodeId = (await sendCmd("DOM.describeNode", {
			backendNodeId: currentBackendNodeId,
			depth: 0
		})).node.parentId;
		if (!parentNodeId) return false;
		const parentBackendNodeId = (await sendCmd("DOM.describeNode", {
			nodeId: parentNodeId,
			depth: 0
		})).node.backendNodeId;
		if (parentBackendNodeId === targetBackendNodeId) return true;
		if (targetAncestors.has(parentBackendNodeId)) return true;
		const parentNode = nodeByBackendId.get(parentBackendNodeId);
		if (parentNode) {
			let current = parentNode.parentNode;
			while (current) {
				if (current.backendNodeId === targetBackendNodeId) return true;
				current = current.parentNode;
			}
			return false;
		}
		currentBackendNodeId = parentBackendNodeId;
	} catch {
		return false;
	}
	return false;
}
/**
* Run elementFromPoint via Runtime.evaluate, resolve to backendNodeId.
*/
async function elementFromPoint(sendCmd, centerX, centerY) {
	return (await sendCmd("DOM.getNodeForLocation", {
		x: centerX,
		y: centerY
	}).catch(() => void 0))?.backendNodeId;
}
/**
* Scroll offset of the main frame's document, as the builder subtracted it when
* turning snapshot bounds into viewport-relative absolutePosition.
*/
function findMainFrameScroll(root) {
	let found = null;
	const visit = (node) => {
		if (found) return;
		if (node.contentDocument) return;
		if (node.nodeName === "HTML" && node.frameId && node.snapshotNode?.scrollRects) {
			found = {
				x: node.snapshotNode.scrollRects.x,
				y: node.snapshotNode.scrollRects.y
			};
			return;
		}
		for (const child of node.childrenNodes ?? []) visit(child);
	};
	visit(root);
	return found ?? {
		x: 0,
		y: 0
	};
}
/**
* Check if elements are top-level (not occluded) using elementFromPoint.
*/
async function checkTopElements(root, cdpClient, oopifManager) {
	const nodesToCheck = [];
	const nodeByBackendId = /* @__PURE__ */ new Map();
	const pseudoToHost = /* @__PURE__ */ new Map();
	const collectNodes = (node) => {
		if (node.renderInfo.isVisible) {
			nodesToCheck.push(node);
			nodeByBackendId.set(node.backendNodeId, node);
		}
		for (const pseudoId of node.pseudoElementIds ?? []) pseudoToHost.set(pseudoId, node.backendNodeId);
		for (const child of node.childrenNodes ?? []) collectNodes(child);
		for (const shadowRoot of node.shadowRoots ?? []) collectNodes(shadowRoot);
		if (node.contentDocument) collectNodes(node.contentDocument);
	};
	collectNodes(root);
	if (nodesToCheck.length === 0) return;
	const mainScroll = findMainFrameScroll(root);
	const getAncestorBackendIds = (node) => {
		const ancestors = /* @__PURE__ */ new Set();
		const sessionId = node.oopifSessionId;
		let current = node.parentNode;
		while (current) {
			if (current.oopifSessionId !== sessionId) break;
			ancestors.add(current.backendNodeId);
			current = current.parentNode;
		}
		return ancestors;
	};
	const checkPromises = nodesToCheck.map(async (node) => {
		const pos = node.absolutePosition ?? node.snapshotNode?.bounds;
		if (!pos) {
			node.renderInfo.isTopElement = false;
			return;
		}
		const centerX = Math.round(pos.x + pos.width / 2 + mainScroll.x);
		const centerY = Math.round(pos.y + pos.height / 2 + mainScroll.y);
		const ancestors = getAncestorBackendIds(node);
		const sendCmd = node.oopifSessionId && oopifManager ? (method, params) => oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => cdpClient.sendCommand(method, params);
		try {
			let hitBackendNodeId;
			if (node.oopifSessionId && oopifManager) {
				const localBounds = node.snapshotNode?.bounds;
				if (!localBounds) {
					node.renderInfo.isTopElement = false;
					return;
				}
				hitBackendNodeId = await elementFromPoint(sendCmd, Math.round(localBounds.x + localBounds.width / 2), Math.round(localBounds.y + localBounds.height / 2));
			} else hitBackendNodeId = await elementFromPoint(sendCmd, centerX, centerY);
			if (hitBackendNodeId === void 0) {
				node.renderInfo.isTopElement = false;
				return;
			}
			hitBackendNodeId = pseudoToHost.get(hitBackendNodeId) ?? hitBackendNodeId;
			node.renderInfo.hitBackendNodeId = hitBackendNodeId;
			if (hitBackendNodeId === node.backendNodeId) {
				node.renderInfo.isTopElement = true;
				return;
			}
			if (ancestors.has(hitBackendNodeId)) {
				node.renderInfo.isTopElement = true;
				return;
			}
			const hitNode = nodeByBackendId.get(hitBackendNodeId);
			if (hitNode) {
				if (getAncestorBackendIds(hitNode).has(node.backendNodeId)) {
					node.renderInfo.isTopElement = true;
					return;
				}
			} else if (await checkHitNodeParentChain(sendCmd, hitBackendNodeId, node.backendNodeId, ancestors, nodeByBackendId)) {
				node.renderInfo.isTopElement = true;
				return;
			}
			node.renderInfo.isTopElement = false;
		} catch {
			node.renderInfo.isTopElement = false;
		}
	});
	await Promise.all(checkPromises);
}
/**
* Mark interactive top elements as candidates (no index assignment yet)
* For expanded viewport elements, only mark as candidate if not covered by overlay
*/
function markInteractiveCandidates(root) {
	const expandElements = [];
	const visibleElements = [];
	const markSelectDescendantsAsCandidates = (node) => {
		const visit = (current) => {
			if (current.nodeType === 1) {
				const tagName = current.nodeName.toLowerCase();
				if (tagName === "option" || tagName === "optgroup") {
					current.renderInfo.isCandidate = true;
					current.renderInfo.isSelectOption = true;
				}
			}
			for (const child of current.childrenNodes ?? []) visit(child);
			for (const shadowRoot of current.shadowRoots ?? []) visit(shadowRoot);
			if (current.contentDocument) visit(current.contentDocument);
		};
		for (const child of node.childrenNodes ?? []) visit(child);
	};
	const collectElements = (node) => {
		if (node.renderInfo?.isVisible && node.nodeType === 1) visibleElements.push(node);
		if (node.renderInfo?.expandedViewportPosition !== void 0) expandElements.push(node);
		for (const child of node.childrenNodes ?? []) collectElements(child);
		for (const shadowRoot of node.shadowRoots ?? []) collectElements(shadowRoot);
		if (node.contentDocument) collectElements(node.contentDocument);
	};
	collectElements(root);
	let highestOverlayPaintOrder;
	let highestOverlayNode;
	if (expandElements.length > 0) {
		const viewport = getMainViewportSize(root);
		if (viewport) {
			const largeVisibleElements = visibleElements.filter((node) => {
				const tagName = node.nodeName.toLowerCase();
				if (tagName === "html" || tagName === "body") return false;
				if (node.attributes.id === "__elements_highlight_container__") return false;
				const styles = node.snapshotNode?.computedStyles;
				const position = styles?.["position"];
				if (position !== "fixed" && position !== "absolute") return false;
				if (styles?.["pointer-events"] === "none") return false;
				const bounds = node.absolutePosition ?? node.snapshotNode?.bounds;
				if (!bounds) return false;
				return getViewportCoverageRatio(bounds, viewport) >= OVERLAY_COVERAGE_THRESHOLD;
			});
			if (largeVisibleElements.length > 0) {
				highestOverlayNode = largeVisibleElements.reduce((highest, node) => {
					const highestPaintOrder = highest.snapshotNode?.paintOrder ?? 0;
					return (node.snapshotNode?.paintOrder ?? 0) > highestPaintOrder ? node : highest;
				});
				highestOverlayPaintOrder = highestOverlayNode.snapshotNode?.paintOrder ?? 0;
				highestOverlayNode.renderInfo.isOverlay = true;
			}
		}
	}
	const processNode = (node) => {
		if (!node.renderInfo) return;
		if (node.renderInfo.expandedViewportPosition !== void 0) {
			const nodePaintOrder = node.snapshotNode?.paintOrder ?? 0;
			node.renderInfo.isBlockedByOverlay = highestOverlayPaintOrder !== void 0 && highestOverlayPaintOrder > nodePaintOrder;
		}
		if (node.renderInfo.isInteractive) {
			if (node.renderInfo.isTopElement) node.renderInfo.isCandidate = true;
			else if (node.renderInfo.expandedViewportPosition !== void 0) node.renderInfo.isCandidate = true;
			else if (node.renderInfo.isVisuallyHiddenNativeControl && node.renderInfo.isVisible) node.renderInfo.isCandidate = true;
		}
		if (node.renderInfo.isCandidate && node.nodeType === 1 && node.nodeName.toLowerCase() === "select") {
			node.renderInfo.isSelect = true;
			markSelectDescendantsAsCandidates(node);
		}
		for (const child of node.childrenNodes ?? []) processNode(child);
		for (const shadowRoot of node.shadowRoots ?? []) processNode(shadowRoot);
		if (node.contentDocument) processNode(node.contentDocument);
	};
	processNode(root);
}
/**
* Create a CDP command sender that routes to the correct session.
* For OOPIF nodes, commands go through the OOPIF session;
* for main-frame nodes, commands go through the main CDPClient.
*/
function createSendCommand$1(node, cdpClient, oopifManager) {
	if (node.oopifSessionId && oopifManager) {
		const sessionId = node.oopifSessionId;
		return (method, params) => oopifManager.sendCommand(sessionId, method, params);
	}
	return (method, params) => cdpClient.sendCommand(method, params);
}
/**
* Extract click handlers from an element and its ancestor chain.
* Covers React, Vue 2/3, jQuery, and inline onclick.
*/
const EXTRACT_ELEMENT_HANDLERS_JS = `
function() {
  var handlers = [];

  function extractFromElement(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.startsWith('__reactProps$') || key.startsWith('__reactInternalInstance$')) {
        var props = el[key];
        if (props && typeof props.onClick === 'function') {
          handlers.push(props.onClick.toString());
        }
      }
      if (key.startsWith('__reactEvents$')) {
        var events = el[key];
        if (events && typeof events.onClick === 'function') {
          handlers.push(events.onClick.toString());
        }
      }
    }

    if (el.__vue__) {
      var vm = el.__vue__;
      if (vm.$listeners && typeof vm.$listeners.click === 'function') {
        handlers.push(vm.$listeners.click.toString());
      }
      if (vm._events && vm._events.click) {
        var clicks = vm._events.click;
        for (var j = 0; j < clicks.length; j++) {
          if (typeof clicks[j] === 'function') handlers.push(clicks[j].toString());
        }
      }
    }

    if (el.__vueParentComponent) {
      var vnode = el.__vueParentComponent;
      if (vnode.props && typeof vnode.props.onClick === 'function') {
        handlers.push(vnode.props.onClick.toString());
      }
    }

    if (typeof jQuery !== 'undefined' && jQuery._data) {
      try {
        var jqEvents = jQuery._data(el, 'events');
        if (jqEvents && jqEvents.click) {
          for (var k = 0; k < jqEvents.click.length; k++) {
            if (typeof jqEvents.click[k].handler === 'function') {
              handlers.push(jqEvents.click[k].handler.toString());
            }
          }
        }
      } catch(e) {}
    }
  }

  // 1. Self
  extractFromElement(this);

  // 2. Walk ancestor chain to find delegated click handlers
  var el = this.parentElement;
  var depth = 0;
  while (el && depth < 50) {
    extractFromElement(el);
    el = el.parentElement;
    depth++;
  }

  return handlers;
}
`;
/**
* Get click listener signatures for a node.
* Combines CDP native listeners + framework-specific handler extraction.
*/
async function getClickListenerSignatures(node, cdpClient, oopifManager) {
	const sigs = [];
	const sendCmd = createSendCommand$1(node, cdpClient, oopifManager);
	try {
		const objectId = (await sendCmd("DOM.resolveNode", { backendNodeId: node.backendNodeId }))?.object?.objectId;
		if (!objectId) return sigs;
		const fwHandlers = (await sendCmd("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: EXTRACT_ELEMENT_HANDLERS_JS,
			returnByValue: true
		}))?.result?.value;
		if (Array.isArray(fwHandlers)) for (const h of fwHandlers) sigs.push(`framework:${h}`);
	} catch {}
	return sigs;
}
/**
* Batch fetch click listener signatures for all isCandidate nodes.
* Must run after markInteractiveCandidates since it only targets candidate nodes.
*/
async function fetchClickListenerSignatures(root, cdpClient, oopifManager) {
	const allCandidates = [];
	const collectAll = (node) => {
		if (node.renderInfo?.isCandidate) allCandidates.push(node);
		for (const child of node.childrenNodes ?? []) collectAll(child);
	};
	collectAll(root);
	if (allCandidates.length === 0) return;
	try {
		await cdpClient.sendCommand("DOM.enable");
	} catch {}
	await Promise.all(allCandidates.map(async (node) => {
		const sigs = await getClickListenerSignatures(node, cdpClient, oopifManager);
		if (node.renderInfo) node.renderInfo.clickListenerSignatures = sigs;
	}));
}
function collectCandidateDescendants(node) {
	const result = [];
	const visit = (n, isRoot) => {
		if (!isRoot && n.renderInfo?.isCandidate) result.push(n);
		for (const child of n.childrenNodes ?? []) visit(child, false);
	};
	visit(node, true);
	return result;
}
/**
* Mark descendant candidates as isDuplicateListener if they share the same
* click target (hitBackendNodeId) or click listener signatures as an ancestor candidate.
*/
function deduplicateByListeners(root) {
	const visit = (node) => {
		if (node.renderInfo?.isDuplicateListener) return;
		if (node.renderInfo?.isCandidate) {
			const descendants = collectCandidateDescendants(node);
			for (const desc of descendants) {
				if (desc.renderInfo?.isDuplicateListener) continue;
				if (!desc.renderInfo) continue;
				if (node.oopifSessionId === desc.oopifSessionId && node.renderInfo.hitBackendNodeId !== void 0 && desc.renderInfo.hitBackendNodeId === node.renderInfo.hitBackendNodeId && desc.renderInfo.hitBackendNodeId !== desc.backendNodeId) {
					desc.renderInfo.isDuplicateListener = true;
					desc.renderInfo.listenerHostId = node.backendNodeId;
					node.renderInfo.isListenerHost = true;
					continue;
				}
				const parentSigs = node.renderInfo.clickListenerSignatures;
				const childSigs = desc.renderInfo.clickListenerSignatures;
				if (!parentSigs || parentSigs.length === 0) continue;
				if (!childSigs || childSigs.length === 0) continue;
				if (node.renderInfo.hitBackendNodeId === void 0 || desc.renderInfo.hitBackendNodeId === void 0 || desc.renderInfo.hitBackendNodeId !== node.renderInfo.hitBackendNodeId) continue;
				const parentSigSet = new Set(parentSigs);
				if (childSigs.every((sig) => parentSigSet.has(sig))) {
					desc.renderInfo.isDuplicateListener = true;
					desc.renderInfo.listenerHostId = node.backendNodeId;
					node.renderInfo.isListenerHost = true;
				}
			}
		}
		for (const child of node.childrenNodes ?? []) visit(child);
	};
	visit(root);
}
//#endregion
//#region src/browser/dom/tree/scroll-container.ts
/**
* Build scroll container map for all expanded viewport elements.
* Uses pre-computed scrollableContainerId to avoid parent chain walks.
*
* @param root - Pruned tree to iterate
* @param lookup - nodeKey → un-pruned node (containers may have been pruned away)
*/
function buildScrollContainerMap(root, lookup) {
	const scrollContainerMap = /* @__PURE__ */ new Map();
	const containerToIndex = /* @__PURE__ */ new Map();
	let nextIndex = 1;
	const containerById = /* @__PURE__ */ new Map();
	if (lookup) {
		for (const node of lookup.values()) if (node.renderInfo?.isScrollable) containerById.set(node.backendNodeId, node);
	}
	for (const [id, node] of containerById) {
		const sr = node.snapshotNode?.scrollRects;
		const cr = node.snapshotNode?.clientRects;
		if (!node.renderInfo.isVisible || !sr || !cr || cr.width <= 0 || cr.height <= 0) continue;
		if (sr.height <= cr.height + 1 && sr.width <= cr.width + 1) continue;
		const index = nextIndex++;
		containerToIndex.set(id, index);
		scrollContainerMap.set(index, node);
		node.renderInfo.isHorizontalScroll = sr.height <= cr.height + 1 && sr.width > cr.width + 1;
	}
	const visit = (node) => {
		const containerId = node.renderInfo?.scrollableContainerId;
		if (node.renderInfo?.expandedViewportPosition !== void 0 && containerId !== void 0) {
			const expandDir = node.renderInfo.expandedViewportPosition;
			let index = containerToIndex.get(containerId);
			if (index === void 0) {
				const containerNode = containerById.get(containerId);
				if (containerNode) {
					index = nextIndex++;
					containerToIndex.set(containerId, index);
					scrollContainerMap.set(index, containerNode);
					if (containerNode.renderInfo) containerNode.renderInfo.isHorizontalScroll = expandDir === "left" || expandDir === "right";
				}
			}
			if (index !== void 0) {
				node.renderInfo.scrollContainerIndex = index;
				const originalNode = lookup?.get(nodeKey(node));
				if (originalNode?.renderInfo) originalNode.renderInfo.scrollContainerIndex = index;
			}
		}
		for (const child of node.childrenNodes ?? []) visit(child);
		for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return scrollContainerMap;
}
//#endregion
//#region src/browser/dom/tree/visual-element.ts
/**
* Build visual element map keyed by encoded view ID.
*/
function buildVisualElementMap(root) {
	const map = /* @__PURE__ */ new Map();
	const visit = (node) => {
		if (node.nodeType === 1 && node.renderInfo?.isTopElement && isVisualTopNode(node)) map.set(encodeViewId(node.backendNodeId), node);
		for (const child of node.childrenNodes ?? []) visit(child);
	};
	visit(root);
	return map;
}
//#endregion
//#region src/browser/dom/tree/diff.ts
/**
* Create a diff tree from two DOM snapshots.
* Returns null if roots differ (full page navigation).
* @param show - 'both' (default), 'added' (only + elements), or 'removed' (only - elements)
*/
function createDiffTree(oldTree, newTree, show = "both") {
	if (oldTree.backendNodeId !== newTree.backendNodeId) return null;
	const { copy: merged } = copyDomTree(newTree);
	const oldTop = collectTopElements(oldTree);
	const newTop = collectTopElements(merged);
	const oldIds = new Set(oldTop.keys());
	const newIds = new Set(newTop.keys());
	const mergedLookup = buildNodeKeyLookup(merged);
	if (show !== "removed") {
		for (const key of newIds) if (!oldIds.has(key)) markDiff(newTop.get(key), "added", "new-element");
		const oldExpandedIds = new Set(collectExpandedElements(oldTree).keys());
		const oldAllIds = /* @__PURE__ */ new Set([...oldIds, ...oldExpandedIds]);
		const newExpanded = collectExpandedElements(merged);
		for (const [key, node] of newExpanded) if (!oldAllIds.has(key)) markDiff(node, "added", "new-expanded-element");
	}
	for (const key of oldIds) {
		if (!newIds.has(key)) continue;
		const oldNode = oldTop.get(key);
		const newNode = newTop.get(key);
		if (!oldNode.renderInfo.isCandidate || !hasAncestorCandidate(oldNode)) continue;
		if (!hasContentChanged(oldNode, newNode)) continue;
		if (show !== "removed") markDiff(newNode, "added", "content-changed");
		if (show !== "added") insertBefore(newNode, shallowRemoved(oldNode, newNode.parentNode, "content-changed"));
	}
	for (const key of oldIds) {
		if (!newIds.has(key)) continue;
		const oldNode = oldTop.get(key);
		const newNode = newTop.get(key);
		const oldCandidate = !!oldNode.renderInfo?.isCandidate;
		const newCandidate = !!newNode.renderInfo?.isCandidate;
		if (oldCandidate === newCandidate) continue;
		if (newCandidate && show !== "removed") markDiff(newNode, "added", "candidate-gained");
		if (oldCandidate && show !== "added") markDiff(newNode, "removed", "candidate-lost");
	}
	if (show !== "added") {
		const visit = (node, slot) => {
			if (node.renderInfo.isTopElement) {
				const key = nodeKey(node);
				if (!newIds.has(key)) {
					const existing = mergedLookup.get(key);
					if (existing) overwriteWithRemoved(existing, node);
					else if (node.parentNode) {
						const parent = mergedLookup.get(nodeKey(node.parentNode));
						if (parent) {
							const removed = shallowRemoved(node, parent, "element-gone");
							removed.renderInfo.isTopElement = false;
							insertByPaintOrder(parent, removed, slot);
							mergedLookup.set(key, removed);
						}
					}
				}
			}
			for (const c of node.childrenNodes ?? []) visit(c, "child");
			for (const s of node.shadowRoots ?? []) visit(s, "shadow");
			if (node.contentDocument) visit(node.contentDocument, "contentDocument");
		};
		visit(oldTree, "child");
	}
	return merged;
}
function markDiff(node, status, reason) {
	node.renderInfo.diffStatus = status;
	node.renderInfo.diffReason = reason;
}
function overwriteWithRemoved(target, oldNode) {
	target.renderInfo = {
		...oldNode.renderInfo,
		expandedViewportPosition: target.renderInfo.expandedViewportPosition,
		diffStatus: "removed",
		diffReason: "existing",
		cachedText: getAllTextTillNextCandidate(oldNode)
	};
	target.attributes = { ...oldNode.attributes };
	target.whitelistedAttributes = oldNode.whitelistedAttributes ? { ...oldNode.whitelistedAttributes } : void 0;
	target.axNode = oldNode.axNode ? { ...oldNode.axNode } : void 0;
}
function shallowRemoved(oldNode, parent, reason) {
	return {
		...oldNode,
		renderInfo: {
			...oldNode.renderInfo,
			diffStatus: "removed",
			diffReason: reason,
			cachedText: getAllTextTillNextCandidate(oldNode)
		},
		parentNode: parent,
		childrenNodes: [],
		shadowRoots: void 0,
		contentDocument: void 0,
		attributes: { ...oldNode.attributes },
		whitelistedAttributes: oldNode.whitelistedAttributes ? { ...oldNode.whitelistedAttributes } : void 0,
		axNode: oldNode.axNode ? { ...oldNode.axNode } : void 0
	};
}
function hasAncestorCandidate(node) {
	let cur = node.parentNode;
	while (cur) {
		if (cur.renderInfo?.isCandidate) return true;
		cur = cur.parentNode;
	}
	return false;
}
function getNodeText(node) {
	if (node.nodeType === 3 && node.nodeValue) return node.nodeValue.trim();
	return getAllTextTillNextCandidate(node);
}
function hasContentChanged(oldNode, newNode) {
	const oldText = getNodeText(oldNode);
	const newText = getNodeText(newNode);
	const { attrsStr: oldAttrs } = buildAttributesString(oldNode, oldText);
	const { attrsStr: newAttrs } = buildAttributesString(newNode, newText);
	return oldText !== newText || oldAttrs !== newAttrs;
}
function collectExpandedElements(root) {
	const map = /* @__PURE__ */ new Map();
	const visit = (node) => {
		if (node.renderInfo.expandedViewportPosition && !node.renderInfo.isTopElement) map.set(nodeKey(node), node);
		for (const c of node.childrenNodes ?? []) visit(c);
		for (const s of node.shadowRoots ?? []) visit(s);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return map;
}
function collectTopElements(root) {
	const map = /* @__PURE__ */ new Map();
	const visit = (node) => {
		if (node.renderInfo.isTopElement) map.set(nodeKey(node), node);
		for (const c of node.childrenNodes ?? []) visit(c);
		for (const s of node.shadowRoots ?? []) visit(s);
		if (node.contentDocument) visit(node.contentDocument);
	};
	visit(root);
	return map;
}
function insertBefore(target, node) {
	const parent = target.parentNode;
	if (!parent?.childrenNodes) return;
	const i = parent.childrenNodes.indexOf(target);
	if (i !== -1) parent.childrenNodes.splice(i, 0, node);
}
function insertByPaintOrder(parent, node, slot) {
	if (slot === "contentDocument") {
		parent.contentDocument = node;
		return;
	}
	const list = slot === "shadow" ? parent.shadowRoots ??= [] : parent.childrenNodes ??= [];
	const order = node.snapshotNode?.paintOrder ?? 0;
	const i = list.findIndex((c) => (c.snapshotNode?.paintOrder ?? 0) > order);
	if (i === -1) list.push(node);
	else list.splice(i, 0, node);
}
//#endregion
//#region src/browser/dom/markdown/ai-text.ts
/**
* Extract direct text content from a node.
* Combines two sources: axNode.name and immediate StaticText children's axNode.name.
*/
function getDirectTextContent(node) {
	const texts = [];
	if (node.axNode?.name && node.axNode.role && NAME_FROM_CONTENT_ROLES.has(node.axNode.role)) texts.push(node.axNode.name.trim());
	for (const child of node.childrenNodes ?? []) if (child.axNode?.role === "StaticText" && child.axNode?.name) texts.push(child.axNode.name.trim());
	return texts.filter(Boolean).join(" ").replace(/\s+/g, " ");
}
function truncateText(text, maxLength, showIndicator = true) {
	if (text.length <= maxLength) return {
		text,
		truncated: false,
		originalLength: text.length
	};
	const truncated = text.substring(0, maxLength);
	const lastSpace = truncated.lastIndexOf(" ");
	const cutPoint = lastSpace > maxLength * .7 ? lastSpace : maxLength;
	return {
		text: truncated.substring(0, cutPoint) + (showIndicator ? "..." : ""),
		truncated: true,
		originalLength: text.length
	};
}
const GLOBAL_STATE_FLAGS = ["disabled"];
const TAG_STATE_FLAGS = {
	button: ["aria-pressed"],
	select: ["aria-expanded"],
	details: [],
	video: [],
	audio: [],
	progress: [],
	meter: []
};
const INPUT_TYPE_STATE_FLAGS = {
	text: [
		"readonly",
		"required",
		"aria-invalid"
	],
	search: [
		"readonly",
		"required",
		"aria-invalid"
	],
	email: [
		"readonly",
		"required",
		"aria-invalid"
	],
	password: [
		"readonly",
		"required",
		"aria-invalid"
	],
	tel: [
		"readonly",
		"required",
		"aria-invalid"
	],
	url: [
		"readonly",
		"required",
		"aria-invalid"
	],
	number: [
		"readonly",
		"required",
		"aria-invalid"
	],
	checkbox: ["aria-checked"],
	radio: ["required"],
	range: [],
	file: ["required"],
	date: ["readonly", "required"],
	time: ["readonly", "required"],
	"datetime-local": ["readonly", "required"],
	month: ["readonly", "required"],
	week: ["readonly", "required"],
	color: [],
	submit: [],
	button: []
};
const TEXTAREA_STATE_FLAGS = [
	"readonly",
	"required",
	"aria-invalid"
];
function getStateFlags(attrs, tagName, inputType) {
	const flags = [];
	for (const attr of GLOBAL_STATE_FLAGS) if (attrs[attr] !== void 0) flags.push(attr);
	let tagFlags;
	if (tagName === "input") tagFlags = INPUT_TYPE_STATE_FLAGS[inputType || "text"];
	else if (tagName === "textarea") tagFlags = TEXTAREA_STATE_FLAGS;
	else tagFlags = TAG_STATE_FLAGS[tagName];
	if (tagFlags) {
		for (const attr of tagFlags) if (attr === "aria-checked") {
			if (attrs["aria-checked"] && attrs["aria-checked"] !== (attrs.checked || "false")) flags.push(`aria-checked=${attrs["aria-checked"]}`);
		} else if (attr === "aria-pressed") {
			if (attrs["aria-pressed"]) flags.push(`pressed=${attrs["aria-pressed"]}`);
		} else if (attr === "aria-expanded") {
			if (attrs["aria-expanded"]) flags.push(`expanded=${attrs["aria-expanded"]}`);
		} else if (attr === "aria-invalid") {
			if (attrs["aria-invalid"] === "true") flags.push("invalid");
		} else if (attrs[attr] !== void 0) flags.push(attr);
	}
	return flags;
}
const GLOBAL_CONTEXT_ATTRS = ["title", "aria-label"];
const TAG_CONTEXT_ATTRS = {
	button: ["aria-describedby"],
	a: [],
	img: [],
	select: [
		"name",
		"aria-describedby",
		"aria-controls"
	],
	details: [],
	video: [],
	audio: [],
	progress: [],
	meter: []
};
const INPUT_TYPE_CONTEXT_ATTRS = {
	text: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	search: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	email: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	password: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	tel: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	url: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	number: [
		"name",
		"placeholder",
		"aria-describedby"
	],
	checkbox: ["name"],
	radio: ["name"],
	range: [],
	file: ["name"],
	date: ["name", "aria-describedby"],
	time: ["name", "aria-describedby"],
	"datetime-local": ["name", "aria-describedby"],
	month: ["name", "aria-describedby"],
	week: ["name", "aria-describedby"],
	color: ["name"],
	submit: [],
	button: []
};
const TEXTAREA_CONTEXT_ATTRS = [
	"name",
	"placeholder",
	"aria-describedby"
];
const ROLE_CONTEXT_ATTRS = {
	combobox: ["aria-describedby", "aria-controls"],
	tab: ["aria-controls"],
	spinbutton: ["aria-describedby"],
	slider: [],
	switch: ["aria-describedby"]
};
function getContextInfo(text, attrs, tagName, inputType, role) {
	const context = [];
	const formatMap = {
		title: "title",
		"aria-label": "aria",
		placeholder: "placeholder",
		"aria-describedby": "described-by",
		"aria-controls": "controls",
		name: "name"
	};
	const addAttr = (attr) => {
		if (attrs[attr]) context.push(`${formatMap[attr] || attr}: ${attrs[attr]}`);
	};
	for (const attr of GLOBAL_CONTEXT_ATTRS) addAttr(attr);
	if (role && ROLE_CONTEXT_ATTRS[role]) for (const attr of ROLE_CONTEXT_ATTRS[role]) addAttr(attr);
	let tagAttrs;
	if (tagName === "input") tagAttrs = INPUT_TYPE_CONTEXT_ATTRS[inputType || "text"];
	else if (tagName === "textarea") tagAttrs = TEXTAREA_CONTEXT_ATTRS;
	else tagAttrs = TAG_CONTEXT_ATTRS[tagName];
	if (tagAttrs) {
		for (const attr of tagAttrs) if (!context.some((c) => c.startsWith(`${formatMap[attr] || attr}:`))) addAttr(attr);
	}
	if (text) {
		const normalizedText = text.toLowerCase();
		return context.filter((entry) => {
			const value = entry.substring(entry.indexOf(":") + 2).toLowerCase();
			return !normalizedText.includes(value) && !value.includes(normalizedText);
		});
	}
	return context;
}
function getLabelText(text, attrs) {
	return text || attrs["aria-label"] || attrs.title || attrs.placeholder || attrs.name || "";
}
function handleButton(_node, ctx) {
	const { text, attrs } = ctx;
	const type = attrs.type || "button";
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const context = getContextInfo(ctx.text, attrs, ctx.tagName, ctx.inputType, ctx.role);
	const parts = [];
	if (type !== "button") parts.push(`BUTTON[${type}]`);
	else parts.push("BUTTON");
	const hasContent = !!(text || flags.length > 0 || context.length > 0);
	if (text) parts.push(": " + text);
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	if (context.length > 0) parts.push(" (" + context.join("; ") + ")");
	return {
		text: parts.join(""),
		hasContent
	};
}
function handleLink(_node, ctx) {
	const { text, attrs } = ctx;
	const label = text || attrs["aria-label"] || attrs.title || attrs.id;
	if (!label) return {
		text: "LINK",
		hasContent: false
	};
	return {
		text: `LINK: ${label}`,
		hasContent: true
	};
}
function handleImage(_node, ctx) {
	const { attrs } = ctx;
	return {
		text: `IMAGE: ${attrs.alt || attrs.title || "Image"}`,
		hasContent: true
	};
}
function handleHeading(node, ctx) {
	const { text } = ctx;
	const tagName = node.nodeName.toLowerCase();
	const level = parseInt(tagName.charAt(1));
	const hashes = "#".repeat(Math.min(level, 6));
	if (!text) return {
		text: `${tagName}`,
		hasContent: false
	};
	return {
		text: `${hashes} ${text}`,
		hasContent: true
	};
}
function handleInputText(_node, ctx) {
	const { attrs } = ctx;
	const type = attrs.type || "text";
	const value = attrs.value || "";
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const context = getContextInfo(ctx.text, attrs, ctx.tagName, ctx.inputType, ctx.role);
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push(`INPUT[${type}]`);
	if (label) parts.push(`: ${label}`);
	if (value) {
		const { text: truncatedValue, truncated } = truncateText(value, 50, true);
		parts.push(` | ${truncatedValue}`);
		if (truncated) flags.push("truncated");
	} else parts.push(" | empty");
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	if (context.length > 0) parts.push(" (" + context.join("; ") + ")");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputPassword(_node, ctx) {
	const { attrs } = ctx;
	const value = attrs.value || "";
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const context = getContextInfo(ctx.text, attrs, ctx.tagName, ctx.inputType, ctx.role);
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("INPUT[password]");
	if (label) parts.push(`: ${label}`);
	if (value) parts.push(` | ${"*".repeat(Math.min(value.length, 8))}`);
	else parts.push(" | empty");
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	if (context.length > 0) parts.push(" (" + context.join("; ") + ")");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputNumber(_node, ctx) {
	const { attrs } = ctx;
	const value = attrs.value || "";
	const min = attrs.min;
	const max = attrs.max;
	const step = attrs.step;
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("INPUT[number]");
	if (label) parts.push(`: ${label}`);
	if (value) parts.push(` | ${value}`);
	else parts.push(" | empty");
	const constraints = [];
	if (min !== void 0) constraints.push(`min=${min}`);
	if (max !== void 0) constraints.push(`max=${max}`);
	if (step !== void 0) constraints.push(`step=${step}`);
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	if (constraints.length > 0) parts.push(" (" + constraints.join(", ") + ")");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputCheckbox(_node, ctx) {
	const { attrs } = ctx;
	const checked = attrs.checked === "true" || attrs.checked === "" || attrs.checked === "checked";
	const ariaChecked = attrs["aria-checked"];
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(ctx.text, attrs);
	let state = "unchecked";
	if (ariaChecked === "mixed") state = "indeterminate";
	else if (checked || ariaChecked === "true") state = "checked";
	let result = `CHECKBOX: ${label} = ${state}`;
	if (flags.length > 0) result += ` [${flags.join(", ")}]`;
	return {
		text: result,
		hasContent: true
	};
}
function handleInputRadio(_node, ctx) {
	const { attrs } = ctx;
	const checked = attrs.checked === "true" || attrs.checked === "" || attrs.checked === "checked";
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(ctx.text, attrs);
	const name = attrs.name;
	const parts = [];
	parts.push("RADIO");
	if (label) parts.push(`: ${label}`);
	if (name) parts.push(` (name=${name})`);
	parts.push(` = ${checked ? "checked" : "unchecked"}`);
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputRange(_node, ctx) {
	const { attrs } = ctx;
	const value = attrs.value || attrs.min || "0";
	const min = attrs.min || "0";
	const max = attrs.max || "100";
	const step = attrs.step;
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("SLIDER");
	if (label) parts.push(`: ${label}`);
	parts.push(` = ${value} (min=${min}, max=${max}`);
	if (step) parts[parts.length - 1] += `, step=${step}`;
	parts[parts.length - 1] += ")";
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputFile(_node, ctx) {
	const { attrs } = ctx;
	const value = attrs.value;
	const accept = attrs.accept;
	const multiple = attrs.multiple !== void 0;
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("INPUT[file]");
	if (label) parts.push(`: ${label}`);
	if (value) {
		const fileName = value.split(/[/\\]/).pop() || value;
		if (multiple) parts.push(" | selected: multiple files");
		else parts.push(` | selected: ${fileName}`);
	} else parts.push(" | no file");
	if (accept) parts.push(` (accept: ${accept})`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputDate(_node, ctx) {
	const { attrs } = ctx;
	const type = attrs.type || "date";
	const value = attrs.value || "";
	const min = attrs.min;
	const max = attrs.max;
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push(`INPUT[${type}]`);
	if (label) parts.push(`: ${label}`);
	if (value) parts.push(` | ${value}`);
	else parts.push(" | empty");
	const constraints = [];
	if (min) constraints.push(`min=${min}`);
	if (max) constraints.push(`max=${max}`);
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	if (constraints.length > 0) parts.push(" (" + constraints.join(", ") + ")");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleInputColor(_node, ctx) {
	const { attrs } = ctx;
	const value = attrs.value || "#000000";
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("INPUT[color]");
	if (label) parts.push(`: ${label}`);
	parts.push(` | ${value}`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleTextarea(_node, ctx) {
	const { attrs, maxTextLength } = ctx;
	const value = attrs.value || "";
	const rows = attrs.rows;
	const maxlength = attrs.maxlength;
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("TEXTAREA");
	if (label) parts.push(`: ${label}`);
	if (value) {
		const { text: truncatedValue, truncated, originalLength } = truncateText(value, maxTextLength, true);
		parts.push(` | "${truncatedValue}"`);
		if (maxlength) parts.push(` (${originalLength}/${maxlength} chars)`);
		else if (truncated) parts.push(` [truncated, ${originalLength} chars total]`);
	} else {
		parts.push(" | empty");
		if (rows || maxlength) {
			const constraints = [];
			if (rows) constraints.push(`rows=${rows}`);
			if (maxlength) constraints.push(`max=${maxlength} chars`);
			parts.push(` (${constraints.join(", ")})`);
		}
	}
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleSelect(_node, ctx) {
	const { text, attrs } = ctx;
	const value = attrs.value || "(none)";
	const multiple = attrs.multiple !== void 0;
	const flags = getStateFlags(attrs, ctx.tagName, ctx.inputType);
	const label = getLabelText(text, attrs);
	const parts = [];
	if (multiple) parts.push("SELECT[multiple]");
	else parts.push("SELECT");
	if (label) parts.push(`: ${label}`);
	parts.push(` = ${value}`);
	if (flags.length > 0) parts.push(" [" + flags.join(", ") + "]");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleProgress(_node, ctx) {
	const { text, attrs } = ctx;
	const value = attrs.value;
	const max = attrs.max || "100";
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("PROGRESS");
	if (label) parts.push(`: ${label}`);
	if (value !== void 0) {
		const percent = Math.round(parseFloat(value) / parseFloat(max) * 100);
		parts.push(` = ${percent}% (value=${value}, max=${max})`);
	} else parts.push(" = indeterminate");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleMeter(_node, ctx) {
	const { text, attrs } = ctx;
	const value = parseFloat(attrs.value || "0");
	const min = parseFloat(attrs.min || "0");
	const max = parseFloat(attrs.max || "100");
	const low = parseFloat(attrs.low || min.toString());
	const high = parseFloat(attrs.high || max.toString());
	const optimum = parseFloat(attrs.optimum || ((min + max) / 2).toString());
	const label = getLabelText(text, attrs);
	let state = "normal";
	if (optimum <= low) state = value <= low ? "optimal" : value >= high ? "warning" : "suboptimal";
	else if (optimum >= high) state = value >= high ? "optimal" : value <= low ? "warning" : "suboptimal";
	else state = value >= low && value <= high ? "optimal" : "suboptimal";
	const percent = Math.round((value - min) / (max - min) * 100);
	const parts = [];
	parts.push("METER");
	if (label) parts.push(`: ${label}`);
	parts.push(` = ${percent}% [${state}] (min=${min}, low=${low}, high=${high}, max=${max})`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleDetails(_node, ctx) {
	const { text, attrs } = ctx;
	const open = attrs.open !== void 0;
	const parts = [];
	parts.push("DETAILS");
	if (text) parts.push(`: ${text}`);
	parts.push(open ? " [open]" : " [closed]");
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleVideo(_node, ctx) {
	const { attrs } = ctx;
	const controls = attrs.controls !== void 0;
	const autoplay = attrs.autoplay !== void 0;
	const muted = attrs.muted !== void 0;
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("VIDEO");
	if (label) parts.push(`: ${label}`);
	const states = [];
	if (controls) states.push("controls");
	if (autoplay) states.push("autoplay");
	if (muted) states.push("muted");
	if (states.length > 0) parts.push(` [${states.join(", ")}]`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleAudio(_node, ctx) {
	const { attrs } = ctx;
	const controls = attrs.controls !== void 0;
	const autoplay = attrs.autoplay !== void 0;
	const muted = attrs.muted !== void 0;
	const label = getLabelText(ctx.text, attrs);
	const parts = [];
	parts.push("AUDIO");
	if (label) parts.push(`: ${label}`);
	const states = [];
	if (controls) states.push("controls");
	if (autoplay) states.push("autoplay");
	if (muted) states.push("muted");
	if (states.length > 0) parts.push(` [${states.join(", ")}]`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleParagraph(_node, ctx) {
	const { text } = ctx;
	const tagName = _node.nodeName.toLowerCase();
	if (!text) return {
		text: `${tagName}`,
		hasContent: false
	};
	return {
		text,
		hasContent: true
	};
}
function handleSpan(_node, ctx) {
	const { text } = ctx;
	const tagName = _node.nodeName.toLowerCase();
	if (!text) return {
		text: `${tagName}`,
		hasContent: false
	};
	return {
		text,
		hasContent: true
	};
}
function handleAriaCombobox(_node, ctx) {
	const { text, attrs } = ctx;
	const expanded = attrs["aria-expanded"] === "true";
	const value = attrs.value || text;
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("COMBOBOX");
	if (label) parts.push(`: ${label}`);
	if (value) parts.push(` | ${value}`);
	parts.push(` [expanded=${expanded}]`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleAriaSwitch(_node, ctx) {
	const { text, attrs } = ctx;
	const checked = attrs["aria-checked"] === "true";
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("SWITCH");
	if (label) parts.push(`: ${label}`);
	parts.push(` = ${checked ? "on" : "off"}`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleAriaTab(_node, ctx) {
	const { text, attrs } = ctx;
	const selected = attrs["aria-selected"] === "true";
	const controls = attrs["aria-controls"];
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("TAB");
	if (label) parts.push(`: ${label}`);
	parts.push(` [selected=${selected}`);
	if (controls) parts[parts.length - 1] += `, controls=${controls}`;
	parts[parts.length - 1] += "]";
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleAriaSpinbutton(_node, ctx) {
	const { text, attrs } = ctx;
	const value = attrs["aria-valuenow"] || attrs.value || "";
	const min = attrs["aria-valuemin"];
	const max = attrs["aria-valuemax"];
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("SPINBUTTON");
	if (label) parts.push(`: ${label}`);
	if (value) parts.push(` = ${value}`);
	const constraints = [];
	if (min !== void 0) constraints.push(`min=${min}`);
	if (max !== void 0) constraints.push(`max=${max}`);
	if (constraints.length > 0) parts.push(` (${constraints.join(", ")})`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleAriaSlider(_node, ctx) {
	const { text, attrs } = ctx;
	const value = attrs["aria-valuenow"] || attrs.value || "0";
	const min = attrs["aria-valuemin"] || "0";
	const max = attrs["aria-valuemax"] || "100";
	const label = getLabelText(text, attrs);
	const parts = [];
	parts.push("SLIDER");
	if (label) parts.push(`: ${label}`);
	parts.push(` = ${value} (min=${min}, max=${max})`);
	return {
		text: parts.join(""),
		hasContent: true
	};
}
function handleGenericElement(node, ctx) {
	const { text } = ctx;
	const tagName = node.nodeName?.toUpperCase() || "ELEMENT";
	if (text) return {
		text: `${tagName}: ${text}`,
		hasContent: true
	};
	return {
		text: `${tagName}`,
		hasContent: false
	};
}
const ROLE_HANDLERS = /* @__PURE__ */ new Map([
	["button", handleButton],
	["combobox", handleAriaCombobox],
	["switch", handleAriaSwitch],
	["tab", handleAriaTab],
	["spinbutton", handleAriaSpinbutton],
	["slider", handleAriaSlider]
]);
const INPUT_TYPE_HANDLERS = /* @__PURE__ */ new Map([
	["text", handleInputText],
	["email", handleInputText],
	["password", handleInputPassword],
	["search", handleInputText],
	["tel", handleInputText],
	["url", handleInputText],
	["number", handleInputNumber],
	["checkbox", handleInputCheckbox],
	["radio", handleInputRadio],
	["range", handleInputRange],
	["file", handleInputFile],
	["date", handleInputDate],
	["time", handleInputDate],
	["datetime-local", handleInputDate],
	["month", handleInputDate],
	["week", handleInputDate],
	["color", handleInputColor],
	["submit", handleButton],
	["button", handleButton]
]);
const TAG_HANDLERS = /* @__PURE__ */ new Map([
	["button", handleButton],
	["a", handleLink],
	["img", handleImage],
	["h1", handleHeading],
	["h2", handleHeading],
	["h3", handleHeading],
	["h4", handleHeading],
	["h5", handleHeading],
	["h6", handleHeading],
	["textarea", handleTextarea],
	["select", handleSelect],
	["progress", handleProgress],
	["meter", handleMeter],
	["details", handleDetails],
	["video", handleVideo],
	["audio", handleAudio],
	["p", handleParagraph],
	["span", handleSpan]
]);
function getElementHandler(tagName, role, inputType) {
	if (role && ROLE_HANDLERS.has(role)) return ROLE_HANDLERS.get(role);
	if (tagName === "input" && inputType && INPUT_TYPE_HANDLERS.has(inputType)) return INPUT_TYPE_HANDLERS.get(inputType);
	if (TAG_HANDLERS.has(tagName)) return TAG_HANDLERS.get(tagName);
	return handleGenericElement;
}
/**
* Convert an EnhancedDOMTreeNode to AI-optimized text representation
*/
function convertNodeToAiText(node, options = {}) {
	const { maxTextLength = 100 } = options;
	const tagName = node.nodeName.toLowerCase();
	const text = getDirectTextContent(node);
	const attrs = node.attributes || {};
	const role = attrs.role;
	const inputType = tagName === "input" ? attrs.type : void 0;
	const context = {
		text: text.trim(),
		attrs,
		maxTextLength,
		tagName,
		inputType,
		role
	};
	return getElementHandler(tagName, role, inputType)(node, context);
}
//#endregion
//#region src/browser/dom/markdown/renderer.ts
/**
* Render the DOM tree to AI-optimized markdown text.
* Prunes the tree first, then converts each node to text.
*/
function renderToMarkdown(root, lookup) {
	const lines = [];
	renderNode(root, 0, lines, lookup);
	return lines.join("\n");
}
function renderNode(node, depth, lines, lookup) {
	if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) {
		const { text } = convertNodeToAiText(node);
		const line = indent(depth) + text;
		lines.push(line);
		node.renderInfo.renderedLine = line;
		const originalNode = lookup?.get(nodeKey(node));
		if (originalNode?.renderInfo) originalNode.renderInfo.renderedLine = line;
	}
	for (const child of node.childrenNodes ?? []) renderNode(child, depth + 1, lines, lookup);
}
function indent(depth) {
	return "	".repeat(depth);
}
//#endregion
//#region src/browser/dom/markdown/pruner.ts
const MAX_ITERATIONS = 100;
/**
* Prune the DOM tree in-place for markdown rendering.
*
* @param root - The tree to prune (will be modified)
* @param lookup - If provided, writes pruneReason back to original tree nodes via this lookup
*/
function pruneForMarkdown(root, lookup) {
	mergeInlineNodes(root);
	flattenBoundaries(root);
	const effectiveLookup = lookup ?? /* @__PURE__ */ new Map();
	let changed = true;
	let iteration = 0;
	while (changed && iteration < MAX_ITERATIONS) {
		iteration++;
		const countBefore = countNodes(root);
		root.childrenNodes = pruneChildren(root, root.childrenNodes ?? [], effectiveLookup);
		changed = countBefore !== countNodes(root);
	}
}
/**
* Recursively merge shadowRoots and contentDocument children into childrenNodes
*/
function flattenBoundaries(node) {
	const merged = [];
	for (const child of node.childrenNodes ?? []) merged.push(child);
	if (node.shadowRoots) {
		for (const shadow of node.shadowRoots) for (const child of shadow.childrenNodes ?? []) {
			child.parentNode = node;
			merged.push(child);
		}
		node.shadowRoots = void 0;
	}
	if (node.contentDocument) {
		for (const child of node.contentDocument.childrenNodes ?? []) {
			child.parentNode = node;
			merged.push(child);
		}
		node.contentDocument = void 0;
	}
	node.childrenNodes = merged;
	for (const child of node.childrenNodes) flattenBoundaries(child);
}
function countNodes(node) {
	let count = 1;
	for (const child of node.childrenNodes ?? []) count += countNodes(child);
	return count;
}
function pruneChildren(parent, children, lookup) {
	const result = [];
	for (const child of children) {
		const processed = pruneNode(child, lookup, parent);
		for (const node of processed) node.parentNode = parent;
		result.push(...processed);
	}
	return result;
}
function pruneNode(node, lookup, parent) {
	node.childrenNodes = pruneChildren(node, node.childrenNodes ?? [], lookup);
	const role = node.axNode?.role;
	if (role && NAME_FROM_CONTENT_ROLES.has(role) && node.axNode?.name) {
		removeRedundantStaticText(node, node.axNode.name.trim(), lookup);
		return [node];
	}
	if (role === "StaticText") return [node];
	if (node.nodeName === "IMG") {
		markPruneReason(lookup, node, "img: unwrapped");
		return node.childrenNodes ?? [];
	}
	const { hasContent } = convertNodeToAiText(node);
	if (!hasContent && !hasContentInSubtree(node)) {
		markPruneReason(lookup, node, "no-content: removed");
		return [];
	}
	if (((parent?.childrenNodes?.filter((c) => c.axNode?.role !== "StaticText"))?.length ?? 0) !== 1) return [node];
	if (node.axNode?.ignored) {
		markPruneReason(lookup, node, "only-child-ignored: unwrapped");
		return node.childrenNodes ?? [];
	}
	if (isInlineHidden(node)) {
		markPruneReason(lookup, node, "only-child-hidden: unwrapped");
		return node.childrenNodes ?? [];
	}
	if (node.attributes?.["aria-hidden"] === "true") {
		markPruneReason(lookup, node, "only-child-aria-hidden: unwrapped");
		return node.childrenNodes ?? [];
	}
	if (!hasContent) {
		markPruneReason(lookup, node, "only-child-no-content: unwrapped");
		return node.childrenNodes ?? [];
	}
	return [node];
}
function isInlineHidden(node) {
	const style = node.attributes?.style;
	if (!style) return false;
	const normalized = style.replace(/\s/g, "").toLowerCase();
	return normalized.includes("display:none") || normalized.includes("visibility:hidden");
}
/**
* Recursively remove StaticText descendants whose text is already in aggregatedName.
* Preserves non-StaticText children (interactive elements, containers, etc.).
*/
function removeRedundantStaticText(node, aggregatedName, lookup) {
	if (!node.childrenNodes) return;
	node.childrenNodes = node.childrenNodes.filter((child) => {
		if (child.axNode?.name !== void 0 && child.axNode?.name && aggregatedName.includes(child.axNode.name.trim())) {
			markPruneReason(lookup, child, "name-from-content: redundant text");
			return false;
		}
		removeRedundantStaticText(child, aggregatedName, lookup);
		return true;
	});
}
function hasContentInSubtree(node) {
	if (node.axNode?.name) return true;
	if (node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11) {
		const { hasContent } = convertNodeToAiText(node);
		if (hasContent) return true;
	}
	for (const child of node.childrenNodes ?? []) if (hasContentInSubtree(child)) return true;
	return false;
}
//#endregion
//#region src/browser/dom/tree/highlight.ts
const indexRegistries = /* @__PURE__ */ new WeakMap();
/**
* Creates a CDP command sender to bind the current node session.
* You can send a sub-session to a cross-process iframe when oopifSessionId and OOPIFManager is available; otherwise, to the main session.
*/
function createSendCommand(node, cdpClient, oopifManager) {
	if (node.oopifSessionId && oopifManager) {
		const sessionId = node.oopifSessionId;
		return (method, params) => oopifManager.sendCommand(sessionId, method, params);
	}
	return (method, params) => cdpClient.sendCommand(method, params);
}
const HIGHLIGHT_ATTR = "data-hl-idx";
const HIGHLIGHT_CONTAINER_ID = "__elements_highlight_container__";
/**
* Assign highlight indexes first, then optionally draw visible highlight boxes on the page.
* Returns selectorMap for subsequent interactive tools to search for nodes by model numbering.
*
* @paramroot - Cropped tree to process; function changes renderInfo.highlightIndex of node
* @paramcdpClient - Client CDP with browser main session End
* @paramoopifManager - Select Manager to manage cross-process iframe sub-sessions
* @paramlookup - An optional original tree index; when available, highlightIndex will be returned to the original tree node
* @param options.highlight - Whether to inject visible highlight covers into the page; only visible transmission false is closed, default access
*/
async function assignAndHighlight(root, cdpClient, oopifManager, lookup, options) {
	const selectorMap = assignHighlightIndices(root, cdpClient, lookup);
	if (options?.highlight !== false) await highlightElements(selectorMap, cdpClient, oopifManager);
	return selectorMap;
}
/**
* Allocation of highlightIndex to candidate nodes for filtering conditions, using backendNodeId directly.
* Within the life cycle of the same CDP session, backendNodeId is more stable than the ad hoc generation of serial numbers, so model reading
* Where there is an incremental difference, the numbering previously seen in the full DOM may continue to be used.
*/
function assignHighlightIndices(root, client, originalLookup) {
	const selectorMap = /* @__PURE__ */ new Map();
	let registry = indexRegistries.get(client);
	if (!registry) {
		registry = {
			ids: /* @__PURE__ */ new Map(),
			used: /* @__PURE__ */ new Set(),
			next: 1e9
		};
		indexRegistries.set(client, registry);
	}
	const visit = (node) => {
		if (node.renderInfo?.isCandidate && !node.renderInfo.isSelect && (!node.renderInfo?.isDuplicateListener || node.renderInfo.isSelectOption || node.renderInfo.isFill) && (!node.renderInfo.expandedViewportPosition || node.renderInfo.diffStatus === "removed")) {
			const key = `${node.frameId ?? node.oopifSessionId ?? "main"}:${node.backendNodeId}`;
			let id = registry.ids.get(key);
			if (id === void 0) {
				id = node.backendNodeId;
				if (registry.used.has(id)) {
					while (registry.used.has(registry.next)) registry.next++;
					id = registry.next++;
				}
				registry.ids.set(key, id);
				registry.used.add(id);
			}
			node.renderInfo.highlightIndex = id;
			selectorMap.set(id, node);
			const originalNode = originalLookup?.get(nodeKey(node));
			if (originalNode?.renderInfo) originalNode.renderInfo.highlightIndex = id;
		}
		for (const child of node.childrenNodes ?? []) visit(child);
	};
	visit(root);
	return selectorMap;
}
/**
* Write data-hl-idx on each candidate element and inject the dynamic highlight script into every frame that contains candidates.
*/
async function highlightElements(selectorMap, cdpClient, oopifManager) {
	if (selectorMap.size === 0) return;
	try {
		await cdpClient.sendCommand("DOM.enable");
	} catch {}
	await cleanupHighlights(cdpClient, oopifManager);
	const frameIds = /* @__PURE__ */ new Set();
	const oopifSessionIds = /* @__PURE__ */ new Set();
	for (const [index, node] of selectorMap) try {
		const sendCmd = createSendCommand(node, cdpClient, oopifManager);
		const objectId = (await sendCmd("DOM.resolveNode", { backendNodeId: node.backendNodeId }))?.object?.objectId;
		if (!objectId) continue;
		await sendCmd("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: `function() { this.setAttribute('${HIGHLIGHT_ATTR}', '${index}'); }`,
			awaitPromise: false
		});
		if (node.oopifSessionId) oopifSessionIds.add(node.oopifSessionId);
		else {
			const tag = node.nodeName?.toUpperCase();
			if (tag === "IFRAME" || tag === "FRAME") frameIds.add(node.parentNode?.frameId);
			else frameIds.add(node.frameId);
		}
	} catch {}
	const script = generateDynamicHighlightScript();
	for (const frameId of frameIds) try {
		if (!frameId) await cdpClient.sendCommand("Runtime.evaluate", {
			expression: script,
			awaitPromise: false
		});
		else {
			const contextResult = await cdpClient.sendCommand("Page.createIsolatedWorld", {
				frameId,
				worldName: "__highlight__",
				grantUniveralAccess: true
			});
			if (contextResult?.executionContextId) await cdpClient.sendCommand("Runtime.evaluate", {
				expression: script,
				contextId: contextResult.executionContextId,
				awaitPromise: false
			});
		}
	} catch (error) {}
	if (oopifManager) for (const rawSessionId of oopifSessionIds) {
		const sessionId = oopifManager.resolveSessionId(rawSessionId);
		try {
			await oopifManager.sendCommand(sessionId, "Runtime.evaluate", {
				expression: script,
				awaitPromise: false
			});
		} catch (error) {}
	}
}
/**
* Runs the cleanup logic in the main document, all co-sources frame and all known OOPIF to remove old listeners, properties and overlay containers.
*/
async function cleanupHighlights(cdpClient, oopifManager) {
	const cleanupScript = `
(function() {
  if (window._highlightCleanupFunctions) {
    window._highlightCleanupFunctions.forEach(function(fn) { fn(); });
    window._highlightCleanupFunctions = [];
  }
  var c = document.getElementById('${HIGHLIGHT_CONTAINER_ID}');
  if (c) { try { if (typeof c.hidePopover === 'function') c.hidePopover(); } catch(e) {} c.remove(); }
  function removeAttrDeep(root) {
    root.querySelectorAll('[${HIGHLIGHT_ATTR}]').forEach(function(el) {
      el.removeAttribute('${HIGHLIGHT_ATTR}');
    });
    root.querySelectorAll('*').forEach(function(el) {
      if (el.shadowRoot) removeAttrDeep(el.shadowRoot);
    });
  }
  removeAttrDeep(document);
})();
`;
	try {
		await cdpClient.sendCommand("Runtime.evaluate", {
			expression: cleanupScript,
			awaitPromise: false
		});
		const subFrames = collectFrameIds((await cdpClient.sendCommand("Page.getFrameTree"))?.frameTree);
		for (const frameId of subFrames) try {
			const ctx = await cdpClient.sendCommand("Page.createIsolatedWorld", {
				frameId,
				worldName: "__highlight_cleanup__",
				grantUniveralAccess: true
			});
			if (ctx?.executionContextId) await cdpClient.sendCommand("Runtime.evaluate", {
				expression: cleanupScript,
				contextId: ctx.executionContextId,
				awaitPromise: false
			});
		} catch {}
	} catch {}
	if (oopifManager) for (const session of oopifManager.getSessions()) try {
		await oopifManager.sendCommand(session.sessionId, "Runtime.evaluate", {
			expression: cleanupScript,
			awaitPromise: false
		});
	} catch {}
}
/**
* Priority is given to collecting all sub-items frameId from Page.getFrameTree in depth; root frameId does not add the result.
*/
function collectFrameIds(frameTree) {
	if (!frameTree?.childFrames) return [];
	const ids = [];
	for (const child of frameTree.childFrames) {
		ids.push(child.frame.id);
		ids.push(...collectFrameIds(child));
	}
	return ids;
}
/**
* Generates a self-included script that will be executed on the page frame; here only the string is spelled and the actual execution takes place in highlightElements().
*/
function generateDynamicHighlightScript() {
	return `
(function() {
  var CONTAINER_ID = '${HIGHLIGHT_CONTAINER_ID}';
  var ATTR = '${HIGHLIGHT_ATTR}';
  var colors = ${JSON.stringify([
		"#FF0000",
		"#00FF00",
		"#0000FF",
		"#FFA500",
		"#800080",
		"#008080",
		"#FF69B4",
		"#4B0082",
		"#FF4500",
		"#2E8B57",
		"#DC143C",
		"#4682B4"
	])};

  // Recursively search for tagged elements and penetrates the accessible border Shadow DOM.
  function findMarkedElements(root) {
    var result = [];
    var els = root.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < els.length; i++) result.push(els[i]);
    // Normal querySelectorAll will not enter Shadow Root, so all elements will be listed and returned to shadowRoot, which is open.
    var allEls = root.querySelectorAll('*');
    for (var j = 0; j < allEls.length; j++) {
      if (allEls[j].shadowRoot) {
        var shadowResults = findMarkedElements(allEls[j].shadowRoot);
        for (var k = 0; k < shadowResults.length; k++) result.push(shadowResults[k]);
      }
    }
    return result;
  }
  var elements = findMarkedElements(document);
  // The current frame without successfully marked elements does not create an empty container or register an event listener.
  if (elements.length === 0) return;

  // Use fixed full-view transparent containers to carry all frames and labels and to prohibit receiving pointer events and avoid blocking page interaction.
  var container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.style.position = 'fixed';
  container.style.pointerEvents = 'none';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.zIndex = '2147483647';
  container.style.backgroundColor = 'transparent';
  // The browser supports Popover API by placing the container in top layer so that it can be displayed on dialog/popover.
  if (typeof container.showPopover === 'function') {
    container.setAttribute('popover', 'manual');
    document.body.appendChild(container);
    try { container.showPopover(); } catch(e) { /* Return normal document stacking process when failure */ }
  } else {
    document.body.appendChild(container);
  }

  var cleanupFunctions = [];

  elements.forEach(function(element) {
    // Numbering determines the colour slot; add 1A to the base colour to generate a low transparency background colour.
    var index = parseInt(element.getAttribute(ATTR), 10);
    var colorIndex = index % colors.length;
    var baseColor = colors[colorIndex];
    var backgroundColor = baseColor + '1A';

    var overlays = [];
    var label = null;
    var labelWidth = 20;
    var labelHeight = 16;

    function updatePositions() {
      // An element may have multiple rectangles, such as inline elements that cross multiple lines; each valid rectangular corresponds to one overlay.
      var rects = element.getClientRects();

      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        // Zero width or zero height rectangles have no visible area; old frames are hidden to handle rect volume or size changes after layout changes.
        if (rect.width === 0 || rect.height === 0) {
          if (overlays[i]) overlays[i].style.display = 'none';
          continue;
        }

        var overlay = overlays[i];
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.style.position = 'fixed';
          overlay.style.border = '2px solid ' + baseColor;
          overlay.style.backgroundColor = backgroundColor;
          overlay.style.pointerEvents = 'none';
          overlay.style.boxSizing = 'border-box';
          container.appendChild(overlay);
          overlays[i] = overlay;
        }

        overlay.style.top = rect.top + 'px';
        overlay.style.left = rect.left + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';
      }

      // When a new round of rect quantities becomes smaller, the old box is hidden to avoid remaining after scscrolling or changing lines.
      for (var j = rects.length; j < overlays.length; j++) {
        overlays[j].style.display = 'none';
      }

      if (rects.length > 0) {
        // An element only creates a numbering label and uses the first rectangular as a positioning benchmark.
        var firstRect = rects[0];

        if (!label) {
          label = document.createElement('div');
          label.style.position = 'fixed';
          label.style.background = baseColor;
          label.style.color = 'white';
          label.style.padding = '1px 4px';
          label.style.borderRadius = '4px';
          label.style.fontSize = Math.min(12, Math.max(8, firstRect.height / 2)) + 'px';
          label.style.pointerEvents = 'none';
          label.textContent = index;
          container.appendChild(label);

          if (label.offsetWidth > 0) labelWidth = label.offsetWidth;
          if (label.offsetHeight > 0) labelHeight = label.offsetHeight;
        }

        // Default to the top right corner of the first rectangle.
        var labelTop = firstRect.top + 2;
        var labelLeft = firstRect.left + firstRect.width - labelWidth - 2;

        // Element frames are moved to the top when the label does not exist, and the left edge is prevented from crossing.
        if (firstRect.width < labelWidth + 4 || firstRect.height < labelHeight + 4) {
          labelTop = firstRect.top - labelHeight - 2;
          labelLeft = firstRect.left + firstRect.width - labelWidth;
          if (labelLeft < 0) labelLeft = firstRect.left;
        }

        // The coordinates are eventually attached to viewport to ensure that the label does not run out of the visual area.
        labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelHeight));
        labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelWidth));

        label.style.top = labelTop + 'px';
        label.style.left = labelLeft + 'px';
        label.style.display = 'block';
      } else if (label) {
        label.style.display = 'none';
      }
    }

    updatePositions();

    // The HF scroll/resize event is subject to light currents at a minimum update interval of 16ms .
    var lastCall = 0;
    var throttledUpdate = function() {
      var now = performance.now();
      if (now - lastCall < 16) return;
      lastCall = now;
      updatePositions();
    };

    window.addEventListener('scroll', throttledUpdate, true);
    window.addEventListener('resize', throttledUpdate);

    // Saves the reverse action corresponding to this element; the next round cleanupHighlights() will be called in a uniform manner to prevent leakage of the listening.
    cleanupFunctions.push(function() {
      window.removeEventListener('scroll', throttledUpdate, true);
      window.removeEventListener('resize', throttledUpdate);
      overlays.forEach(function(o) { o.remove(); });
      if (label) label.remove();
    });
  });

  // Hangs window on the current frame so that the cleanup script of the next round of injection can find all the cleanup functions.
  window._highlightCleanupFunctions = cleanupFunctions;
})();
`;
}
//#endregion
//#region src/browser/dom/settle-monitor.ts
const timers = globalThis;
const DOM_MUTATION_EVENTS = /* @__PURE__ */ new Set([
	"DOM.childNodeInserted",
	"DOM.childNodeRemoved",
	"DOM.childNodeCountUpdated",
	"DOM.attributeModified",
	"DOM.attributeRemoved",
	"DOM.characterDataModified"
]);
const IGNORED_URL_KEYWORDS = [
	"doubleclick.net",
	"googlesyndication.com",
	"googletagmanager.com",
	"google-analytics.com",
	"googleadservices.com",
	"undertone.com",
	"mrtnsvr.com",
	"loopme.me",
	"pubmatic.com",
	"unrulymedia.com",
	"facebook.net",
	"fbcdn.net",
	"demdex.net",
	"omtrdc.net",
	"adobedtm.com",
	"ensighten.com",
	"sentry.io",
	"newrelic.com",
	"nr-data.net",
	"hotjar",
	"clarity.ms",
	"mixpanel",
	"segment.io",
	"platform.twitter.com",
	"platform.linkedin.com",
	"pinimg.com",
	"pinterest.com",
	"sc-static.net",
	"quantummetric.com",
	"dynatrace.com",
	"go-mpulse.net",
	"optimizely.com",
	"brcdn.com",
	"criteo.com",
	"id5-sync.com",
	"creativecdn.com",
	"attn.tv",
	"wandzcdn.com",
	"wandzapi.com",
	"talkdeskapp.com",
	"talkdeskchatsdk",
	"cookielaw.org",
	".cloudfront.net/image/",
	".akamaized.net/image/",
	"analytics",
	"tracking",
	"pixel",
	"adservice",
	"ads",
	"/tracker/",
	"/collector/",
	"/beacon/",
	"/telemetry/",
	"/log/",
	"/events/",
	"/eventBatch",
	"/track.",
	"/metrics/",
	"/sync",
	"/csync",
	"usersync",
	"pixel/sync"
];
const NON_CRITICAL_RESOURCE_TYPES = /* @__PURE__ */ new Set([
	"Image",
	"Media",
	"Font",
	"Preflight",
	"Ping",
	"CSPViolationReport",
	"Prefetch"
]);
const STUCK_REQUEST_MS = 1e4;
const NON_CRITICAL_MAX_MS = 3e3;
/**
* Only a small number of requests remain open and have been waiting longer, usually in the back desk;
* Avoid prolonged obstruction of judgement settle.
*/
const LONE_REQUEST_MAX_MS = 5e3;
const IMAGE_URL_RE = /(\.jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i;
function isIgnoredUrl(url) {
	if (!url || url.startsWith("data:") || url.length > 500) return true;
	const lower = url.toLowerCase();
	return IGNORED_URL_KEYWORDS.some((kw) => lower.includes(kw));
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
var PageSettleMonitor = class {
	debugger_;
	dirty = true;
	suspended = 0;
	/** Ignore only our synchronous DOM annotations; network activity still counts. */
	suspend() {
		this.suspended++;
	}
	resume() {
		if (this.suspended > 0) this.suspended--;
	}
	inflightRequests = /* @__PURE__ */ new Map();
	quietTimer = null;
	cleanWaiters = [];
	onMessageBound;
	quietWindow;
	enableOOPIFSession;
	constructor(debugger_, options = {}) {
		this.debugger_ = debugger_;
		this.quietWindow = options.quietWindow ?? 1e3;
		this.enableOOPIFSession = options.enableOOPIFSession;
		this.onMessageBound = this.onMessage.bind(this);
		this.debugger_.on("message", this.onMessageBound);
		for (const sessionId of options.oopifSessionIds ?? []) this.enableOOPIFSession?.(sessionId).catch(() => {});
		this.resetTimer();
	}
	/**
	* Wait for the page to enter clean; or return after timeoutMs (overtime).
	* If clean has been returned immediately.
	*/
	async waitForSettle(timeoutMs) {
		if (!this.dirty) return;
		return new Promise((resolve) => {
			const timer = timers.setTimeout(() => {
				resolve();
			}, timeoutMs);
			this.cleanWaiters.push(() => {
				timers.clearTimeout(timer);
				resolve();
			});
		});
	}
	stop() {
		this.debugger_.off("message", this.onMessageBound);
		if (this.quietTimer) timers.clearTimeout(this.quietTimer);
		this.cleanWaiters = [];
	}
	onMessage(_event, method, params) {
		if (method === "Target.attachedToTarget") {
			if (params.targetInfo?.type === "iframe") {
				const sessionId = params.sessionId;
				this.enableOOPIFSession?.(sessionId).catch(() => {});
				this.resetTimer();
			}
			return;
		}
		if (DOM_MUTATION_EVENTS.has(method)) {
			if (this.suspended > 0) return;
			this.dirty = true;
			this.resetTimer();
			return;
		}
		if (method === "Network.requestWillBeSent") {
			const url = params.request?.url ?? "";
			const type = params.type ?? "";
			const requestId = params.requestId;
			if (!isIgnoredUrl(url) && !NON_CRITICAL_RESOURCE_TYPES.has(type)) {
				this.inflightRequests.set(requestId, {
					url,
					type,
					startTime: Date.now()
				});
				this.dirty = true;
				this.resetTimer();
			}
		} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") this.inflightRequests.delete(params.requestId);
		else if (method === "Network.responseReceived") {
			const requestId = params.requestId;
			const type = params.type ?? "";
			const req = this.inflightRequests.get(requestId);
			if (req) {
				req.type = type;
				if (NON_CRITICAL_RESOURCE_TYPES.has(type)) this.inflightRequests.delete(requestId);
			}
		}
	}
	hasCriticalInflight() {
		const now = Date.now();
		const remaining = [];
		for (const [reqId, req] of this.inflightRequests) {
			const age = now - req.startTime;
			if (age > STUCK_REQUEST_MS) {
				this.inflightRequests.delete(reqId);
				continue;
			}
			if (NON_CRITICAL_RESOURCE_TYPES.has(req.type) && age > NON_CRITICAL_MAX_MS) {
				this.inflightRequests.delete(reqId);
				continue;
			}
			if (IMAGE_URL_RE.test(req.url) && age > NON_CRITICAL_MAX_MS) {
				this.inflightRequests.delete(reqId);
				continue;
			}
			remaining.push([reqId, req]);
		}
		if (remaining.length <= 3) {
			if (remaining.every(([, req]) => now - req.startTime > LONE_REQUEST_MAX_MS)) {
				for (const [reqId] of remaining) this.inflightRequests.delete(reqId);
				return false;
			}
		}
		return remaining.length > 0;
	}
	resetTimer() {
		if (this.quietTimer) timers.clearTimeout(this.quietTimer);
		this.quietTimer = timers.setTimeout(() => this.onQuiet(), this.quietWindow);
	}
	onQuiet() {
		this.quietTimer = null;
		if (this.hasCriticalInflight()) {
			this.resetTimer();
			return;
		}
		this.dirty = false;
		const waiters = this.cleanWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}
};
//#endregion
//#region src/browser/dom/service.ts
var DomService = class {
	client;
	commands;
	oopifManager;
	cache = /* @__PURE__ */ new Map();
	maxCacheSize;
	domIdCounter = 0;
	domSubCounter = 0;
	lastNavigationUrl;
	clientRefCount = 0;
	settleMonitor;
	settleReady;
	page;
	/**
	* Initialisation order: Save page/client for creating commands and OOPIF manager - > for creating stability monitor -> to enable listening fields by walk.
	* settleReady stores the initialization promise; later acquireClient() calls await it so collection cannot start before monitoring is ready.
	*/
	constructor(page, client, maxCacheSize = 10) {
		this.page = page;
		this.client = client;
		this.commands = new CDPCommands(this.client);
		this.oopifManager = new OOPIFManager();
		this.maxCacheSize = maxCacheSize;
		this.settleMonitor = new PageSettleMonitor(this.client.getDebugger(), { enableOOPIFSession: async (sessionId) => {
			await this.client.sendCommand("Network.enable", {}, 5e3, sessionId).catch(() => {});
			await this.client.sendCommand("DOM.enable", {}, 5e3, sessionId).catch(() => {});
		} });
		this.settleReady = this.initSettle();
	}
	/** Holds a client reference for continuous monitoring and allows the Network and DOM events of the main session. */
	async initSettle() {
		this.clientRefCount++;
		await this.client.attach();
		await this.client.sendCommand("Network.enable", {}).catch(() => {});
		await this.client.sendCommand("DOM.enable", {}).catch(() => {});
	}
	/** Stop stability monitoring and release its references; shared CDP resources are disposed only after their final owner releases them. */
	async destroySettle() {
		await this.settleReady.catch(() => {});
		this.settleMonitor.stop();
		this.clientRefCount--;
		if (this.clientRefCount === 0) {
			await this.oopifManager.cleanup();
			await this.client.cleanup();
		}
	}
	/**
	* Removes the previous round of model-numbered overlays before collecting new snapshots and avoids miscalculating the tool's own DIV/text node into page increments.
	* Cleanup removes only tool-owned data-hl-idx attributes, overlays, and listeners;
	* it does not alter the page elements referenced by selectorMap.
	*/
	async cleanupHighlightsBeforeSnapshot() {
		this.settleMonitor.suspend();
		try {
			await this.evaluate("document.querySelectorAll('.dsh-browser-click-annotation,.dsh-browser-capture-annotation,#dsh-browser-annotation-style,#dsh-browser-capture-style').forEach(el => el.remove())");
			await cleanupHighlights(this.client, this.oopifManager);
		} finally {
			this.settleMonitor.resume();
		}
	}
	setPageCheckpoint(domId, checkpoint) {
		const snapshot = this.cache.get(domId);
		if (snapshot) snapshot.pageCheckpoint = checkpoint;
	}
	getPageCheckpoint(domId) {
		return this.cache.get(domId)?.pageCheckpoint;
	}
	getCachedUrl(domId) {
		return this.cache.get(domId)?.url;
	}
	async captureHistoryEntry(domId) {
		const snapshot = this.cache.get(domId);
		if (!snapshot) return;
		const history = await this.client.sendCommand("Page.getNavigationHistory").catch(() => void 0);
		snapshot.historyEntryId = history?.entries[history.currentIndex]?.id;
	}
	/** Return false when Chrome has evicted the entry; the caller then navigates by URL. */
	async restoreHistoryEntry(domId, signal) {
		const snapshot = this.cache.get(domId);
		if (snapshot?.historyEntryId === void 0) return false;
		signal.throwIfAborted();
		const history = await this.client.sendCommand("Page.getNavigationHistory");
		signal.throwIfAborted();
		if (!history.entries.some((entry) => entry.id === snapshot.historyEntryId)) return false;
		if (history.entries[history.currentIndex]?.id !== snapshot.historyEntryId) {
			const navigation = this.page.waitForNavigation({
				waitUntil: "domcontentloaded",
				timeout: 5e3,
				signal
			}).catch(() => void 0);
			await this.client.sendCommand("Page.navigateToHistoryEntry", { entryId: snapshot.historyEntryId });
			await navigation;
		}
		signal.throwIfAborted();
		const current = await this.client.sendCommand("Page.getNavigationHistory");
		signal.throwIfAborted();
		return current.entries[current.currentIndex]?.id === snapshot.historyEntryId && this.page.url() === snapshot.url;
	}
	getLatestSelectorMap() {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		return latest?.selectorMap;
	}
	getLatestScrollContainerMap() {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		return latest?.scrollContainerMap ?? /* @__PURE__ */ new Map();
	}
	getLatestVisualElementMap() {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		return latest?.visualElementMap ?? /* @__PURE__ */ new Map();
	}
	getLatestExpand() {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		return latest?.expand ?? null;
	}
	getScrollContainerNode(index) {
		return this.getLatestScrollContainerMap().get(index);
	}
	async scrollToOffscreenElementByIndex(target, container, direction) {
		const node = this.findOffscreenNodeByRenderedLine(target, container, direction);
		if (!node) return void 0;
		await this.withClient(() => this.scrollToElement(node));
		return node;
	}
	async scrollToPositionByIndex(container, x, y) {
		return this.withClient(async () => {
			if (container === 0) await this.evaluate(`window.scrollTo(${x}, ${y})`);
			else {
				const node = this.getScrollContainerNode(container);
				if (!node) throw new Error(`Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`);
				await this.scrollContainerTo(node, x, y);
			}
		});
	}
	async getScrollInfoByIndex(container) {
		return this.withClient(async () => {
			if (container === 0) {
				const metrics = await this.commands.getLayoutMetrics();
				const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
				return {
					scrollX: css.pageX,
					scrollY: css.pageY,
					viewportWidth: css.clientWidth,
					viewportHeight: css.clientHeight,
					totalWidth: metrics.cssContentSize.width,
					totalHeight: metrics.cssContentSize.height
				};
			} else {
				const node = this.getScrollContainerNode(container);
				if (!node) throw new Error(`Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`);
				return this.getContainerScrollInfo(node);
			}
		});
	}
	/**
	* Finds the outer nodes of the mouth by rendering text in the given scscrolling container and direction.
	* Down to below/right and up to above/left; return the first matching node as soon as found.
	*/
	/**
	* In the given scscrolling container and direction, the external nodes of the mouth are found according to renderedLine text.
	* down below/right, up above/left for expandedViewportPosition.
	*/
	findOffscreenNodeByRenderedLine(target, container, direction) {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		if (!latest) return void 0;
		const trimmed = target.trim();
		if (!trimmed) return void 0;
		const validPositions = direction === "down" ? /* @__PURE__ */ new Set(["below", "right"]) : /* @__PURE__ */ new Set(["above", "left"]);
		const queue = [latest.domTree];
		while (queue.length > 0) {
			const node = queue.shift();
			const ri = node.renderInfo;
			if (ri?.renderedLine && (ri.renderedLine.includes(trimmed) || trimmed.includes(ri.renderedLine)) && ri.expandedViewportPosition !== void 0 && validPositions.has(ri.expandedViewportPosition) && (ri.scrollContainerIndex ?? 0) === container) return node;
			for (const child of node.childrenNodes ?? []) queue.push(child);
		}
	}
	/**
	* domId: For continuous snapshots of the same URL, use domN.1, domN.2; URL change the main number to domN + 1.
	*/
	generateDomId() {
		const currentUrl = this.page.url();
		if (this.lastNavigationUrl !== void 0 && currentUrl === this.lastNavigationUrl) {
			this.domSubCounter++;
			return `dom${this.domIdCounter}.${this.domSubCounter}`;
		}
		if (this.lastNavigationUrl !== void 0) this.domIdCounter++;
		this.domSubCounter = 0;
		this.lastNavigationUrl = currentUrl;
		return `dom${this.domIdCounter}`;
	}
	/**
	* The expression JavaScript is executed by CDP Runtime.evaluate.
	* It must be called within the life cycle of withClient()
	*/
	async evaluate(expression) {
		await this.client.sendCommand("Runtime.evaluate", {
			expression,
			awaitPromise: false
		});
	}
	async evaluateWithReturn(expression) {
		const result = await this.client.sendCommand("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true
		});
		if (result.exceptionDetails) {
			const detail = result.exceptionDetails;
			const message = detail.exception?.description ?? (detail.exception?.value !== void 0 ? String(detail.exception.value) : detail.text) ?? "Script error";
			throw new Error(`Page script error: ${message}`);
		}
		return result.result.value;
	}
	/**
	* Moves the scrolling container to absolute position by page JavaScript.
	* It must be called within the life cycle of withClient()
	*/
	async scrollContainerTo(node, x, y) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		const { object } = await sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId });
		await sendCommand("Runtime.callFunctionOn", {
			objectId: object.objectId,
			functionDeclaration: `function(x, y) { this.scrollTop = y; this.scrollLeft = x; }`,
			arguments: [{ value: x }, { value: y }],
			returnByValue: true
		});
		await sendCommand("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
	}
	/**
	* CDP query the real-time scrolling position, visual size and full size of the scrolling container.
	* It must be called within the life cycle of withClient()
	*/
	async getContainerScrollInfo(node) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		const { object } = await sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId });
		const { result } = await sendCommand("Runtime.callFunctionOn", {
			objectId: object.objectId,
			functionDeclaration: `function() {
        return {
          scrollX: this.scrollLeft,
          scrollY: this.scrollTop,
          viewportWidth: this.clientWidth,
          viewportHeight: this.clientHeight,
          totalWidth: this.scrollWidth,
          totalHeight: this.scrollHeight,
        };
      }`,
			returnByValue: true
		});
		await sendCommand("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
		return result.value;
	}
	/**
	* Click on the coordinates (x, y) by CDP Input.dispatchMouseEvent.
	* Coordinates use CSS pixels relative to the view; the order of execution is to move the mouse, press the left key and release the left key.
	* It must be called within the life cycle of withClient()
	*/
	async click(x, y) {
		await this.client.sendCommand("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		await this.client.sendCommand("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			clickCount: 1
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		await this.client.sendCommand("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			clickCount: 1
		});
	}
	/**
	* Scroll through the event mouseWheel CDP Input.dispatchMouseEvent.
	* Move the mouse first to (x, y) and then send a scrolling event with deltaX/deltaY.
	* It must be called within the life cycle of withClient()
	*/
	async scroll(x, y, deltaX, deltaY) {
		await this.client.sendCommand("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		await this.client.sendCommand("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x,
			y,
			deltaX,
			deltaY
		});
	}
	/**
	* Press Enter through CDP Input.dispatchKeyEvent.
	* Simulates the complete button process by keyDown, char and keyUp; it must be called within withClient().
	*/
	async pressEnter() {
		await this.client.sendCommand("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13
		});
		await this.client.sendCommand("Input.dispatchKeyEvent", {
			type: "char",
			key: "Enter",
			code: "Enter",
			text: "\r",
			unmodifiedText: "\r",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13
		});
		await this.client.sendCommand("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13
		});
	}
	/**
	* Scroll the elements to the centre of the view while supporting OOPIF nodes.
	* It must be called within the life cycle of withClient()
	*/
	async showClickAnnotation(x, y, type, elementIndex) {
		const color = type === "click" ? "#FF0000" : "#00FF00";
		const js = `(function() {
      var existing = document.querySelectorAll('.dsh-browser-click-annotation');
      existing.forEach(function(el) { el.remove(); });
      var annotation = document.createElement('div');
      annotation.className = 'dsh-browser-click-annotation';
      annotation.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:20px;height:20px;margin-left:-10px;margin-top:-10px;border:3px solid ${color};border-radius:50%;background-color:${color}44;pointer-events:none;z-index:2147483647;animation:dsh-browser-annotation-pulse 0.5s ease-in-out;';
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-35px;left:50%;transform:translateX(-50%);background:${color};color:white;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      label.textContent = '${type === "click" ? "🖱️" : "⌨️"} [${elementIndex}] (${Math.round(x)},${Math.round(y)})';
      annotation.appendChild(label);
      if (!document.getElementById('dsh-browser-annotation-style')) {
        var style = document.createElement('style');
        style.id = 'dsh-browser-annotation-style';
        style.textContent = '@keyframes dsh-browser-annotation-pulse { 0%,100% { opacity:1; transform:translate(-10px,-10px) scale(1); } 50% { opacity:0.7; transform:translate(-10px,-10px) scale(1.5); } }';
        document.head.appendChild(style);
      }
      document.body.appendChild(annotation);
      setTimeout(function() {
        annotation.style.transition = 'opacity 0.3s';
        annotation.style.opacity = '0';
        setTimeout(function() { annotation.remove(); }, 300);
      }, 2500);
    })()`;
		await this.evaluate(js);
	}
	/**
	* Show a camera viewfinder overlay and shutter flash effect for screenshot capture.
	* The rect is in viewport-relative CSS pixels.
	* Must be called within withClient().
	*/
	async showCaptureAnnotation(rect) {
		const { x, y, width, height } = rect;
		const js = `(function() {
      var existing = document.querySelectorAll('.dsh-browser-capture-annotation');
      existing.forEach(function(el) { el.remove(); });

      if (!document.getElementById('dsh-browser-capture-style')) {
        var style = document.createElement('style');
        style.id = 'dsh-browser-capture-style';
        style.textContent = [
          '@keyframes dsh-browser-capture-focus { 0% { opacity:0; transform:scale(1.1); } 20% { opacity:1; transform:scale(1); } 80% { opacity:1; } 100% { opacity:0; } }',
          '@keyframes dsh-browser-shutter-flash { 0% { opacity:0; } 10% { opacity:0.5; } 100% { opacity:0; } }'
        ].join('\\n');
        document.head.appendChild(style);
      }

      /* viewfinder rectangle */
      var vf = document.createElement('div');
      vf.className = 'dsh-browser-capture-annotation';
      vf.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${width}px;height:${height}px;border:3px solid #00BFFF;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,0.35),0 0 20px rgba(0,191,255,0.5);pointer-events:none;z-index:2147483647;animation:dsh-browser-capture-focus 2.5s ease-out forwards;';

      /* corner brackets */
      var corners = [
        'top:0;left:0;border-top:3px solid #fff;border-left:3px solid #fff;',
        'top:0;right:0;border-top:3px solid #fff;border-right:3px solid #fff;',
        'bottom:0;left:0;border-bottom:3px solid #fff;border-left:3px solid #fff;',
        'bottom:0;right:0;border-bottom:3px solid #fff;border-right:3px solid #fff;'
      ];
      corners.forEach(function(css) {
        var c = document.createElement('div');
        c.style.cssText = 'position:absolute;width:16px;height:16px;' + css;
        vf.appendChild(c);
      });

      /* camera icon label */
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-32px;left:50%;transform:translateX(-50%);background:#00BFFF;color:white;padding:3px 10px;border-radius:4px;font-size:13px;font-weight:bold;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      label.textContent = '📷 capture';
      vf.appendChild(label);

      document.body.appendChild(vf);

      /* shutter flash overlay */
      var flash = document.createElement('div');
      flash.className = 'dsh-browser-capture-annotation';
      flash.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:white;pointer-events:none;z-index:2147483647;animation:dsh-browser-shutter-flash 0.8s ease-out forwards;border-radius:4px;';
      document.body.appendChild(flash);

      setTimeout(function() {
        var all = document.querySelectorAll('.dsh-browser-capture-annotation');
        all.forEach(function(el) {
          el.style.transition = 'opacity 0.3s';
          el.style.opacity = '0';
          setTimeout(function() { el.remove(); }, 300);
        });
      }, 2800);
    })()`;
		await this.evaluate(js);
	}
	/**
	* Scroll element into view (centered), supports OOPIF.
	* Must be called within withClient().
	*/
	async scrollToElement(node) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		let resolveResult;
		try {
			resolveResult = await sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId });
		} catch (e) {
			return;
		}
		const objectId = resolveResult.object?.objectId;
		if (!objectId) return;
		await sendCommand("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: `function() {
        var el = this.nodeType === 3 ? this.parentElement : this;
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }`,
			returnByValue: true
		});
		await sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
	}
	/**
	* Select one of the original option on the page context DOM API.
	* After selection, dispatch input and change events to synchronize framework state with the native DOM; call this only within withClient().
	*/
	async selectOption(node) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		const objectId = (await sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId })).object?.objectId;
		if (!objectId) throw new Error(`Option element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`);
		try {
			const payload = (await sendCommand("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: `function() {
          const option = this;
          if (!(option instanceof HTMLOptionElement)) {
            return { ok: false, error: 'Target is not an option element' };
          }
          if (option.disabled) {
            return { ok: false, error: 'Option is disabled' };
          }

          const select = option.closest('select');
          if (!(select instanceof HTMLSelectElement)) {
            return { ok: false, error: 'No parent select element found' };
          }
          if (select.disabled) {
            return { ok: false, error: 'Select element is disabled' };
          }

          if (select.multiple) {
            option.selected = true;
          } else {
            const valueSetter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value',
            )?.set;
            if (valueSetter) {
              valueSetter.call(select, option.value);
            } else {
              select.value = option.value;
            }
            option.selected = true;
          }

          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            ok: true,
            value: option.value,
            text: option.textContent ? option.textContent.trim() : '',
            multiple: select.multiple,
          };
        }`,
				returnByValue: true
			})).result?.value;
			if (!payload?.ok) throw new Error(payload?.error ?? "Failed to select option");
			return {
				value: payload.value ?? "",
				text: payload.text ?? "",
				multiple: payload.multiple ?? false
			};
		} finally {
			await sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
		}
	}
	/**
	* Set values for controls that are not suitable for keyboard text, such as range, color, date etc.
	* Original input uses property setter to trigger a response update such as React; ARIA slider is adjusted by a directional event.
	* It must be called within the life cycle of withClient()
	*/
	async setInputValue(node, value) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		const objectId = (await sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId })).object?.objectId;
		if (!objectId) throw new Error(`Element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`);
		const isAriaSlider = node.attributes?.role === "slider";
		try {
			const payload = (await sendCommand("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: isAriaSlider ? `function(newValue) {
            // ARIA slider: Focus first, then simulate the direction key and move gradually to the target value.
            this.focus();
            const min = parseFloat(this.getAttribute('aria-valuemin') ?? '0');
            const max = parseFloat(this.getAttribute('aria-valuemax') ?? '100');
            const step = parseFloat(this.getAttribute('aria-valuestep') ?? '1');
            const current = parseFloat(this.getAttribute('aria-valuenow') ?? String(min));
            const target = Math.max(min, Math.min(max, parseFloat(newValue)));
            const steps = Math.round((target - current) / step);
            const key = steps > 0 ? 'ArrowRight' : 'ArrowLeft';
            for (let i = 0; i < Math.abs(steps); i++) {
              this.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            }
            return { ok: true };
          }` : `function(newValue) {
            // Original input: Call original property setter to trigger a responsive update of the framework.
            const proto = Object.getPrototypeOf(this);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(this, newValue);
            } else {
              this.value = newValue;
            }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }`,
				arguments: [{ value }],
				returnByValue: true
			})).result?.value;
			if (!payload?.ok) throw new Error(payload?.error ?? "Failed to set input value");
		} finally {
			await sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
		}
	}
	/**
	* Gets absolute real-time position of node by CDP DOM.getBoxModel.
	* The calculation is the same as absolutePosition: the boundary of the element in itself frame plus the deviation of the host at each level iframe.
	* It must be called within the life cycle of withClient()
	*/
	async getElementRect(node) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const sendCommand = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		let result;
		try {
			result = await sendCommand("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
		} catch (e) {
			throw new Error(`Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`);
		}
		if (!result?.model?.border) throw new Error(`Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`);
		const q = result.model.border;
		const boundsInFrame = {
			x: Math.min(q[0], q[2], q[4], q[6]),
			y: Math.min(q[1], q[3], q[5], q[7]),
			width: Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
			height: Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7])
		};
		let offsetX = 0;
		let offsetY = 0;
		let current = node.parentNode;
		while (current) {
			const tag = current.nodeName.toUpperCase();
			if (tag === "IFRAME" || tag === "FRAME") {
				const iframeSend = current.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(current.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
				try {
					const iframeResult = await iframeSend("DOM.getBoxModel", { backendNodeId: current.backendNodeId });
					if (iframeResult?.model?.content) {
						const iq = iframeResult.model.content;
						offsetX += iq[0];
						offsetY += iq[1];
					}
				} catch {
					if (current.absolutePosition) {
						offsetX += current.absolutePosition.x;
						offsetY += current.absolutePosition.y;
					}
				}
			}
			current = current.parentNode;
		}
		return {
			x: boundsInFrame.x + offsetX,
			y: boundsInFrame.y + offsetY,
			width: boundsInFrame.width,
			height: boundsInFrame.height
		};
	}
	/**
	* truncate the page area by CDP Page.captureScreenshot without scrolling first.
	* clip Use the absolute CSS pixel coordinates of the page instead of the relative coordinates of the mouth of view; they must be called within withClient().
	*/
	async captureClip(clip) {
		return (await this.client.sendCommand("Page.captureScreenshot", {
			format: "jpeg",
			quality: 80,
			clip: {
				...clip,
				scale: 1
			}
		})).data;
	}
	/**
	* Recheck the hit target at the live click position in its owning document.
	* The coordinates are the same as the checkTopElements used to generate the snapshot; they must be called within withClient().
	*/
	async hitTestAtPoint(node, rect) {
		const sessionId = node.oopifSessionId ? this.oopifManager.resolveSessionId(node.oopifSessionId) : void 0;
		const sendCmd = (method, params) => this.client.sendCommand(method, params, void 0, sessionId);
		let point;
		if (sessionId) {
			const [box, metrics] = await Promise.all([sendCmd("DOM.getBoxModel", { backendNodeId: node.backendNodeId }), sendCmd("Page.getLayoutMetrics")]);
			const q = box.model.border;
			const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
			point = {
				x: Math.round((q[0] + q[2] + q[4] + q[6]) / 4 + viewport.pageX),
				y: Math.round((q[1] + q[3] + q[5] + q[7]) / 4 + viewport.pageY)
			};
		} else point = await this.toDocumentPoint(rect ?? node.absolutePosition);
		if (!point) return false;
		const hitBackendNodeId = await elementFromPoint(sendCmd, point.x, point.y);
		if (hitBackendNodeId === void 0) return false;
		const snapshotHit = node.renderInfo.hitBackendNodeId;
		if (hitBackendNodeId === snapshotHit || hitBackendNodeId === node.backendNodeId) return true;
		let root = node;
		while (root.parentNode && root.parentNode.oopifSessionId === node.oopifSessionId) root = root.parentNode;
		const findHost = (candidate) => {
			if (candidate.oopifSessionId !== node.oopifSessionId) return void 0;
			if (candidate.pseudoElementIds?.includes(hitBackendNodeId)) return candidate.backendNodeId;
			for (const child of [
				...candidate.childrenNodes ?? [],
				...candidate.shadowRoots ?? [],
				...candidate.contentDocument ? [candidate.contentDocument] : []
			]) {
				const host = findHost(child);
				if (host !== void 0) return host;
			}
		};
		const host = findHost(root);
		return host !== void 0 && (host === snapshotHit || host === node.backendNodeId);
	}
	/** Centre of a viewport rect, moved into the main document's coordinates. */
	async toDocumentPoint(rect) {
		if (!rect) return void 0;
		const metrics = await this.commands.getLayoutMetrics();
		const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
		return {
			x: Math.round(rect.x + rect.width / 2 + css.pageX),
			y: Math.round(rect.y + rect.height / 2 + css.pageY)
		};
	}
	/**
	* Execute a JS function on the given node, with the element as `this`.
	* Returns the JSON-serializable return value of the function.
	*/
	async executeOnElement(node, functionDeclaration) {
		const sessionId = node.oopifSessionId ? this.oopifManager.resolveSessionId(node.oopifSessionId) : void 0;
		const { object } = await this.client.sendCommand("DOM.resolveNode", { backendNodeId: node.backendNodeId }, void 0, sessionId);
		if (!object.objectId) throw new Error("Could not resolve element");
		try {
			const result = await this.client.sendCommand("Runtime.callFunctionOn", {
				objectId: object.objectId,
				functionDeclaration,
				returnByValue: true,
				awaitPromise: true
			}, void 0, sessionId);
			if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Element script failed");
			return result.result.value;
		} finally {
			await this.client.sendCommand("Runtime.releaseObject", { objectId: object.objectId }, void 0, sessionId).catch(() => {});
		}
	}
	async getElementState(node) {
		if (node.oopifSessionId) await this.ensureOOPIF();
		const send = node.oopifSessionId ? (method, params) => this.oopifManager.sendCommand(node.oopifSessionId, method, params) : (method, params) => this.client.sendCommand(method, params);
		const objectId = (await send("DOM.resolveNode", { backendNodeId: node.backendNodeId })).object?.objectId;
		if (!objectId) throw new Error("Element reference is stale; re-observe the page.");
		try {
			const result = await send("Runtime.callFunctionOn", {
				objectId,
				returnByValue: true,
				functionDeclaration: `function() { return { connected: this.isConnected, disabled: this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true', readOnly: !!this.readOnly, value: String(this.value ?? this.getAttribute('aria-valuenow') ?? this.textContent ?? '') } }`
			});
			if (result.exceptionDetails || !result.result?.value) throw new Error("Unable to verify live element state.");
			return result.result.value;
		} finally {
			await send("Runtime.releaseObject", { objectId }).catch(() => {});
		}
	}
	/**
	* All complex operations that require CDP are entered through here: confirm that the main session is available, then find OOPIF and then execute it in the same client context.
	* The caller should not cache the internal session; navigation or cross-domain iframe will refresh the router when rebuilt.
	*/
	async withClient(fn) {
		this.clientRefCount++;
		try {
			await this.client.attach();
			return await fn();
		} finally {
			this.clientRefCount--;
			if (this.clientRefCount === 0) {
				await this.oopifManager.cleanup();
				await this.client.cleanup();
			}
		}
	}
	/**
	* If OOPIF session has been cleared, rediscover and create old, new sessionId maps as required.
	* All operations CDP commands that need to be sent to the OOPIF node should be called first and must be located in withClient().
	*/
	async ensureOOPIF() {
		if (!this.oopifManager.isConnected()) await this.oopifManager.discoverOOPIFs(this.client, "remap");
	}
	/**
	* Write complete DOM snapshots and associated data such as selector roller containers, visual elements and viewports according to domId.
	*/
	setCachedDomTree(domId, domTree, selectorMap, scrollContainerMap, visualElementMap, url, viewportStats, expand, hasOverlay, topElementCount) {
		this.setSnapshot(domId, {
			explorationFingerprint: explorationFingerprint(domTree),
			domTree,
			selectorMap,
			scrollContainerMap,
			visualElementMap,
			topElementCount: topElementCount ?? 0,
			url,
			viewportStats,
			expand,
			hasOverlay
		});
	}
	/**
	* Record a click or input interaction on the latest cache snapshot.
	* Recording backendNodeId to enable subsequent consumers to track operationally operated elements.
	*/
	recordInteraction(backendNodeId, action, renderedLine, params, frameId = "main") {
		let latest;
		for (const snapshot of this.cache.values()) if (!latest || snapshot.timestamp > latest.timestamp) latest = snapshot;
		if (!latest) return;
		if (!latest.interactions) latest.interactions = [];
		latest.interactions.push({
			backendNodeId,
			frameId,
			action,
			renderedLine,
			params,
			timestamp: Date.now()
		});
	}
	/**
	* Groups cached interactions by owning frame and backendNodeId.
	*/
	collectInteractions() {
		const map = /* @__PURE__ */ new Map();
		for (const snapshot of this.cache.values()) {
			if (!snapshot.interactions) continue;
			for (const record of snapshot.interactions) {
				let list = map.get(`${record.frameId ?? "main"}:${record.backendNodeId}`);
				if (!list) {
					list = [];
					map.set(`${record.frameId ?? "main"}:${record.backendNodeId}`, list);
				}
				list.push(record);
			}
		}
		return map;
	}
	/**
	* To build an exploratory progress data for all scrolling containers, which page breaks have been viewed.
	* Scans only caches with the same root backendNodeId.
	* `#` marks previously viewed pages, `>` marks the current viewport, and `_` marks unexplored pages.
	*/
	getExplorationBars(domId) {
		const target = this.getSnapshot(domId);
		if (!target?.viewportStats) return null;
		const rootId = target.domTree.backendNodeId;
		let siblingCount = 0;
		for (const [id, snapshot] of this.cache) if (id !== domId && snapshot.domTree.backendNodeId === rootId) {
			siblingCount++;
			break;
		}
		if (siblingCount === 0) return null;
		const totalPagesMap = /* @__PURE__ */ new Map();
		for (const sc of target.viewportStats) {
			const total = Math.ceil(sc.pagesAbove + 1 + sc.pagesBelow);
			if (total > 1) totalPagesMap.set(sc.index, total);
		}
		if (totalPagesMap.size === 0) return null;
		const result = /* @__PURE__ */ new Map();
		for (const [cIdx, totalPages] of totalPagesMap) {
			const intervals = [];
			let curInterval = null;
			for (const [id, snapshot] of this.cache) {
				if (snapshot.domTree.backendNodeId !== rootId || snapshot.url !== target.url) continue;
				if (snapshot.explorationFingerprint !== target.explorationFingerprint) continue;
				if (!snapshot.viewportStats) continue;
				const targetNode = target.scrollContainerMap.get(cIdx);
				const oldIndex = cIdx === 0 ? 0 : [...snapshot.scrollContainerMap].find(([, node]) => node.backendNodeId === targetNode?.backendNodeId && node.frameId === targetNode?.frameId)?.[0];
				const sc = snapshot.viewportStats.find((s) => s.index === oldIndex);
				const targetStats = target.viewportStats.find((s) => s.index === cIdx);
				if (sc?.viewportSize !== targetStats?.viewportSize || sc?.contentSize !== targetStats?.contentSize) continue;
				if (!sc) continue;
				const start = sc.pagesAbove;
				const end = sc.pagesAbove + 1;
				intervals.push([start, end]);
				if (id === domId) curInterval = [start, end];
			}
			intervals.sort((a, b) => a[0] - b[0]);
			const merged = [];
			for (const [s, e] of intervals) if (merged.length > 0 && s <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
			else merged.push([s, e]);
			const explored = [];
			const current = [];
			const unexplored = [];
			for (let p = 0; p < totalPages; p++) {
				const last = target.viewportStats.find((s) => s.index === cIdx);
				const end = Math.min(p + 1, last.pagesAbove + 1 + last.pagesBelow);
				const isCurrent = curInterval && curInterval[0] <= p + 1e-6 && curInterval[1] >= end - 1e-6;
				const isExplored = merged.some(([s, e]) => s <= p + 1e-6 && e >= end - 1e-6);
				if (isCurrent) current.push(p);
				else if (isExplored) explored.push(p);
				else unexplored.push(p);
			}
			result.set(cIdx, {
				explored,
				current,
				unexplored
			});
		}
		return result;
	}
	/**
	* Builds DOM trees and calculates rendering information; pre-call is assumed to be CDPClient connected.
	* @param options.expand - Widen view range in pages; 1 indicates an outward extension of the view height or width to mark elements outside the visual area.
	*/
	async extractCurrentDomTree(options) {
		const root = await this.buildTree(options?.fullAX);
		await computeRenderInfo(root, this.client, options, this.oopifManager);
		return root;
	}
	/**
	* Render DOM tree to HTML text, and calculate selectorMap, scrolling container and visual element mapping.
	* Pre-call assumes CDPClient is connected.
	*/
	async renderDomTree(domTree, options) {
		const { copy: rootForRender } = copyDomTree(domTree);
		const lookup = buildNodeKeyLookup(domTree);
		pruneTree(rootForRender, lookup);
		this.settleMonitor.suspend();
		const selectorMap = await assignAndHighlight(rootForRender, this.client, this.oopifManager, lookup, { highlight: options?.highlight }).finally(() => this.settleMonitor.resume());
		const scrollContainerMap = buildScrollContainerMap(rootForRender, lookup);
		const visualElementMap = buildVisualElementMap(rootForRender);
		const html = renderToHtml(rootForRender, 0, lookup, this.collectInteractions(), { incrementalDiff: options?.incrementalDiff });
		const hasOverlay = (function walk(node) {
			if (node.renderInfo?.isOverlay) return true;
			for (const child of node.childrenNodes ?? []) if (walk(child)) return true;
			return false;
		})(domTree);
		saveDebugJson("domTree.json", flattenDomTree(domTree));
		saveDebugHtml("domTree.txt", domTree);
		let topElementCount = 0;
		const countTop = (node) => {
			if (node.renderInfo?.isTopElement) topElementCount++;
			for (const c of node.childrenNodes ?? []) countTop(c);
			for (const s of node.shadowRoots ?? []) countTop(s);
			if (node.contentDocument) countTop(node.contentDocument);
		};
		countTop(rootForRender);
		return {
			html,
			selectorMap,
			scrollContainerMap,
			visualElementMap,
			hasOverlay,
			topElementCount
		};
	}
	/**
	* The layout indicator is obtained by CDP and the remaining upper and lower ranges of the main page and the scrolling containers are calculated by “pages per page”.
	* It must be called within the life cycle of withClient()
	*/
	async computeViewportStats(scrollContainerMap) {
		const metrics = await this.commands.getLayoutMetrics();
		const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
		const viewportHeight = css.clientHeight;
		const scrollY = css.pageY;
		const pageHeight = metrics.cssContentSize.height;
		const scrollContainers = [];
		const pixelsAbove = scrollY;
		const pixelsBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
		scrollContainers.push({
			index: 0,
			viewportSize: viewportHeight,
			contentSize: pageHeight,
			pagesAbove: viewportHeight > 0 ? pixelsAbove / viewportHeight : 0,
			pagesBelow: viewportHeight > 0 ? pixelsBelow / viewportHeight : 0
		});
		for (const [index, node] of scrollContainerMap) {
			const sr = node.snapshotNode?.scrollRects;
			const cr = node.snapshotNode?.clientRects;
			if (!sr || !cr || cr.height <= 0) continue;
			const horizontal = node.renderInfo.isHorizontalScroll;
			const scrollTop = horizontal ? sr.x : sr.y;
			const scrollableHeight = horizontal ? sr.width : sr.height;
			const visibleHeight = horizontal ? cr.width : cr.height;
			if (visibleHeight <= 0) continue;
			const above = scrollTop;
			const below = Math.max(0, scrollableHeight - visibleHeight - scrollTop);
			scrollContainers.push({
				index,
				viewportSize: visibleHeight,
				contentSize: scrollableHeight,
				pagesAbove: above / visibleHeight,
				pagesBelow: below / visibleHeight
			});
		}
		return scrollContainers;
	}
	/**
	* Compare two caches DOM with a snapshot and create a difference tree.
	* returns null when the snapshot is missing, or origin is different and can be considered different pages.
	*/
	renderMarkdown(domTree) {
		const { copy } = copyDomTree(domTree);
		pruneForMarkdown(copy);
		return renderToMarkdown(copy);
	}
	getDiffTree(oldDomId, newDomId, show = "both") {
		const oldSnapshot = this.cache.get(oldDomId);
		const newSnapshot = this.cache.get(newDomId);
		if (!oldSnapshot?.domTree || !newSnapshot?.domTree) return null;
		try {
			if (oldSnapshot.url && newSnapshot.url) {
				if (new URL(oldSnapshot.url).origin !== new URL(newSnapshot.url).origin) return null;
			}
		} catch {}
		return createDiffTree(oldSnapshot.domTree, newSnapshot.domTree, show);
	}
	/**
	* Counts the number of new and deleted elements between the two cache snapshots and their relative proportion to the total number of old and new visible elements.
	*/
	getDiffStats(oldDomId, newDomId, precomputed) {
		const oldSnapshot = this.cache.get(oldDomId);
		const newSnapshot = this.cache.get(newDomId);
		const diffTree = precomputed === void 0 ? this.getDiffTree(oldDomId, newDomId) : precomputed;
		if (!diffTree || !oldSnapshot || !newSnapshot) return null;
		const { copy: prunedTree } = copyDomTree(diffTree);
		pruneTree(prunedTree);
		let added = 0;
		let removed = 0;
		const visit = (node) => {
			if (node.renderInfo.diffStatus === "added") added++;
			else if (node.renderInfo.diffStatus === "removed") removed++;
			for (const c of node.childrenNodes ?? []) visit(c);
			for (const s of node.shadowRoots ?? []) visit(s);
			if (node.contentDocument) visit(node.contentDocument);
		};
		visit(prunedTree);
		const oldTotal = oldSnapshot.topElementCount;
		const newTotal = newSnapshot.topElementCount;
		return {
			added,
			removed,
			addedRatio: newTotal > 0 ? added / newTotal : 0,
			removedRatio: oldTotal > 0 ? removed / oldTotal : 0
		};
	}
	/**
	* Shared tree construction process: Waiting for page stabilization, synchronizing real-time form status, collecting CDP data and building DOM trees.
	*/
	/**
	* Snapshot collection entry point: wait for DOM and network stability, synchronize live
	* form values, then collect CDP data from the main frame and OOPIFs before building the tree.
	* Preserve this order so cross-origin iframe data is complete and current when serialized.
	*/
	async buildTree(fullAX = false) {
		await this.settleReady;
		await this.oopifManager.discoverOOPIFs(this.client);
		await this.settleMonitor.waitForSettle(1e4);
		await this.commands.injectSelectValues();
		await this.commands.injectInputValues();
		const { root } = await new DOMTreeBuilder(await this.commands.getAllTrees({
			fullAX,
			oopifManager: this.oopifManager
		})).build();
		return root;
	}
	getSnapshot(domId) {
		const snapshot = this.cache.get(domId);
		if (snapshot) snapshot.timestamp = Date.now();
		return snapshot;
	}
	setSnapshot(domId, snapshot) {
		this.evictIfNeeded();
		this.cache.set(domId, {
			...snapshot,
			timestamp: Date.now(),
			navigationIndex: this.domIdCounter
		});
	}
	/** The LRU phase-out is the longest without access to snapshots, limiting DOM memory in long missions; the old stateId may not recover locally after phase-out. */
	evictIfNeeded() {
		if (this.cache.size >= this.maxCacheSize) {
			let oldestId = null;
			let oldestTime = Infinity;
			for (const [id, snapshot] of this.cache) if (snapshot.timestamp < oldestTime) {
				oldestTime = snapshot.timestamp;
				oldestId = id;
			}
			if (oldestId) this.cache.delete(oldestId);
		}
	}
};
//#endregion
//#region src/browser/cdp/client.ts
/**
* CDP (Chrome DevTools Protocol) Client
*
* Wraps puppeteer-core's CDPSession for easier use.
* Provides a unified event interface compatible with the settle-monitor.
*/
const CDP_EVENTS_TO_FORWARD = [
	"Network.requestWillBeSent",
	"Network.loadingFinished",
	"Network.loadingFailed",
	"Network.responseReceived",
	"DOM.childNodeInserted",
	"DOM.childNodeRemoved",
	"DOM.childNodeCountUpdated",
	"DOM.attributeModified",
	"DOM.attributeRemoved",
	"DOM.characterDataModified",
	"Target.attachedToTarget"
];
/**
* Adapter that converts Playwright CDPSession per-method events
* into Electron-style unified 'message' events.
* Used by PageSettleMonitor which expects `on('message', (event, method, params) => ...)`.
*/
var CDPEventBridge = class extends EventEmitter {
	session;
	handlers = /* @__PURE__ */ new Map();
	constructor(session) {
		super();
		this.session = session;
	}
	startForwarding() {
		for (const method of CDP_EVENTS_TO_FORWARD) {
			const handler = (params) => {
				this.emit("message", null, method, params ?? {});
			};
			this.handlers.set(method, handler);
			this.session.on(method, handler);
		}
	}
	stopForwarding() {
		for (const [method, handler] of this.handlers) this.session.off(method, handler);
		this.handlers.clear();
	}
};
/**
* Register the session a Target.attachToTarget just created, so later commands
* on it get a tape key that survives across runs (see CDPTape.noteSession).
*/
function noteAttachedSession(tape, method, params, result) {
	if (method !== "Target.attachToTarget") return;
	const targetId = params?.targetId;
	const sessionId = result?.sessionId;
	if (typeof targetId === "string" && sessionId) tape.noteSession(sessionId, targetId);
}
var CDPClient = class {
	session;
	debug;
	eventBridge;
	closed = false;
	tape = null;
	stats = null;
	constructor(session, options = {}) {
		this.session = session;
		this.debug = options.debug ?? process.env.CDP_DEBUG === "true";
		this.eventBridge = new CDPEventBridge(session);
		this.eventBridge.startForwarding();
	}
	async attach() {}
	async detach() {}
	/**
	* Attach a record/replay tape. Used by the DOM regression harness only;
	* with no tape set this client behaves exactly as before.
	*/
	setTape(tape, mode = "replay") {
		this.tape = tape ? {
			tape,
			mode
		} : null;
	}
	/** Attach a per-method call counter. Diagnostics only; off by default. */
	setStats(stats) {
		this.stats = stats;
	}
	async sendCommand(method, params, timeout = 1e4, sessionId) {
		return this.dispatch(method, params, timeout, sessionId);
	}
	/**
	* Resolve the session a command must run in.
	*
	* Out-of-process iframes are attached with flatten:true, which gives each one
	* its own session; puppeteer tracks those on the connection. Commands aimed
	* at a frame have to go through its session — sending them on the page
	* session silently answers for the main frame instead, which is worse than
	* failing, so an unknown sessionId throws.
	*/
	sessionFor(sessionId, method) {
		if (!sessionId) return this.session;
		const child = this.session.connection()?.session(sessionId);
		if (!child) throw new Error(`[CDP] No session ${sessionId} for ${method} (frame detached?)`);
		return child;
	}
	async dispatch(method, params, timeout, sessionId) {
		const taped = this.tape;
		const tapeKey = taped ? taped.tape.key(method, params, sessionId) : "";
		if (taped?.mode === "replay") {
			const entry = taped.tape.replay(tapeKey);
			if (!entry.ok) throw new Error(String(entry.value));
			noteAttachedSession(taped.tape, method, params, entry.value);
			return entry.value;
		}
		if (this.closed) throw new Error("[CDP] Session is closed");
		const target = this.sessionFor(sessionId, method);
		let timer;
		const startedAt = this.stats ? performance.now() : 0;
		try {
			const timeoutPromise = new Promise((_, reject) => {
				timer = setTimeout(() => {
					reject(/* @__PURE__ */ new Error(`[CDP] Command timeout after ${timeout}ms: ${method}`));
				}, timeout);
			});
			const result = await Promise.race([target.send(method, params), timeoutPromise]);
			if (taped) {
				taped.tape.record(tapeKey, {
					ok: true,
					value: result
				});
				noteAttachedSession(taped.tape, method, params, result);
			}
			return result;
		} catch (error) {
			if (taped) taped.tape.record(tapeKey, {
				ok: false,
				value: error instanceof Error ? error.message : String(error)
			});
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (errorMessage.includes("timeout")) throw new Error(`[CDP] Command timed out after ${timeout}ms: ${method}`);
			throw new Error(`[CDP] Command failed (${method}): ${errorMessage}`);
		} finally {
			clearTimeout(timer);
			this.stats?.record(method, performance.now() - startedAt);
		}
	}
	async sendCommandWithRetry(method, params, options = {}) {
		const { maxRetries = 2, retryDelay = 1e3, timeout = 1e4, sessionId } = options;
		let lastError = null;
		for (let attempt = 0; attempt <= maxRetries; attempt++) try {
			return await this.sendCommand(method, params, timeout, sessionId);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			if (lastError.message.includes("closed")) throw lastError;
			if (attempt === maxRetries) break;
			await new Promise((resolve) => setTimeout(resolve, retryDelay));
		}
		throw lastError || /* @__PURE__ */ new Error("[CDP] Command failed after all retries");
	}
	isDebuggerAttached() {
		return !this.closed;
	}
	/**
	* Returns the event bridge that emits unified 'message' events.
	* Compatible with settle-monitor's CdpDebugger interface.
	*/
	getDebugger() {
		return this.eventBridge;
	}
	getSession() {
		return this.session;
	}
	async cleanup() {
		this.eventBridge.stopForwarding();
		this.closed = true;
		await this.session.detach().catch(() => {});
	}
};
//#endregion
export { VALUE_SETTABLE_INPUT_TYPES as i, DomService as n, PageSettleMonitor as r, CDPClient as t };

//# sourceMappingURL=client-D5KYi2G_.js.map
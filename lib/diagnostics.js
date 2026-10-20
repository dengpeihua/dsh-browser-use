import { n as DomService, r as PageSettleMonitor, t as CDPClient } from "./client-D5KYi2G_.js";
import * as fs from "fs";
import { EventEmitter } from "node:events";
import * as zlib from "zlib";
//#region src/browser/cdp/tape.ts
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
/** Stable stringify: object keys sorted so the same params always hash alike. */
function stable(value) {
	if (value === void 0) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}
var CDPTapeMiss = class extends Error {
	key;
	constructor(key) {
		super(`[CDPTape] no recorded response for ${key}`);
		this.key = key;
	}
};
var CDPTape = class CDPTape {
	data = /* @__PURE__ */ new Map();
	cursor = /* @__PURE__ */ new Map();
	missed = [];
	/** sessionId → targetId, rebuilt from Target.attachToTarget on every run */
	sessionAlias = /* @__PURE__ */ new Map();
	url = "";
	capturedAt = "";
	/**
	* Chrome hands out a fresh sessionId every time a target is attached, so a
	* raw sessionId in the key would make the tape usable by exactly the run that
	* produced it. Keys use the target the session belongs to instead, which is
	* stable for as long as the page is loaded.
	*/
	noteSession(sessionId, targetId) {
		this.sessionAlias.set(sessionId, targetId);
	}
	key(method, params, sessionId) {
		return `${sessionId ? this.sessionAlias.get(sessionId) ?? sessionId : ""}|${method}|${stable(params)}`;
	}
	record(key, result) {
		const list = this.data.get(key);
		if (list) list.push(result);
		else this.data.set(key, [result]);
	}
	/**
	* Return the next recorded response for a key. Repeated calls past the end of
	* the recorded list reuse the last response — CDP reads here are idempotent,
	* and concurrency can change how often a given key is hit.
	*/
	replay(key) {
		const list = this.data.get(key);
		if (!list || list.length === 0) {
			this.missed.push(key);
			throw new CDPTapeMiss(key);
		}
		const at = this.cursor.get(key) ?? 0;
		this.cursor.set(key, at + 1);
		return list[Math.min(at, list.length - 1)];
	}
	/** Keys that were requested during replay but never recorded. */
	misses() {
		return this.missed;
	}
	/** Rewind so the tape can be replayed again from the start. */
	reset() {
		this.cursor.clear();
		this.missed = [];
		this.sessionAlias.clear();
	}
	/**
	* Rewrite every recorded response for one CDP method in place.
	*
	* Used by ablation experiments: strip a field out of a recorded payload to
	* see what the pipeline would produce had the browser never sent it.
	*/
	mapResults(method, fn) {
		const marker = `|${method}|`;
		for (const [key, results] of this.data) {
			if (!key.includes(marker)) continue;
			for (const entry of results) if (entry.ok) entry.value = fn(entry.value, key);
		}
	}
	get size() {
		return this.data.size;
	}
	save(filepath) {
		const file = {
			version: 1,
			url: this.url,
			capturedAt: this.capturedAt,
			entries: [...this.data.entries()]
		};
		fs.writeFileSync(filepath, zlib.gzipSync(JSON.stringify(file)));
	}
	static load(filepath) {
		const file = JSON.parse(zlib.gunzipSync(fs.readFileSync(filepath)).toString("utf8"));
		if (file.version !== 1 || !Array.isArray(file.entries) || typeof file.url !== "string" || typeof file.capturedAt !== "string") throw new Error("Unsupported or malformed CDP tape");
		const tape = new CDPTape();
		tape.url = file.url;
		tape.capturedAt = file.capturedAt;
		for (const [key, results] of file.entries) tape.data.set(key, results);
		return tape;
	}
};
//#endregion
//#region src/browser/cdp/stats.ts
var CDPStats = class {
	byMethod = /* @__PURE__ */ new Map();
	record(method, ms) {
		const entry = this.byMethod.get(method);
		if (entry) {
			entry.count++;
			entry.ms += ms;
		} else this.byMethod.set(method, {
			count: 1,
			ms
		});
	}
	reset() {
		this.byMethod.clear();
	}
	get totalCalls() {
		let n = 0;
		for (const entry of this.byMethod.values()) n += entry.count;
		return n;
	}
	get totalMs() {
		let n = 0;
		for (const entry of this.byMethod.values()) n += entry.ms;
		return n;
	}
	/** Rows sorted by time spent, descending. */
	rows() {
		return [...this.byMethod].map(([method, e]) => ({
			method,
			count: e.count,
			ms: e.ms
		})).sort((a, b) => b.ms - a.ms);
	}
};
//#endregion
//#region src/diagnostics.ts
/** Explicit, opt-in local diagnostics. Browser tools never record CDP traffic by default. */
/** Capture an isolated pipeline baseline, excluding the live Agent's interaction history. */
async function captureDomTape(page, fullAX = false) {
	const client = new CDPClient(await page.createCDPSession());
	const tape = new CDPTape();
	tape.url = page.url();
	tape.capturedAt = (/* @__PURE__ */ new Date()).toISOString();
	const stats = new CDPStats();
	client.setTape(tape, "record");
	client.setStats(stats);
	const service = new DomService(page, client);
	try {
		return {
			tape,
			result: await runDomPipeline(service, fullAX),
			stats: stats.rows()
		};
	} finally {
		client.setTape(null);
		client.setStats(null);
		await service.destroySettle();
	}
}
/** Uses the same extraction/rendering methods as getPageDom, with live stage timings. */
async function runDomPipeline(service, fullAX = false) {
	const start = performance.now();
	await service.cleanupHighlightsBeforeSnapshot();
	const root = await service.extractCurrentDomTree({
		expand: .8,
		fullAX
	});
	const extracted = performance.now();
	const rendered = await service.renderDomTree(root);
	const finished = performance.now();
	return {
		html: rendered.html,
		elementIds: [...rendered.selectorMap.keys()],
		stagesMs: {
			extract: extracted - start,
			render: finished - extracted,
			total: finished - start
		}
	};
}
/** A socket-free replay. Any missing request fails verification, even if production code tolerates it. */
async function replayDomTape(tape, fullAX = false) {
	tape.reset();
	const stub = Object.assign(new EventEmitter(), {
		send: async () => {
			throw new Error("Offline replay attempted a live CDP call");
		},
		detach: async () => {}
	});
	const client = new CDPClient(stub);
	client.setTape(tape, "replay");
	const service = new DomService({}, client);
	try {
		const result = await runDomPipeline(service, fullAX);
		if (tape.misses().length) throw new Error(`Incomplete CDP tape: ${tape.misses().length} missing requests; first: ${tape.misses()[0]}`);
		return result;
	} finally {
		client.setTape(null);
		await service.destroySettle();
	}
}
//#endregion
export { CDPClient, CDPStats, CDPTape, CDPTapeMiss, DomService, PageSettleMonitor, captureDomTape, replayDomTape, runDomPipeline };

//# sourceMappingURL=diagnostics.js.map
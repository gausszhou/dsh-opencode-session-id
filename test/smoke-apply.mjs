#!/usr/bin/env node
/**
 * Mount smoke test: runs the plugin's `apply()` against a minimal cordis-like
 * context and checks the wiring:
 *  1. the `llm/stream` listener is registered,
 *  2. iterating the returned stream keeps the session id visible to fetch
 *     (so the fetch wrapper can read it),
 *  3. the fetch wrapper is installed on mount and restored on dispose.
 */
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function fakeCtx() {
	const listeners = new Map();
	let disposeEffect;
	return {
		events: listeners,
		logger: {
			info() {},
			debug() {},
			warn() {},
		},
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		effect(fn) {
			// fn returns the disposer
			disposeEffect = fn ? fn() : undefined;
			return () => disposeEffect?.();
		},
		_lateDispose() {
			return disposeEffect?.();
		},
	};
}

const preApplyFetch = globalThis.fetch;
assert.ok(preApplyFetch !== undefined, "a fetch existed before mount");
const calls = [];
globalThis.fetch = async (url, init) => {
	calls.push({ url: String(url), init: init ?? {} });
	return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
};
const recorder = globalThis.fetch;

const ctx = fakeCtx();
apply(ctx, {});

assert.ok(ctx.events.has("llm/stream"), "llm/stream listener registered");
const listener = ctx.events.get("llm/stream");

// Downstream: an async generator that performs a fetch inside its body.
const downstream = (async function* () {
	await globalThis.fetch("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer x" } });
	yield { type: "finish", reason: { kind: "stop" } };
})();

// Dispatch the waterfall listener the way the harness does: listener(options, next)
const scoped = listener({ provider: "opencode-go", model: "deepseek-v4-flash", sessionId: "session-smoke-1", messages: [] }, () => downstream);
const iterator = scoped[Symbol.asyncIterator]();
const first = await iterator.next();
assert.deepEqual(first.value, { type: "finish", reason: { kind: "stop" } });
await iterator.return?.();

const hit = calls.find((c) => String(c.url).includes("opencode.ai"));
assert.ok(hit, "downstream fetch observed");
const headers = new Headers(hit.init.headers);
assert.equal(headers.get("x-session-affinity"), "session-smoke-1", "fetch inside the scoped stream saw the session id");
assert.equal(headers.get("authorization"), "Bearer x", "existing headers preserved");
assert.notEqual(globalThis.fetch, recorder, "fetch wrapper installed at mount (replaces the current fetch)")

// Dispose restores the previous fetch.
const disposer = ctx._lateDispose();
if (typeof disposer === "function") disposer();
else ctx.effect(() => undefined); // no-op keep-alive
assert.equal(globalThis.fetch, recorder, "fetch restored on dispose (back to the pre-mount fetch)")

console.log("smoke: apply() wiring OK (listener registered, scoped fetch carries session id, mount/dispose fetch lifecycle)");
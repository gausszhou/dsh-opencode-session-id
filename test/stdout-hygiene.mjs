#!/usr/bin/env node
/**
 * stdout hygiene: the plugin must never write to stdout. The `acp`, `headless`
 * and `sdk` profiles carry a protocol (JSON-RPC) or the final answer there, so
 * the mount banner and the `verbose` injection log belong on stderr — which
 * systemd/journal still captures. Regression for "ACP stdout line was not
 * valid JSON; ignoring line".
 */
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/** Minimal cordis-like context; same shape as test/smoke-apply.mjs. */
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
			disposeEffect = fn ? fn() : undefined;
			return () => disposeEffect?.();
		},
		_lateDispose() {
			return disposeEffect?.();
		},
	};
}

const out = [];
const err = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => {
	out.push(String(chunk));
	return true;
};
process.stderr.write = (chunk) => {
	err.push(String(chunk));
	return true;
};

const preApplyFetch = globalThis.fetch;
globalThis.fetch = async () =>
	new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });

try {
	// verbose:true also exercises the per-injection log inside the fetch wrapper.
	const ctx = fakeCtx();
	apply(ctx, { verbose: true });
	const listener = ctx.events.get("llm/stream");
	assert.ok(listener !== undefined, "llm/stream listener registered");

	const scoped = listener(
		{ provider: "opencode-go", model: "deepseek-flash", sessionId: "session-stdout-hygiene", messages: [] },
		() =>
			(async function* () {
				await globalThis.fetch("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST" });
				yield { type: "finish", reason: { kind: "stop" } };
			})()
	);
	const iterator = scoped[Symbol.asyncIterator]();
	await iterator.next();
	await iterator.return?.();
	ctx._lateDispose();
} finally {
	process.stdout.write = realOut;
	process.stderr.write = realErr;
	globalThis.fetch = preApplyFetch;
}

const stdout = out.join("");
const stderr = err.join("");

assert.equal(stdout, "", `plugin wrote to stdout: ${JSON.stringify(stdout)}`);
assert.ok(stderr.includes("[opencode-session-id] mounted:"), "mount banner missing from stderr");
assert.ok(stderr.includes("[opencode-session-id] https://"), "verbose injection log missing from stderr");

realOut("stdout-hygiene: stdout untouched, banner and verbose log on stderr\n");

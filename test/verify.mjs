#!/usr/bin/env node
/**
 * Offline verification for dsh-opencode-session-id.
 *
 * Drives the REAL pi-ai library — the very one dsh's `llm-pi-ai` adapter uses
 * (it is opencode's own AI library, @earendil-works/pi-ai, bundled inside the
 * dsh CLI install) — through this plugin's fetch wrapper and asserts that the
 * actual HTTP request to the opencode gateway carries the session-id headers.
 *
 * Run:  node test/verify.mjs
 * Needs: an installed dsh CLI (default path /home/gauss/.npm-global/...,
 * override with DSH_NODE_MODULES=<dir containing @earendil-works>) and the
 * repo-local symlink node_modules/@deepseek-ai/schemastery -> the dsh CLI's
 * copy (checked in dev only; the profile install resolves it itself).
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { createSessionScope, installSessionHeaderFetch, matchesTarget, normalize, withSessionHeaders } from "../lib/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_NODE_MODULES = process.env.DSH_NODE_MODULES ?? "/home/gauss/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules";
const PI_AI_BASE = join(DSH_NODE_MODULES, "@earendil-works/pi-ai/dist");

const { streamSimple } = await import(pathToFileURL(join(PI_AI_BASE, "api/openai-completions.js")).href);
const catalog = JSON.parse(
	readFileSync(join(PI_AI_BASE, "providers/data/opencode-go.json"), "utf8"),
);
const MODEL = { ...catalog["openai-completions"]["deepseek-v4-flash"] };
const CONTEXT = {
	systemPrompt: "verify",
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	tools: [],
};

/** Stub fetch: records every call and answers an empty SSE stream. */
function recordingFetch(records) {
	const stub = async (url, init) => {
		records.push({ url: String(url), init: init ?? {} });
		return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return stub;
}

async function opencodeChat(scope, sessionId, signal) {
	const stream = await new Promise((resolve, reject) => {
		const guard = setTimeout(() => reject(new Error("streamSimple did not return")), 3000);
		try {
			resolve(scope.run(sessionId, () => streamSimple(MODEL, CONTEXT, {
				sessionId,
				signal,
				cacheRetention: "short",
				apiKey: "test-key",
				headers: {},
			})));
		} finally {
			clearTimeout(guard);
		}
	});
	// Consume until done/error so pi-ai's IIFE settles cleanly.
	const done = stream.result ? stream.result() : undefined;
	if (done !== undefined) await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
	return stream;
}

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ✓ ${label}`);
};

// ── unit: matchesTarget ─────────────────────────────────────────────────────
{
	const hosts = ["opencode.ai"];
	const baseURLs = ["https://gateway.opencode.example/v1"];
	assert.equal(matchesTarget("https://opencode.ai/zen/go/v1/chat/completions", hosts, baseURLs), true, "bare host");
	assert.equal(matchesTarget("https://sub.opencode.ai/zen/go/v1", hosts, baseURLs), true, "subdomain");
	assert.equal(matchesTarget("https://opencode.ai:8443/zen/go/v1", hosts, baseURLs), true, "port stripped");
	assert.equal(matchesTarget("http://opencode.ai/x", hosts, baseURLs), true, "http scheme");
	assert.equal(matchesTarget("https://opencode.ai.evil.com/x", hosts, baseURLs), false, "suffix confusion");
	assert.equal(matchesTarget("https://api.openai.com/v1/chat/completions", hosts, baseURLs), false, "foreign host");
	assert.equal(matchesTarget("https://gateway.opencode.example/v1/chat/completions", hosts, baseURLs), true, "exact baseURL prefix");
	assert.equal(matchesTarget("not-a-url", hosts, baseURLs), false, "unparseable");
	ok("matchesTarget host/baseURL filtering");
}

// ── unit: withSessionHeaders ────────────────────────────────────────────────
{
	const names = ["x-session-affinity", "x-client-request-id"];
	const merged = withSessionHeaders("https://opencode.ai/v1/chat/completions", {
		method: "POST",
		headers: { authorization: "Bearer abc" },
		body: "{}",
	}, names, "session-unit");
	assert.equal(merged.init.headers.get("x-session-affinity"), "session-unit");
	assert.equal(merged.init.headers.get("x-client-request-id"), "session-unit");
	assert.equal(merged.init.headers.get("authorization"), "Bearer abc");
	assert.equal(merged.init.method, "POST");
	assert.equal(merged.init.body, "{}");
	assert.equal(merged.input, "https://opencode.ai/v1/chat/completions");
	const req = new Request("https://opencode.ai/v1/chat/completions", { method: "POST", body: "{}", headers: { authorization: "Bearer abc" } });
	const rebuilt = withSessionHeaders(req, undefined, names, "session-req");
	assert.ok(rebuilt.input instanceof Request);
	assert.equal(rebuilt.input.headers.get("x-session-affinity"), "session-req");
	assert.equal(rebuilt.input.headers.get("authorization"), "Bearer abc");
	assert.equal(rebuilt.init, undefined);
	ok("withSessionHeaders preserves method/body/auth");
}

// ── integration: the real pi-ai wire request carries the session id ────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity", "x-client-request-id", "x-session-id"],
		getSessionId: () => scope.current(),
	});
	try {
		const controller = new AbortController();
		await opencodeChat(scope, "session-test-abc", controller.signal);
		controller.abort();
		const hit = records.find((r) => String(r.url).includes("opencode.ai"));
		assert.ok(hit, "expected a fetch to opencode.ai, saw: " + records.map((r) => r.url).join(", "));
		assert.ok(String(hit.url).includes("/zen/go/v1/chat/completions"), "chat completions URL: " + hit.url);
		const headers = new Headers(hit.init.headers);
		assert.equal(headers.get("x-session-affinity"), "session-test-abc");
		assert.equal(headers.get("x-client-request-id"), "session-test-abc");
		assert.equal(headers.get("x-session-id"), "session-test-abc");
		assert.ok(headers.get("authorization"), "auth header preserved");
		ok(`pi-ai wire request to ${hit.url} carries all session headers`);
	} finally {
		restore(); // restore globalThis.fetch
	}
}

// ── integration: concurrent sessions stay isolated per request ─────────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity", "x-client-request-id"],
		getSessionId: () => scope.current(),
	});
	try {
		const a = new AbortController();
		const b = new AbortController();
		await Promise.all([
			opencodeChat(scope, "session-conv-a", a.signal),
			opencodeChat(scope, "session-conv-b", b.signal),
		]);
		a.abort();
		b.abort();
		const hits = records.filter((r) => String(r.url).includes("opencode.ai"));
		const seen = new Set(hits.map((r) => new Headers(r.init.headers).get("x-session-affinity")));
		assert.deepEqual([...seen].sort(), ["session-conv-a", "session-conv-b"], "each request saw exactly its own session id");
		ok("concurrent conversations get their own session id (AsyncLocalStorage isolation)");
	} finally {
		restore();
	}
}

// ── negative: foreign providers are untouched ───────────────────────────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity"],
		getSessionId: () => scope.current() ?? "fallback-id",
	});
	try {
		await scope.run("session-neg", async () => {
			await globalThis.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
		});
		const hit = records.find((r) => String(r.url).includes("api.openai.com"));
		const headers = new Headers(hit.init.headers);
		assert.equal(headers.get("x-session-affinity"), null, "foreign host must not receive the header");
		assert.equal(headers.get("authorization"), "Bearer x");
		ok("non-opencode endpoints pass through untouched");
	} finally {
		restore();
	}
}

// ── config normalization ────────────────────────────────────────────────────
{
	const cfg = normalize({});
	assert.deepEqual(cfg.providers, ["opencode", "opencode-go"]);
	assert.ok(cfg.headers.includes("x-session-affinity"));
	const tight = normalize({ providers: ["opencode-go"], hosts: ["opencode.ai", ".OC.ai"], headers: ["X-Session-Affinity", "bad header!"], baseURLs: ["https://gw/v1"], sessionIdEnv: "MY_SID", verbose: true });
	assert.deepEqual(tight.providers, ["opencode-go"]);
	assert.deepEqual(tight.hosts, ["opencode.ai", ".OC.ai"]);
	assert.deepEqual(tight.headers, ["X-Session-Affinity"], "invalid header names dropped, case kept");
	assert.deepEqual(tight.baseURLs, ["https://gw/v1"]);
	assert.equal(tight.sessionIdEnv, "MY_SID");
	ok("normalize applies defaults and sanitizes input");
}

console.log(`\nverify.mjs: ${passed} checks passed for dsh-opencode-session-id`);
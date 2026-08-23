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

import { DEFAULT_HEADERS, NANOID_ALPHABET, NANOID_ALPHABET_URLSAFE, createSessionScope, installSessionHeaderFetch, matchesTarget, nanoidOf, normalize, stripSessionPrefix, withSessionHeaders } from "../lib/index.js";

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

// ── unit: withSessionHeaders merges extras and user-agent, headers only ────
{
	const names = ["x-opencode-session"];
	const merged = withSessionHeaders("https://opencode.ai/v1/chat/completions", {
		method: "POST",
		headers: { authorization: "Bearer abc" },
		body: "{}",
	}, names, "session-unit", { "x-opencode-client": "native" }, "opencode/test");
	assert.equal(merged.init.headers.get("x-opencode-session"), "session-unit");
	assert.equal(merged.init.headers.get("x-opencode-client"), "native");
	assert.equal(merged.init.headers.get("user-agent"), "opencode/test");
	assert.equal(merged.init.headers.get("authorization"), "Bearer abc");
	assert.equal(merged.init.method, "POST");
	assert.equal(merged.init.body, "{}");
	assert.equal(merged.input, "https://opencode.ai/v1/chat/completions");
	const req = new Request("https://opencode.ai/v1/chat/completions", { method: "POST", body: "{}", headers: { authorization: "Bearer abc" } });
	const rebuilt = withSessionHeaders(req, undefined, names, "session-req");
	assert.ok(rebuilt.input instanceof Request);
	assert.equal(rebuilt.input.headers.get("x-opencode-session"), "session-req");
	assert.equal(rebuilt.input.headers.get("authorization"), "Bearer abc");
	assert.equal(rebuilt.init, undefined);
	ok("withSessionHeaders preserves method/body/auth; adds session + extras + UA");
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

// ── headers-only guarantee: a matched request differs from the untouched
// ── control ONLY by the session headers (same url/method/body bytes) ───────
{
	// Control runner: pi-ai without our wrapper.
	const control = [];
	globalThis.fetch = recordingFetch(control);
	const controller = new AbortController();
	await opencodeChat(createSessionScope(), "session-ignored", controller.signal);
	controller.abort();
	// Wrapped runner: pi-ai through installSessionHeaderFetch with the shipped
	// default header set (which leads with opencode's own x-opencode-session).
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: DEFAULT_HEADERS,
		getSessionId: () => scope.current(),
	});
	try {
		const wrappedController = new AbortController();
		await opencodeChat(scope, "session-delta", wrappedController.signal);
		wrappedController.abort();
	} finally {
		restore();
	}
	const base = control.find((r) => String(r.url).includes("opencode.ai"));
	const changed = records.find((r) => String(r.url).includes("opencode.ai"));
	assert.ok(base && changed, "both control and wrapped requests observed");
	// URL, method, and body bytes are identical.
	assert.equal(changed.url, base.url, "URL unchanged");
	assert.equal(changed.init.method, base.init.method, "method unchanged");
	assert.equal(String(changed.init.body), String(base.init.body), "request body bytes unchanged");
	// Header delta is exactly the injected session headers.
	const baseHeaders = new Headers(base.init.headers);
	const changedHeaders = new Headers(changed.init.headers);
	const injected = new Set(DEFAULT_HEADERS);
	const baseNames = new Set([...baseHeaders.keys()]);
	const changedNames = new Set([...changedHeaders.keys()]);
	for (const name of baseNames) {
		assert.equal(changedHeaders.get(name), baseHeaders.get(name), `unrelated header ${name} unchanged`);
	}
	for (const name of changedNames) {
		assert.ok(baseNames.has(name) || injected.has(name), `only session headers added (saw ${name})`);
	}
	assert.equal(changedHeaders.get("x-opencode-session"), "session-delta");
	assert.equal(changedHeaders.get("x-session-affinity"), "session-delta");
	assert.ok(changed.init.signal instanceof AbortSignal, "signal untouched (still the SDK's controller)");
	assert.ok(injected.has("x-opencode-session"), "default set leads with x-opencode-session (opencode gateway convention)");
	ok("headers-only guarantee: same url/method/body; delta is exactly the session headers");
}

// ── unit: Request input survives with identical body, only headers replaced ─
{
	const body = JSON.stringify({ role: "user", content: "x" });
	const req = new Request("https://opencode.ai/v1/chat/completions", {
		method: "POST",
		body,
		headers: { authorization: "Bearer abc", "content-type": "application/json" },
	});
	const rebuilt = withSessionHeaders(req, undefined, ["x-session-affinity"], "session-req2");
	assert.ok(rebuilt.input instanceof Request);
	assert.equal(rebuilt.input.method, "POST");
	assert.equal(rebuilt.input.headers.get("x-session-affinity"), "session-req2");
	assert.equal(rebuilt.input.headers.get("authorization"), "Bearer abc");
	assert.equal(await rebuilt.input.text(), body, "body bytes identical through Request rebuild");
	ok("Request input: body/method preserved, headers only replaced");
}

// ── unit: nanoidOf hashes session ids deterministically into nanoid(8) ─────
{
	assert.equal(NANOID_ALPHABET.length, 62, "default alphabet is 62 alphanumeric chars (no symbols)");
	assert.equal(NANOID_ALPHABET_URLSAFE.length, 64, "urlsafe alphabet is 2^6 chars with _ and -");
	assert.ok(!NANOID_ALPHABET.includes("_") && !NANOID_ALPHABET.includes("-"), "default alphabet has no _ or -");
	const token = nanoidOf("e820d21d-3ea3-42b1-9f64-a309f722a3bc");
	assert.equal(token.length, 8, "default length is 8, like the opencode web token");
	for (const ch of token) assert.ok(NANOID_ALPHABET.includes(ch), `char ${ch} in nanoid alphabet`);
	assert.match(token, /^[A-Za-z0-9]{8}$/, "default token is pure alphanumeric (no _ or -)");
	assert.equal(nanoidOf("e820d21d-3ea3-42b1-9f64-a309f722a3bc"), token, "deterministic: same uuid → same token");
	assert.equal(nanoidOf("e820d21d-3ea3-42b1-9f64-a309f722a3bc", 8), token, "explicit length 8 matches default");
	assert.notEqual(nanoidOf("11111111-1111-4111-8111-111111111111"), token, "different uuids hash differently");
	assert.equal(nanoidOf("e820d21d-3ea3-42b1-9f64-a309f722a3bc", 6).length, 6, "custom length respected");
	const safe = nanoidOf("anything", 8, NANOID_ALPHABET_URLSAFE);
	assert.equal(safe.length, 8, "urlsafe alphabet also yields 8 chars");
	assert.match(safe, /^[A-Za-z0-9_-]+$/, "urlsafe option may use _ / -");
	ok("nanoidOf: sha-256 → stable 8-char opencode-format token (symbol-free by default)");
}

// ── unit: stripSessionPrefix removes only the session- label ────────────────
{
	assert.equal(stripSessionPrefix("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "e820d21d-3ea3-42b1-9f64-a309f722a3bc", "session- prefix stripped");
	assert.equal(stripSessionPrefix("e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "e820d21d-3ea3-42b1-9f64-a309f722a3bc", "no prefix → unchanged");
	assert.equal(stripSessionPrefix("session-"), "", "bare session- → empty");
	assert.equal(nanoidOf(stripSessionPrefix("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc")), nanoidOf("e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "wire token hashes the uuid only, session- not included");
	assert.notEqual(nanoidOf(stripSessionPrefix("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc")), nanoidOf("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "hashing the label would give a different token");
	ok("stripSessionPrefix: wire hash excludes the session- label");
}

// ── integration: nanoid(8) token lands on the wire header (hash mode) ───────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-opencode-session"],
		// Same as wireSessionId in apply(): strip the prefix, then hash.
		getSessionId: () => nanoidOf(stripSessionPrefix("session-test-xyz")),
	});
	try {
		await scope.run("session-test-xyz", async () => {
			await globalThis.fetch("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", body: "{}" });
		});
		const hit = records.find((r) => String(r.url).includes("opencode.ai"));
		const headers = new Headers(hit.init.headers);
		assert.equal(headers.get("x-opencode-session"), nanoidOf("test-xyz"));
		assert.equal(String(headers.get("x-opencode-session")).length, 8);
		ok("wire carries the hashed nanoid(8) token in x-opencode-session (uuid only)");
	} finally {
		restore();
	}
}

// ── config normalization ────────────────────────────────────────────────────
{
	const cfg = normalize({});
	assert.deepEqual(cfg.providers, ["opencode", "opencode-go"]);
	assert.equal(cfg.headers[0], "x-opencode-session", "default leads with opencode's own session header");
	assert.ok(cfg.headers.includes("x-session-affinity"));
	const tight = normalize({ providers: ["opencode-go"], hosts: ["opencode.ai", ".OC.ai"], headers: ["X-Session-Affinity", "bad header!"], baseURLs: ["https://gw/v1"], sessionIdEnv: "MY_SID", verbose: true, extraHeaders: { "x-opencode-client": "native", "bad name!": "x" }, userAgent: "opencode/1.18.21" });
	assert.deepEqual(tight.providers, ["opencode-go"]);
	assert.deepEqual(tight.hosts, ["opencode.ai", ".OC.ai"]);
	assert.deepEqual(tight.headers, ["X-Session-Affinity"], "invalid header names dropped, case kept");
	assert.deepEqual(tight.baseURLs, ["https://gw/v1"]);
	assert.equal(tight.sessionIdEnv, "MY_SID");
	assert.deepEqual(tight.extraHeaders, { "x-opencode-client": "native" }, "invalid extra header names dropped");
	assert.equal(tight.userAgent, "opencode/1.18.21");
	assert.equal(cfg.nanoidSessionId, true, "nanoid hashing on by default");
	assert.equal(cfg.nanoidLength, 8, "default token length 8");
	assert.equal(cfg.nanoidAlphabet, "alphanumeric", "default alphabet is symbol-free");
	assert.equal(normalize({ nanoidAlphabet: "urlsafe" }).nanoidAlphabet, "urlsafe", "urlsafe alphabet selectable");
	assert.equal(normalize({ nanoidAlphabet: "bogus" }).nanoidAlphabet, "alphanumeric", "unknown alphabet falls back");
	assert.equal(normalize({ nanoidSessionId: false }).nanoidSessionId, false, "opt-out keeps raw session id");
	assert.equal(normalize({ nanoidLength: 21 }).nanoidLength, 21, "custom token length respected");
	assert.equal(normalize({ nanoidLength: 0 }).nanoidLength, 8, "out-of-range length falls back to 8");
	ok("normalize applies defaults and sanitizes input");
}

console.log(`\nverify.mjs: ${passed} checks passed for dsh-opencode-session-id`);
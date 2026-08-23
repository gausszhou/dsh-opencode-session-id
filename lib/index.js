import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

//#region lib/types/brand.js
/**
 * Brand a session identifier for the wire. Values are opaque strings; no
 * validation is performed here.
 * @param id - the raw session id string.
 * @returns the same string, branded as a SessionId.
 */
function SessionId(id) {
	return id;
}
//#endregion

//#region lib/types/index.js
/**
 * dsh-opencode-session-id — make the LLM HTTP requests dsh sends to opencode
 * providers carry the dsh conversation session id, the same way opencode
 * itself does.
 *
 * How opencode carries it (for comparison): opencode threads its current
 * session id through the provider call options (`sessionId`); its OpenAI
 * compatible client then emits `x-session-affinity: <sessionId>` and
 * `x-client-request-id: <sessionId>` on every wire request (plus
 * `session_id:` for the "openai" affinity format, or `x-session-id:` for the
 * OpenRouter format). The emission is gated by the model's
 * `compat.sendSessionAffinityHeaders` flag.
 *
 * The dsh side already provides the id — `dsh-agent-loop` fills
 * `options.sessionId` and the `llm-pi-ai` adapter forwards it to pi-ai — but
 * two design walls keep it off the wire: the adapter deliberately withholds
 * `sendSessionAffinityHeaders` / `sessionAffinityFormat` from its provider
 * compat gate, and it drops per-request `options.headers` (it only sends the
 * static `headers` of the provider profile plus attribution headers). This
 * plugin closes the gap at the layer that cannot be bypassed:
 *
 *  1. It listens on the `llm/stream` waterfall (the harness's official LLM
 *     request interception seam) and scopes each call to its session id via
 *     AsyncLocalStorage, so the id is correct per request even when several
 *     conversations stream concurrently. For the configured opencode
 *     provider routes it also seeds `options.sessionId` when a caller did
 *     not, feeding pi-ai's own affinity path.
 *  2. It wraps `globalThis.fetch` (the undici fetch both the `openai` and
 *     `@anthropic-ai/sdk` clients resolve to on Node ≥ 18) and adds the
 *     session-id headers to every request whose URL targets an opencode
 *     endpoint (host suffix or exact base URL, configurable). Only headers
 *     are added; the request itself is passed through untouched.
 *
 * @module @gausszhou/dsh-opencode-session-id
 */
const name = "opencode-session-id";
const inject = [];
/** Default session-affinity header names opencode itself emits. */
const DEFAULT_HEADERS = ["x-session-affinity", "x-client-request-id", "x-session-id"];
/** HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Tolerate every shape a patch layer may deliver; defaults apply per key. */
function normalize(config) {
	const c = config ?? {};
	const stringList = (value, fallback) => Array.isArray(value) && value.length > 0 ? value.filter((v) => typeof v === "string" && v.length > 0) : fallback;
	let headers = stringList(c.headers, DEFAULT_HEADERS);
	if (headers.length === 0) headers = DEFAULT_HEADERS;
	return {
		providers: stringList(c.providers, ["opencode", "opencode-go"]),
		hosts: stringList(c.hosts, ["opencode.ai"]),
		baseURLs: stringList(c.baseURLs, []),
		headers: [...new Set(headers)].filter((h) => HEADER_NAME_TOKEN.test(h)),
		sessionIdEnv: typeof c.sessionIdEnv === "string" ? c.sessionIdEnv.trim() : "",
		verbose: c.verbose === true,
		disableFetchInjection: c.disableFetchInjection === true
	};
}
/**
 * Per-request session scoping over AsyncLocalStorage. Every step of the
 * downstream LLM stream runs inside `run()`, so a fetch issued deep inside
 * the adapter — pi-ai fires its HTTP client synchronously from the stream's
 * first pull — observes the exact conversation session id even when several
 * conversations stream concurrently.
 */
function createSessionScope() {
	const store = new AsyncLocalStorage();
	return {
		/** The session id active for the current async context, if any. */
		current() {
			return store.getStore();
		},
		run(sessionId, fn) {
			return store.run(String(sessionId), fn);
		}
	};
}
/**
 * Wrap a downstream LLM chunk stream so each pull runs inside the scope,
 * keeping the session id visible to everything the adapter does on that pull.
 * @param scope - the session scope.
 * @param sessionId - the id to bind.
 * @param iterable - the downstream chunk stream (`next()` result).
 * @returns an AsyncIterable with the same chunk semantics.
 */
function scopedIterable(scope, sessionId, iterable) {
	const iterator = iterable[Symbol.asyncIterator]();
	const inside = (method, args) => scope.run(sessionId, () => {
		const fn = iterator[method];
		return typeof fn === "function" ? fn.apply(iterator, args) : undefined;
	});
	const fallbackDone = Promise.resolve({ done: true, value: undefined });
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			return inside("next", []) ?? fallbackDone;
		},
		return(...args) {
			return inside("return", args) ?? fallbackDone;
		},
		throw(...args) {
			return inside("throw", args) ?? fallbackDone;
		}
	};
}
/** Lowercase hostname of a URL, or "" when unreadable. */
function hostnameOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}
/** Does this request URL target a configured opencode endpoint? */
function matchesTarget(url, hosts, baseURLs) {
	if (baseURLs.some((base) => url.startsWith(base))) return true;
	const host = hostnameOf(url);
	if (!host) return false;
	return hosts.some((entry) => {
		const suffix = entry.trim().toLowerCase().replace(/^\./, "");
		if (!suffix || suffix.includes("/")) return false;
		return host === suffix || host.endsWith(`.${suffix}`);
	});
}
/**
 * Rebuild a fetch call with the session headers added, preserving every
 * other aspect (method, body, signal, duplex, credentials). Returns `null`
 * when the request cannot be rebuilt (e.g. a body-already-used Request),
 * in which case the caller passes the call through untouched.
 */
function withSessionHeaders(input, init, headerNames, sessionId) {
	const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
	const headers = new Headers(source ?? undefined);
	for (const headerName of headerNames) headers.set(headerName, String(sessionId));
	if (typeof init === "object" && init !== null) return { input, init: { ...init, headers } };
	if (typeof Request !== "undefined" && input instanceof Request) {
		try {
			return { input: new Request(input, { headers }), init: undefined };
		} catch {
			return null;
		}
	}
	return { input, init: { headers } };
}
/**
 * Wrap `globalThis.fetch` so requests to opencode endpoints carry the
 * session-id headers. One wrapper per mount; disposal restores the previous
 * fetch unless another wrapper already took its place.
 * @returns the disposer.
 */
function installSessionHeaderFetch({ hosts, baseURLs, headerNames, getSessionId, log }) {
	const original = globalThis.fetch;
	if (typeof original !== "function") return () => {};
	const wrapped = (input, init) => {
		let nextInput = input;
		let nextInit = init;
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input === "object" && input !== null && typeof input.url === "string" ? input.url : "";
			if (url.length > 0 && matchesTarget(url, hosts, baseURLs)) {
				const sessionId = getSessionId();
				if (sessionId !== undefined && sessionId !== null && String(sessionId).length > 0 && headerNames.length > 0) {
					const merged = withSessionHeaders(input, init, headerNames, sessionId);
					if (merged !== null) {
						nextInput = merged.input;
						nextInit = merged.init;
						log?.(`${url} ← ${headerNames.map((h) => `${h}: ${sessionId}`).join(", ")}`);
					}
				}
			}
		} catch (error) {
			log?.(`skipped header injection: ${error?.message ?? error}`);
		}
		return original.call(globalThis, nextInput, nextInit);
	};
	globalThis.fetch = wrapped;
	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}
/** Install the plugin on a cordis context. */
function apply(ctx, config = {}) {
	const cfg = normalize(config);
	const scope = createSessionScope();
	const providers = new Set(cfg.providers);
	let processId;
	const envFallback = () => {
		if (cfg.sessionIdEnv.length > 0 && typeof process.env[cfg.sessionIdEnv] === "string") {
			const hit = process.env[cfg.sessionIdEnv];
			if (hit.length > 0) return hit;
		}
		if (typeof process.env.DSH_SESSION_ID === "string" && process.env.DSH_SESSION_ID.length > 0) return process.env.DSH_SESSION_ID;
		return processId ??= randomUUID();
	};
	const log = (message) => {
		if (cfg.verbose) ctx.logger.debug(`opencode-session-id: ${message}`);
	};
	// 1. Scope every LLM stream to its conversation session id; seed
	//    `options.sessionId` for configured opencode routes whose caller
	//    omitted it. Registered after session-title's prepend listener and
	//    alongside checkpoint-policy, order-independent like both.
	ctx.on("llm/stream", (options, next) => {
		let sessionId = options.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			if (typeof options.provider === "string" && providers.has(options.provider)) {
				sessionId = envFallback();
				if (!Object.isFrozen(options)) {
					try {
						options.sessionId = sessionId;
					} catch {
						/* frozen request object; the fetch injection still applies */
					}
				}
			}
		}
		if (sessionId === undefined || sessionId === null) return next();
		const sid = String(sessionId);
		log(`scoping llm/stream ${options.provider}/${options.model} to session ${sid}`);
		return scopedIterable(scope, sid, next());
	});
	// 2. Wire-level injection: the llm-pi-ai adapter only forwards static
	//    profile headers and keeps the session-affinity compat gate closed, so
	//    the headers land here, on the actual HTTP request.
	if (!cfg.disableFetchInjection) {
		const restoreFetch = installSessionHeaderFetch({
			hosts: cfg.hosts,
			baseURLs: cfg.baseURLs,
			headerNames: cfg.headers,
			getSessionId: () => scope.current() ?? envFallback(),
			log
		});
		ctx.effect(() => restoreFetch, "opencode-session-id: restore global fetch");
	}
	ctx.logger.info(
		`opencode-session-id: tagging providers [${cfg.providers.join(", ")}]; injecting [${cfg.headers.join(", ")}] on hosts [${cfg.hosts.join(", ")}]${cfg.baseURLs.length > 0 ? ` and baseURLs [${cfg.baseURLs.join(", ")}]` : ""}`
	);
}
//#endregion

export { DEFAULT_HEADERS, SessionId, apply, createSessionScope, inject, installSessionHeaderFetch, matchesTarget, name, normalize, scopedIterable, withSessionHeaders };
export default { name, inject, apply };
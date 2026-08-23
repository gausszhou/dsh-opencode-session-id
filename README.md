# dsh-opencode-session-id

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (dsh) plugin: when you use an **opencode model** (providers such as `opencode` / `opencode-go` that point at the opencode.ai gateway), it makes the **actual outgoing HTTP requests carry a session id** — the same way the opencode client itself does.

> **English** | [简体中文](./README.zh-CN.md)

## Usage

Add the plugin to a dsh profile (install by package name once published to npm):

```bash
dsh plugin --profile web add "@gausszhou/dsh-opencode-session-id"
```

After installing, **restart dsh web** (`systemctl --user restart dsh-web`) so the bundle takes effect. The default configuration works out of the box: requests to `opencode.ai` automatically get **`x-opencode-session`** (the session header used by the opencode gateway) plus `x-session-affinity` / `x-client-request-id` / `x-session-id`. **The header value defaults to a pure-alphanumeric nanoid(8) derived from the uuid portion of the session id** (e.g. `0RpJJnxJ` — the `session-` prefix does not participate in the hash; the token is deterministically derived from the uuid via SHA-256). With `verbose: true`, the journal logs the mapping between the original id and the wire token:

```bash
journalctl --user -u dsh-web -f | grep opencode-session-id
```

## How it works

The opencode gateway branch uses `x-opencode-session` to carry the session id; this plugin listens on the `llm/stream` scope, wraps `fetch`, and adds that header at the wire layer. By default it hashes the uuid portion of `session-<uuid>` (the `session-` prefix is excluded) into an alphanumeric nanoid(8) before it goes on the wire. **Only request headers are touched** — the request body, URL, method, and everything else pass through unchanged. See [docs/design.md](docs/design.md) for the full design rationale.

## Configuration

**Zero configuration needed by default** (the install command above is all you need). To enable injection logging through the patch layer:

```yaml
- id: opencode-session-id
  config:
    verbose: true
```

All options (each optional, defaults shown):

| Key | Default | Description |
|---|---|---|
| `providers` | `[opencode, opencode-go]` | llm-pi-ai route names whose sessionId should be tagged |
| `hosts` | `[opencode.ai]` | URL host suffixes (including subdomains) that get session headers |
| `baseURLs` | `[]` | Additional exact URL prefixes to match (custom gateways) |
| `headers` | `[x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]` | Request header names to inject |
| `extraHeaders` | `{}` | Optional static extra headers (e.g. opencode fingerprint family `x-opencode-client: native` / `x-opencode-request: dsh`) |
| `userAgent` | empty | Override `User-Agent` (opencode itself sends `opencode/<version>`; untouched by default) |
| `sessionIdEnv` | empty | Environment variable name to fall back on for the session id |
| `verbose` | `false` | Log every injection (including the original id → wire token mapping) |
| `seedSessionId` | `false` | Seed `options.sessionId` for opencode routes |
| `nanoidSessionId` | `true` | Hash `session-<uuid>` to a nanoid(8) before sending; `false` sends the raw id |
| `nanoidLength` | `8` | Token length (4–32) |
| `nanoidAlphabet` | `alphanumeric` | `alphanumeric` (pure `A-Za-z0-9`, no `_`/`-`) or `urlsafe` (classic 64-character set) |
| `disableFetchInjection` | `false` | When `true`, keep only the waterfall session scoping |

## Verification

```bash
node test/verify.mjs   # 10 checks: unit tests + real pi-ai wire request + concurrent isolation + headers-only guarantee
node test/smoke-apply.mjs  # apply() wiring: listener registration, scoped fetch, mount/dispose lifecycle
```

`verify.mjs` fires a real `opencode-go` request through the pi-ai bundled with the dsh CLI, asserting that the wire request headers really carry the session id; it also verifies concurrent-session isolation and that non-opencode endpoints are unaffected.

## Notes & limitations

- The session id comes from `options.sessionId` (agent-loop fills it in per session); without a session context, the fallback chain is `sessionIdEnv` > `DSH_SESSION_ID` (the process's startup session in web deployments) > an in-process random id.
- Covers protocols that go through `fetch`, such as `openai-completions` / `openai-responses` / `anthropic-messages`; `transport: websocket` does not use fetch and is out of scope.
- The global fetch wrapper only appends request headers when an opencode endpoint is matched — nothing else is changed. The wire token is a one-way SHA-256 hash of the uuid portion of `session-<uuid>` (the `session-` prefix excluded, e.g. `0RpJJnxJ`), so the backend cannot reverse it to the original id; changing `nanoidAlphabet` / `nanoidLength` changes every token, breaking association with old records.
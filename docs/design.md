# 设计说明（dsh-opencode-session-id）

本文档记录插件的实现原理与设计取舍，供维护者参考；使用说明见 [README](../README.md)。

## 1. opencode 是怎么携带 session id 的（取自 opencode 1.18.21 源码）

opencode 构建 LLM 请求头时按 provider 分成两个分支（`providerID` 以 `opencode` 开头 → 网关分支）：

```js
headers: {
  ...(model.providerID.startsWith("opencode")
    ? {
        ...(projectId ? { "x-opencode-project": projectId } : {}),
        "x-opencode-session": sessionID,     // ← 网关分支：会话 ID 在这个头里
        "x-opencode-request": user.id,
        "x-opencode-client": flags.client,
        "User-Agent": `opencode/${version}`, // ← 指纹 UA
      }
    : {
        "x-session-affinity": sessionID,     // ← 非 opencode provider 才是这套
        "X-Session-Id": sessionID,
        ...(parentSessionID ? { "x-parent-session-id": parentSessionID } : {}),
        "User-Agent": `opencode/${version}`,
      }),
  ...model.headers,
}
```

结论：

- 对 opencode 网关，会话 ID 走 **`x-opencode-session`**（外加 `x-opencode-client` / `x-opencode-request` / `x-opencode-project` 和 `User-Agent: opencode/<版本>` 指纹头）。
- `x-session-affinity` / `X-Session-Id` 是 opencode 对普通 OpenAI 兼容端点才用的。
- opencode 原生会话 id 是 nanoid 风格（如 `QBgzdhtO`），非 `session-<uuid>` 格式。

另外，pi-ai 库（`@earendil-works/pi-ai`，opencode 自己的 AI 库）内部还有一套 `sendSessionAffinityHeaders` 门控的 affinity 头发射逻辑——默认关，且 dsh 的 `llm-pi-ai` adapter 配置门控刻意 withheld 了该开关，这正是"dsh 已有 `options.sessionId` 却发不出任何会话头"的根因。

## 2. dsh 侧的现状

`dsh-agent-loop` 把会话 id 放进 `options.sessionId`，`llm-pi-ai` 也会转发给 pi-ai；但 adapter 丢弃逐请求的 `options.headers`（只用 provider 静态 `headers` + attribution 头），且 compat 门控关着——所以实际请求头里什么都没有。本插件在**不可能被绕过的层**（实际 fetch）补上这一环。

## 3. 工作原理

1. **`llm/stream` waterfall 监听**（dsh 官方 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage` 绑定到它的会话 id——多个会话并发流式时每个请求也能拿到**自己的** session id。
2. **包装 `globalThis.fetch`**：Node ≥ 18 下 `openai` SDK 和 `@anthropic-ai/sdk` 解析到的都是 undici 全局 fetch（SDK 在每次请求构造客户端时才解析 `fetch`，包装必然生效）。包装器只对命中 opencode 端点（host 后缀，或精确 baseURL 前缀，均可配置）的请求**追加会话请求头**，其余请求以完全相同的参数原样透传。

**范围保证——只改请求头。** 包装器不读、不改、不替换请求体（字节与流原样透传），不改 URL/method/signal/duplex/凭证等任何 fetch 选项，也不碰响应。`llm/stream` 监听器默认不改调用选项；仅 `seedSessionId: true` 时会给缺失 `options.sessionId` 的 opencode 路由补种（唯一 wire 效果仍是会话请求头）。

## 4. wire token：为什么是 nanoid(8) 哈希

为了让网关看到 opencode 同款格式，插件默认用 **SHA-256 把 `session-<uuid>` 确定性映射成 8 字符 nanoid**：

- 同一个会话 → 恒定 token，跨请求、跨重启不变，后台可稳定归因。
- token 默认只用**纯字母数字**（`A-Za-z0-9`，62 字符）。62 不是 2 的幂，直接取模会有偏差，故用**拒绝采样**（6 位值 ≥62 跳过再取下一个）保持均匀；SHA-256 块耗尽时以计数器续哈希。
- 可用 `nanoidAlphabet: "urlsafe"` 回退到经典 64 字符表（含 `_`/`-`）。
- 该哈希是**单向**的：后台只能看到 token，无法反推原始 `session-<uuid>`；dsh 侧靠 verbose 日志里的 `→ wire` 映射回溯会话。
- **换 `nanoidAlphabet` / `nanoidLength` 配置后 token 会整体变化**，旧的后台记录不再关联。

## 5. 限制

- session id 取 `options.sessionId`（agent-loop 已按会话填好）；无会话上下文时兜底 `sessionIdEnv` > `DSH_SESSION_ID`（web 部署下是该进程的启动会话）> 进程内随机 id。
- 覆盖 `openai-completions` / `openai-responses` / `anthropic-messages` 等走 fetch 的协议；`transport: websocket` 不走 fetch，不在覆盖范围。
- 全局 fetch 包装只在命中 opencode 端点时追加请求头，不做任何其它改动。
# dsh-opencode-session-id

DeepSeek Harness (dsh) 插件：当你使用 **opencode 模型**（`opencode` / `opencode-go` 等指向 opencode.ai 网关的 provider）时，让**实际发出的 HTTP 请求携带 session id**——与 opencode 客户端自身的携带方式一致。

## opencode 是怎么携带 session id 的（结论，取自 opencode 1.18.21 源码）

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

**结论**：对 opencode 网关，会话 ID 走 **`x-opencode-session`**（外加 `x-opencode-client` / `x-opencode-request` / `x-opencode-project` 和 `User-Agent: opencode/<版本>` 指纹头）；`x-session-affinity` / `X-Session-Id` 是 opencode 对普通 OpenAI 兼容端点才用的。opencode 原生会话 id 是 nanoid 风格（如 `QBgzdhtO`）。

**我们发什么**：dsh 侧会话 id 是 `session-<uuid>`。为了让网关看到 opencode 同款格式，插件默认用 **SHA-256 把 `session-<uuid>` 确定性映射成 8 字符 nanoid**（同一个会话 → 恒定 token，跨请求、跨重启不变，后台可稳定归因）。例：`session-e820d21d-…-a309f722a3bc → EBVDZEzE`。token **默认只用纯字母数字**（`A-Za-z0-9`，拒绝采样保证均匀，避开 `_`/`-`，防止后台正则只认字母数字时漏掉）；如需经典 nanoid 64 字符表（含 `_`/`-`）可配 `nanoidAlphabet: urlsafe`。设 `nanoidSessionId: false` 改发原始 `session-<uuid>`。

（另外，pi-ai 库内部还有一套 `sendSessionAffinityHeaders` 门控的 affinity 头发射逻辑——默认关，且 dsh 的 `llm-pi-ai` 配置门控刻意 withheld 了该开关，这正是为什么 dsh 已有 `options.sessionId` 却发不出任何会话头。）

**dsh 侧的现状**：`dsh-agent-loop` 把会话 id 放进 `options.sessionId`，`llm-pi-ai` 也会转发给 pi-ai；但 adapter 丢弃逐请求的 `options.headers`（只用 provider 静态 `headers` + attribution 头），且 compat 门控关着——所以实际请求头里什么都没有。本插件在**不可能被绕过的层**（实际 fetch）补上这一环。

## 工作原理

1. **`llm/stream` waterfall 监听**（dsh 官方 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage` 绑定到它的会话 id——多个会话并发流式时每个请求也能拿到**自己的** session id。
2. **包装 `globalThis.fetch`**：Node ≥ 18 下 `openai` SDK 和 `@anthropic-ai/sdk` 解析到的都是 undici 全局 fetch（SDK 在每次请求构造客户端时才解析 `fetch`，包装必然生效）。包装器只对命中 opencode 端点（host 后缀，或精确 baseURL 前缀，均可配置）的请求**追加会话请求头**，其余请求以完全相同的参数原样透传。

**范围保证——只改请求头。** 包装器不读、不改、不替换请求体（字节与流原样透传），不改 URL/method/signal/duplex/凭证等任何 fetch 选项，也不碰响应。`llm/stream` 监听器默认不改调用选项。

## 安装

```bash
# 开发期：以 link 方式装进 web profile（本地改动即时生效，重启 dsh web 后加载）
dsh plugin --profile web add "link:/home/gauss/Code/gausszhou/dsh-opencode-sid"

# 或发布后按包名安装
dsh plugin --profile web add "@gausszhou/dsh-opencode-session-id"
```

装完后 **重启 dsh web**（`systemctl --user restart dsh-web`）让 bundle 生效。默认配置即可工作：请求 `opencode.ai` 时自动带上 **`x-opencode-session`**（opencode 网关同款会话头）以及 `x-session-affinity` / `x-client-request-id` / `x-session-id`。**头值默认是会话 id 的纯字母数字 nanoid(8)**（如 `EBVDZEzE`，由 `session-<uuid>` 经 SHA-256 确定性导出）；`verbose: true` 时 journal 里同时打印原始 id 与 wire token 的映射：

```bash
journalctl --user -u dsh-web -f | grep opencode-session-id
```

## 配置

patch 层（profile 的 `cordis.patch.yml` 或 bundle 自带，见 `cordis.patch.yml`）里按需调整：

```yaml
- id: opencode-session-id
  name: '@gausszhou/dsh-opencode-session-id'
  config:
    providers: [opencode, opencode-go]   # 要打标 sessionId 的 llm-pi-ai 路由名
    hosts: [opencode.ai]                  # 注入会话头的 URL host 后缀（含子域）
    baseURLs: []                          # 额外精确匹配的 URL 前缀（自定义网关）
    headers: [x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]
    extraHeaders: {}                      # 可选：静态附加请求头（如 opencode 指纹族）
                                          #   x-opencode-client: native
                                          #   x-opencode-request: dsh
    userAgent: ''                         # 可选：覆写 User-Agent（opencode 自身发
                                          #   `opencode/<版本>`；设为空则不动）
    sessionIdEnv: ''                      # 可选：兜底 session id 的环境变量名
    verbose: false                        # 打印每次注入（含原 id → wire token 映射）
    seedSessionId: false                  # 可选：给 opencode 路由补种 options.sessionId
    nanoidSessionId: true                 # 默认把 session-<uuid> SHA-256 哈希成
                                          #   opencode 风格的 nanoid(8) 再上线；
                                          #   false = 直接发原始 session-<uuid>
    nanoidLength: 8                       # 哈希 token 长度（4–32，默认 8）
    nanoidAlphabet: alphanumeric          # alphanumeric（默认，纯 A-Za-z0-9，
                                          #   无 _ / -）或 urlsafe（经典 64 字符表）
    disableFetchInjection: false          # true 时只保 waterfall 会话作用域
```

## 验证

```bash
node test/verify.mjs
```

用 dsh CLI 内置的真实 pi-ai 发出 opencode-go 请求，断言 wire 请求头里确实带上了 session id；另验证并发会话隔离、非 opencode 端点不受影响。

## 说明与限制

- session id 取 `options.sessionId`（agent-loop 已按会话填好）；无会话上下文时兜底 `sessionIdEnv` > `DSH_SESSION_ID`（web 部署下是该进程的启动会话）> 进程内随机 id。
- 覆盖 `openai-completions` / `openai-responses` / `anthropic-messages` 等走 fetch 的协议；`transport: websocket` 不走 fetch，不在覆盖范围。
- 全局 fetch 包装只在命中 opencode 端点时追加请求头，不做任何其它改动。
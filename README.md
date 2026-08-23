# dsh-opencode-session-id

DeepSeek Harness (dsh) 插件：当你使用 **opencode 模型**（`opencode` / `opencode-go` 等指向 opencode.ai 网关的 provider）时，让**实际发出的 HTTP 请求携带 session id**——与 opencode 客户端自身的携带方式一致。

## opencode 是怎么携带 session id 的（对比）

opencode 的 AI 请求层就是 [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)，而 dsh 的 `llm-pi-ai` adapter 用的正是同一个库。opencode 的做法：

1. 把当前会话 id 写进 provider 调用选项的 `sessionId` 字段；
2. 底层 OpenAI 兼容客户端在**每个 wire 请求**上额外发送：

| 场景 | 请求头 |
| --- | --- |
| 默认（OpenAI 兼容） | `x-session-affinity` + `x-client-request-id`（值 = session id） |
| `sessionAffinityFormat: openai` | 上面两个，另加 `session_id` |
| OpenRouter 风格 | `x-session-id` |

这套发射逻辑由模型的 `compat.sendSessionAffinityHeaders` 开关门控（默认关）。

**dsh 侧的现状**：`dsh-agent-loop` 已经把会话 id 放进 `options.sessionId`，`llm-pi-ai` 也会把它转发给 pi-ai；但有两道墙让它在实际请求上「出不来」：

- `llm-pi-ai` 的 compat 门控**刻意 withheld** 了 `sendSessionAffinityHeaders` / `sessionAffinityFormat`，配置文件写不进去；
- adapter 丢弃逐请求的 `options.headers`，只发送 provider profile 里的静态 `headers` + attribution 头。

所以即使 dsh 已有 sessionId，请求头里也什么都没有。本插件在**不可能被绕过的层**（实际 fetch）补上这一环。

## 工作原理

1. **`llm/stream` waterfall 监听**（dsh 官方 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage` 绑定到它的会话 id——多个会话并发流式时每个请求也能拿到**自己的** session id；对配置里的 opencode provider，若调用方没带 `options.sessionId` 则补上（同时喂给 pi-ai 原生 affinity 路径）。
2. **包装 `globalThis.fetch`**：Node ≥ 18 下 `openai` SDK 和 `@anthropic-ai/sdk` 都解析到 undici 的全局 fetch。包装器只对命中 opencode 端点（host 后缀，或精确 baseURL 前缀，均可配置）的请求**追加 session-id 请求头**，其余请求原样透传。请求本身（method/body/signal/duplex/凭证）完全不变。

## 安装

```bash
# 开发期：以 link 方式装进 web profile（本地改动即时生效，重启 dsh web 后加载）
dsh plugin --profile web add "link:/home/gauss/Code/gausszhou/dsh-opencode-sid"

# 或发布后按包名安装
dsh plugin --profile web add "@gausszhou/dsh-opencode-session-id"
```

装完后 **重启 dsh web**（`systemctl --user restart dsh-web`）让 bundle 生效。默认配置即可工作：请求 `opencode.ai` 时自动带上 `x-session-affinity` / `x-client-request-id` / `x-session-id`（值 = dsh 会话 id，形如 `session-<uuid>`）。

## 配置

patch 层（profile 的 `cordis.patch.yml` 或 bundle 自带，见 `cordis.patch.yml`）里按需调整：

```yaml
- id: opencode-session-id
  name: '@gausszhou/dsh-opencode-session-id'
  config:
    providers: [opencode, opencode-go]   # 要打标 sessionId 的 llm-pi-ai 路由名
    hosts: [opencode.ai]                  # 注入会话头的 URL host 后缀（含子域）
    baseURLs: []                          # 额外精确匹配的 URL 前缀（自定义网关）
    headers: [x-session-affinity, x-client-request-id, x-session-id]
    sessionIdEnv: ''                      # 可选：兜底 session id 的环境变量名
    verbose: false                        # 打印每次注入
    disableFetchInjection: false          # true 时只保 waterfall 的 sessionId 补种
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
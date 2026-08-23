# dsh-opencode-session-id

> dsh session IDs for opencode, zero config.

[English](./README.md) | **简体中文**

DeepSeek Harness (dsh) 插件：当你使用 **opencode 模型**（`opencode` / `opencode-go` 等指向 opencode.ai 网关的 provider）时，让**实际发出的 HTTP 请求携带 session id**——与 opencode 客户端自身的携带方式一致。

## 使用方法

将插件加进 dsh profile（发布为 npm 包后按包名安装）：

```bash
dsh plugin --profile web add "@gausszhou/dsh-opencode-session-id"
```

装完后 **重启 dsh web**（`systemctl --user restart dsh-web`）让 bundle 生效。默认配置即可工作：请求 `opencode.ai` 时自动带上 **`x-opencode-session`**（opencode 网关同款会话头）以及 `x-session-affinity` / `x-client-request-id` / `x-session-id`。**头值默认是会话 id 里 uuid 部分的纯字母数字 nanoid(8)**（如 `0RpJJnxJ`，`session-` 前缀不参与哈希，由 uuid 经 SHA-256 确定性导出）；`verbose: true` 时 journal 里同时打印原始 id 与 wire token 的映射：

```bash
journalctl --user -u dsh-web -f | grep opencode-session-id
```

## 实现

opencode 网关分支用 `x-opencode-session` 承载会话 id；本插件监听 `llm/stream` 作用域、包装 fetch 在 wire 层补上该头，并默认把 `session-<uuid>` 里 uuid 部分（`session-` 前缀不参与）哈希成纯字母数字 nanoid(8) 上线。**只改请求头**，请求体 / URL / 方法等一律透传。原理细节见 [docs/design.md](docs/design.md)。

## 配置

**默认零配置即可用**（上面的安装方式即可）。想开注入日志，patch 层只需：

```yaml
- id: opencode-session-id
  config:
    verbose: true
```

全部可选项（均可省略，用默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `providers` | `[opencode, opencode-go]` | 要打标 sessionId 的 llm-pi-ai 路由名 |
| `hosts` | `[opencode.ai]` | 注入会话头的 URL host 后缀（含子域） |
| `baseURLs` | `[]` | 额外精确匹配的 URL 前缀（自定义网关） |
| `headers` | `[x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]` | 注入的请求头名 |
| `extraHeaders` | `{}` | 可选静态附加头（如 opencode 指纹族 `x-opencode-client: native` / `x-opencode-request: dsh`） |
| `userAgent` | 空 | 覆写 `User-Agent`（opencode 自身发 `opencode/<版本>`；默认不动） |
| `sessionIdEnv` | 空 | 兜底 session id 的环境变量名 |
| `verbose` | `false` | 打印每次注入（含原 id → wire token 映射） |
| `seedSessionId` | `false` | 给 opencode 路由补种 `options.sessionId` |
| `nanoidSessionId` | `true` | 把 `session-<uuid>` 哈希成 nanoid(8) 再上线；`false` 发原始 id |
| `nanoidLength` | `8` | token 长度（4–32） |
| `nanoidAlphabet` | `alphanumeric` | `alphanumeric`（纯 `A-Za-z0-9`，无 `_`/`-`）或 `urlsafe`（经典 64 字符表） |
| `disableFetchInjection` | `false` | `true` 时只保留 waterfall 会话作用域 |

## 验证

```bash
node test/verify.mjs   # 10 项：单测 + 真实 pi-ai wire 请求 + 并发隔离 + 只改请求头保证
node test/smoke-apply.mjs  # apply() 接线：监听器注册、作用域化 fetch、mount/dispose 生命周期
```

verify.mjs 用 dsh CLI 内置的真实 pi-ai 发出 opencode-go 请求，断言 wire 请求头里确实带上了 session id；另验证并发会话隔离、非 opencode 端点不受影响。

## 说明与限制

- session id 取 `options.sessionId`（agent-loop 已按会话填好）；无会话上下文时兜底 `sessionIdEnv` > `DSH_SESSION_ID`（web 部署下是该进程的启动会话）> 进程内随机 id。
- 覆盖 `openai-completions` / `openai-responses` / `anthropic-messages` 等走 fetch 的协议；`transport: websocket` 不走 fetch，不在覆盖范围。
- 全局 fetch 包装只在命中 opencode 端点时追加请求头，不做任何其它改动。wire token 是 `session-<uuid>` 中 uuid 部分的 SHA-256 单向哈希（不含 `session-` 前缀，如 `0RpJJnxJ`），后台无法反推原 id；换 `nanoidAlphabet` / `nanoidLength` 配置后 token 会整体变化，旧记录不再关联。
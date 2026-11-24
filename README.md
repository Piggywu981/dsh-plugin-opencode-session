# dsh-plugin-opencode-session

[![npm](https://img.shields.io/npm/v/dsh-plugin-opencode-session)](https://www.npmjs.com/package/dsh-plugin-opencode-session)
[![license](https://img.shields.io/npm/l/dsh-plugin-opencode-session)](LICENSE)

给 DeepSeek Harness（DSH）发往 **OpenCode 网关**（opencode.ai）的请求补上 `x-opencode-session` 路由头，修掉这一轮直接失败的报错：

```
本轮运行失败 400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session
and cannot be routed efficiently."}
```

## 症状

在 DSH 里把模型路由到 OpenCode（`opencode-go` / `opencode-free` / 自建 `baseURL: https://opencode.ai/...`）时，第一句话就返回 400，回复内容里带 `MissingSessionID`，会话无法继续。

用 curl 直接打同一个网关可以复现，说明问题不在账号：

```bash
# 不带路由头 -> 400 MissingSessionID
curl -s -o - -w '\nHTTP %{http_code}\n' https://opencode.ai/inference/go/openai/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer sk-test' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
# HTTP 400 {"type":"error","error":{"type":"MissingSessionID", ...}}

# 带上路由头 -> 通过路由检查，进入鉴权（这里故意用假 key）
curl -s -o - -w '\nHTTP %{http_code}\n' https://opencode.ai/inference/go/openai/v1/chat/completions \
  -H 'content-type: application/json' -H 'authorization: Bearer sk-test' \
  -H 'x-opencode-session: probe-session-1234' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
# HTTP 401 {"error":{"type":"authentication_error","message":"Invalid credential"}}
```

## 原因

pi-ai 自带的 OpenCode provider（`opencode`、`opencode-go`）用 `withOpenCodeSessionHeader` 包住四个协议的流实现，从 `options.sessionId` 取会话 id 写进 `x-opencode-session`。这层包装只在**路由保留目录 provider** 时存在：

- 路由显式写了 `api:` 时，DSH 会按协议表（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`）重建 provider，包装被丢掉；
- 请求本身没有 `sessionId` 时（例如模型发现、标题生成等非对话请求），包装同样不写这个头。

`opencode-free: { api: openai-completions, baseURL: https://opencode.ai/inference/go/openai/v1/ }` 这类手写路由正好命中第一条。

## 修复方式

插件挂两个点：

1. **`llm-pi-ai/request-headers` 瀑布事件**：pi-ai 适配器为每次推理请求调用它（profile 头之后、Harness attribution 之前）。插件在这里判断 provider 或 baseURL 是否属于 OpenCode，缺头就补上。值优先用当前 DSH 会话 id（`request.sessionId`），没有就用进程内稳定的 `dsh-<uuid>`，保证网关的会话亲和。
2. **可选的 `fetch` 守卫**：包装宿主进程的全局 `fetch`，只对匹配的网关主机补头，覆盖模型发现、登录等不经过适配器的直连请求；插件卸载时精确还原原函数。

## 安装

```bash
# 方式一：npm
npm i dsh-plugin-opencode-session
# 然后在 DSH 里 Plugins > Add plugin 选择该包，或把它写进 profile 的 package.json

# 方式二：本地目录（源码仓库）
# 在 DSH 里 Plugins > Add plugin 选择本目录（含 package.json 与 cordis.patch.yml）
```

装好后重启会话即可；`cordis.patch.yml` 已把插件行 `opencode-session` 插进 Host 组合，默认配置开箱可用。

## 配置

插件行的 `config`（全部可选，下表是默认值）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `hosts` | `['opencode.ai']` | 需要补头的网关主机；支持 `api.opencode.ai` 这类子域、`host:port`、`*.example.com` |
| `providers` | `['opencode']` | 视为 OpenCode 的 provider 路由键；支持精确匹配、`prefix-*` 后缀匹配和 `prefix*` 通配 |
| `header` | `x-opencode-session` | 头名 |
| `session` | `''` | 固定值；非空时优先于会话 id |
| `sessionPrefix` | `dsh` | 没有会话 id 时回退值的固定前缀 |
| `patchFetch` | `true` | 是否启用 `fetch` 守卫 |
| `debug` | `false` | 通过宿主日志打印每次补头 |

示例：

```yaml
- insert:
    - id: opencode-session
      name: 'dsh-plugin-opencode-session'
      config:
        hosts: ['opencode.ai', 'opencode.internal:8443']
        providers: ['opencode', 'my-zen-*']
        debug: true
```

## 验证

```bash
npm test        # 13 个用例：瀑布事件接线、主机/路由匹配、头值清洗、fetch 守卫生命周期
```

装好后新开一轮对话，原来的 `400 MissingSessionID` 应消失；`debug: true` 时宿主日志会出现 `added x-opencode-session for provider "opencode-go"`。

## 边界

- 只补头，不改请求体、模型、鉴权，也不缓存响应；网关侧额度、限流、鉴权策略不受影响。
- 路由匹配默认按 `opencode` 前缀和 `opencode.ai` 主机；指向别的主机时改 `hosts` / `providers`。
- `session` 配成固定值时，同一插件实例的所有会话会在网关侧共用一个亲和 key，适合单用户调试，不适合多人共用。
- 这是 DSH 侧的工作绕过：上游若把包装逻辑下沉到协议表，插件可以停用，停用后行为回到本文“原因”一节的原始状态。

## 发布

```bash
npm login
npm publish --access public
```

CI 发布：把 `ci/publish.yml` 复制到 `.github/workflows/publish.yml`，在仓库 Secrets 里加 `NPM_TOKEN`，推 `v*` 标签即自动 `npm publish --provenance`。（该文件放在 `ci/` 是因为创建仓库时的 OAuth token 没有 `workflow` scope，拿到 `gh auth refresh -s workflow` 后移回 `.github/workflows/` 即可。）

## 许可

MIT

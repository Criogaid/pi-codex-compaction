# pi-codex-compaction

在 Pi 的原有 compaction 流程中使用 Codex Remote Compaction V2。压缩结果由 Provider 生成并保存在 session 中，恢复 session、fork 或继续压缩时可以复用。

> [!WARNING]
> Remote Compaction V2 仍是实验协议。生成的 checkpoint 只能由相同的 Provider、API、模型和 endpoint 重放。

## 安装

This fork requires Pi 0.99.1 or newer. Run the following command from the cloned repository root to load the maintained package. The npm package under `@oipsanthony` contains the upstream implementation.

```bash
pi install ./packages/pi-codex-compaction
```

## 使用

安装后无需配置。使用 Pi 官方 `openai-codex` 模型时，手动执行 `/compact` 或触发 Pi 自动压缩，扩展会优先尝试 remote compaction。

压缩开始和完成时会显示提示。remote compaction 失败时，扩展会显示 warning，并由 Pi 继续执行原生 compaction。切换到不支持的模型时，Pi 直接使用原生 compaction。

### Runtime parameters

Remote compaction captures the active session ID and current thinking level when it starts. It calls Pi's public `ModelRegistry.streamSimple()` facade so Pi resolves authentication, model and auth headers, provider environment, and the actual `baseUrl` before dispatch. The provider applies the selected model's thinking-level mapping, including `off`.

Cache options use the same provider defaults and resolved `PI_CACHE_RETENTION` environment as normal requests. The extension passes the active session ID for cache keys and routing instead of forcing `cacheRetention: "none"`. Model sampling parameters, resolved authentication, and provider headers remain owned by Pi.

The extension observes Responses events with `onProviderStreamEvent`, which works with Pi's HTTP and WebSocket adapters. It uses the configured transport for standard provider routes. An explicit nonstandard endpoint override uses HTTP because Pi exposes custom HTTP routing through `fetch`.

Tests compare ordinary and compaction requests through the real Pi Responses adapters using simulated HTTP responses. Matching parameters do not guarantee a cache hit or a billing reduction; those depend on the backend and request prefix.

### History retention

[retention.ts](extensions/retention.ts) follows the message path and enabled image-budget default in [Codex rust-v0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/compact_remote_v2.rs). It keeps the newest user message groups within `RETAINED_MESSAGE_TOKEN_BUDGET`. [text-budget.ts](extensions/text-budget.ts) counts each text part using UTF-8 bytes and preserves its beginning and end when truncating. Empty and audio-only messages cost at least one token. Attached image resize notices remain with their source messages.

[image-budget.ts](extensions/image-budget.ts) defines the official ordinary-image estimate and original-image patch rules. It reads original dimensions through Pi's image decoder. Image-containing boundary messages retain later content and keep each image with its adjacent labels. A boundary image that cannot fit prevents backfilling older messages.

The opaque item is appended after retained messages and does not consume their retention budget. Legacy `compaction_summary` items normalize to `compaction` when received or loaded. Pi does not expose Codex harness annotations, client-authored developer provenance, or Codex agent-message and hook-prompt types; those Codex-specific retention branches are outside this adapter's contract.

## 自定义 Provider

自定义模型需要使用 `openai-responses` 或 `openai-codex-responses` API，并在 `~/.pi/agent/models.json` 中声明 capability：

```json
{
  "providers": {
    "custom-codex": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$CUSTOM_CODEX_API_KEY",
      "models": [
        {
          "id": "gpt-example",
          "compat": {
            "remoteCompaction": {
              "protocol": "v2"
            }
          }
        }
      ]
    }
  }
}
```

默认请求地址会根据 API 和 `baseUrl` 推导。只有网关使用非标准路由时才需要指定 `endpoint`：

```json
{
  "remoteCompaction": {
    "protocol": "v2",
    "endpoint": "https://gateway.example.com/responses"
  }
}
```

`endpoint` 必须与 Pi 认证解析后的 `baseUrl` 同源，且不能包含凭据、query 或 fragment。Provider 必须支持 Codex compaction payload、`remote_compaction_v2` beta header 和 Pi 的 `onProviderStreamEvent` 回调。

也可以通过 Provider 的 `modelOverrides` 为已有模型添加相同的 `compat.remoteCompaction` 配置。

## 数据与限制

扩展会将当前对话发送到所选 Provider 的 Responses endpoint。Provider 返回的 opaque `encrypted_content` 会保存在本地 Pi session 中，并在后续兼容请求中重放。

切换 Provider、API、模型、`baseUrl` 或 endpoint 后，已有 checkpoint 不会重放。近期未压缩消息仍可继续使用，但 opaque 历史不会转换为文本摘要。

Checkpoint identity uses the resolved endpoint. A changed authentication endpoint rejects replay before opaque history is sent. Response event and opaque item limits are defined in [protocol.ts](extensions/protocol.ts); the persisted history limit is defined in [checkpoint.ts](extensions/checkpoint.ts). These host limits can cause fallback to Pi compaction.

实现基于 `@narumitw/pi-codex-compact`，许可证与 attribution 见 [LICENSE](LICENSE)。

## Verification

From the repository root, run these npm scripts with Node 24 or newer:

```bash
npm run test --workspace @oipsanthony/pi-codex-compaction
npm run typecheck --workspace @oipsanthony/pi-codex-compaction
npm run pack:check
```

The test script compiles TypeScript into the ignored `dist/` directory and runs Node's test runner. It does not invoke Bun. Other upstream packages retain their existing test runtimes.

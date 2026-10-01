# pi-codex-compaction

在 Pi 的原有 compaction 流程中使用 Codex Remote Compaction V2。压缩结果由 Provider 生成并保存在 session 中，恢复 session、fork 或继续压缩时可以复用。

> [!WARNING]
> Remote Compaction V2 仍是实验协议。生成的 checkpoint 只能在相同的 Provider、API、`baseUrl` 和 endpoint 上重放；同一后端内切换模型会继续重放。

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

压缩请求沿用 Pi 0.99 transcript 中声明提示词与工具的 system 消息；旧会话缺少 system 消息时回退到当前系统提示词和已激活工具。若其他扩展在 `before_agent_start` 覆盖整个 prompt，本包在普通请求发出前通过 `ctx.getSystemPrompt()` 记录实际生效的覆盖。随后压缩仅在 session、模型、后端及来源 system 消息指纹仍匹配时沿用它。

本包通过 `context_with_system` 保存普通请求经过 `context` 处理后的消息投影，包括工具输出占位文本。压缩时，只有原始会话历史仍与该请求的来源前缀逐条匹配，才沿用这份投影并追加新增消息，再交由 Pi Provider 序列化。历史编辑、系统状态变化、切换 session、模型或后端时丢弃旧投影；普通请求包含尚未写入会话的消息时不保存投影。Prompt 覆盖和消息投影仅保存在当前进程中；重启后需要先发出一次普通请求。

`images.blockImages`、`thinkingBudgets`、`websocketConnectTimeoutMs` 和 `retry.provider.maxRetryDelayMs` 按 Pi 设置生效；重试次数取 Pi 的 `retry.provider.maxRetries` 与 Codex 上限 2 中的较小值。压缩不会重新执行其他扩展的处理器；本包 `context_with_system` 之后的消息改写、`before_provider_request` 的额外 payload 改写及 `before_provider_headers` 处理器不会被快照重放。工具 `prepareLoadout` 隐藏的声明由 Pi 在 context 处理器之后过滤，扩展 API 无法取得，因此使用该能力时压缩请求仍会声明这些工具，缓存前缀会从工具定义处分叉。Remote Compaction V2 不接受 `/compact` 的自定义指令，提供时会显示 warning 并忽略。

The extension observes Responses events with `onProviderStreamEvent`, which works with Pi's HTTP and WebSocket adapters. It uses the configured transport for standard provider routes. An explicit nonstandard endpoint override uses HTTP because Pi exposes custom HTTP routing through `fetch`.

Tests compare ordinary and compaction requests through the real Pi Responses adapters using simulated HTTP responses. Matching parameters do not guarantee a cache hit or a billing reduction; those depend on the backend and request prefix.

### History retention

[retention-input.ts](extensions/retention-input.ts) 按 [Codex rust-v0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/compact_remote_v2.rs) 的默认规则筛选普通 Responses 消息：排除环境、技能、内部上下文及旧版提示片段，识别可见 hook 提示，并把图片缩放通知与来源消息一起处理。Hook XML 使用固定版本的 `saxes` 解析，边界用例与官方 `quick-xml` 实际运行结果对照。

Pi 会把 `!cmd` 的执行结果、扩展消息和展开后的技能都作为 user 消息发送，而 Codex 将对应内容作为独立的上下文消息处理。扩展按 Pi 消息来源对齐这些 user 条目：`bashExecution` 与隐藏的扩展消息（`display: false`）视为上下文不保留，显示的扩展消息与 Codex 的可见 hook 提示一致予以保留；技能块只保留用户在技能之后输入的文字。来源序列与 Provider 实际发送的 user 条目数量不一致时，退回纯文本分类。

[retention.ts](extensions/retention.ts) 从最新消息开始，按 `RETAINED_MESSAGE_TOKEN_BUDGET` 保留消息组。[text-budget.ts](extensions/text-budget.ts) 按 UTF-8 字节估算 token，截断时保留文本首尾；[image-budget.ts](extensions/image-budget.ts) 实现官方默认启用的图片预算，原始图片尺寸通过 Pi 解码器读取。边界图片与标签整体保留；图片放不下时，不回填更旧的消息。

发送压缩请求前，[context-window.ts](extensions/context-window.ts) 按官方 `trim_function_call_history_to_fit_context_window` 估算整份历史：超过模型 `contextWindow` 的 95% 时，从末尾起把连续的工具输出替换为固定截断提示，遇到非工具输出即停止。溢出恢复触发的压缩因此不必先超出上下文窗口。

Opaque 项追加在保留消息之后，不占上述预算；旧 `compaction_summary` 项在接收或加载时规范化为 `compaction`。Pi 没有提供 Codex 的 harness 来源标记和 agent 消息类型，相关分支不在适配范围内。原始图片解码器及 XML 解析器不同，回归用例通过不代表所有格式与异常输入均已证明等价。

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

与 Codex 一致，同一后端内切换模型后 checkpoint 继续重放，压缩项随新模型一起发送。Codex 另外依据服务端下发的 `comp_hash` 判断模型间的压缩兼容性，不兼容时先用旧模型重新压缩；Pi 不提供该标识，扩展无法提前判断，若新模型拒绝旧压缩项，请切回原模型。切换 Provider、API、`baseUrl` 或 endpoint 后，已有 checkpoint 不会重放。近期未压缩消息仍可继续使用，但 opaque 历史不会转换为文本摘要。

Checkpoint identity uses the resolved endpoint. A changed authentication endpoint rejects replay before opaque history is sent. 扩展不再对响应事件、opaque 项或保留历史施加额外的序列化字节上限；历史选择使用官方 token 预算。Pi 负责传输，扩展继续传递取消信号，并使用 [remote.ts](extensions/remote.ts) 的请求超时和重试设置。事件收集器只保存当前压缩项，不积累完整事件流。

[checkpoint.ts](extensions/checkpoint.ts) 使用 Pi 的 `buildSessionProjection()` 生成保留消息指纹，应用消息编辑和隐藏规则，忽略旧压缩记录，并按 `context` 事件约定排除 system 消息。

保留消息被其他扩展或编辑改变、导致指纹不再匹配时，检查点不会重放，扩展会在当前会话中提示一次。

同时使用会改写工具输出的 `context` 扩展时，在 Pi 的 `packages` 列表中将本包放在这些扩展之前。例如，有些扩展会把已暴露的工具输出替换为占位文本；先投影 checkpoint，再处理近期消息，可避免这些占位文本改变受保护的保留历史。Pi 按扩展加载顺序执行处理器，本包不会跳过指纹校验。

加载旧检查点时，扩展先按检查点创建时的分支验证旧算法生成的指纹，确认匹配后在内存中修正为标准投影的指纹。此过程不改写会话文件，也不改变 checkpoint 格式。原始记录缺失或旧指纹不匹配时不执行修正；检查点创建之后的消息编辑仍受重放校验约束。

实现基于 `@narumitw/pi-codex-compact`，许可证与 attribution 见 [LICENSE](LICENSE)。

## Verification

From the repository root, run these npm scripts with Node 24 or newer:

```bash
npm run test --workspace @oipsanthony/pi-codex-compaction
npm run typecheck --workspace @oipsanthony/pi-codex-compaction
npm run pack:check
```

The test script compiles TypeScript into the ignored `dist/` directory and runs Node's test runner. It does not invoke Bun. Other upstream packages retain their existing test runtimes.

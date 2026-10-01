# pi-codex-compaction

在 Pi 的原有 compaction 流程中使用 Codex Remote Compaction V2。压缩结果由 Provider 生成并保存在 session 中，恢复 session、fork 或继续压缩时可以复用。

> [!WARNING]
> Remote Compaction V2 仍是实验协议。生成的 checkpoint 只能在相同的 Provider、API、`baseUrl` 和 endpoint 上重放；同一后端内切换模型会继续重放。

## 安装

需要 Pi 0.99.1 或更新版本。从 GitHub 安装：

```bash
pi install git:github.com/Criogaid/pi-codex-compaction
```

开发时可在克隆后的仓库根目录执行 `pi install .`。本仓库以独立包 `pi-codex-compaction` 维护，来源为 `Criogaid/pi-extensions-anthony` 的 `fix/compaction-runtime-parameters` 分支；原 `@oipsanthony/pi-codex-compaction` npm 包对应上游实现。

## 使用

安装后无需配置。使用 Pi 官方 `openai-codex` 模型时，手动执行 `/compact` 或触发 Pi 自动压缩，扩展会优先尝试 remote compaction。

压缩开始和完成时会显示提示。默认情况下，remote compaction 失败时显示 warning，并由 Pi 使用当前对话模型执行原生 compaction；当前模型不支持 remote compaction 时也由 Pi 原生处理。可以按下面的配置为这两种情况指定独立的压缩模型。

### 指定降级压缩模型

在 Pi 中执行 `/codex-compaction`。终端菜单中的 `Fallback model` 开关按回车或空格直接切换 On/Off，保存后停留在同一行，没有二级开关菜单。关闭保留已选模型和思考等级。模型列表支持按 Provider、模型 ID 或名称模糊搜索，随后选择该模型支持的思考等级。RPC 模式通过输入框搜索，再从匹配结果中选择；选中开关项直接切换。

开关与模型分别配置，只有开关为 On 且模型已配置时才生效。尚未选模型时开启开关不会弹出模型选择，而是显示未生效；首次选择模型也不会自动打开开关。每次切换立即保存，ESC 退出菜单不撤销已保存的修改；取消模型或思考等级选择不保存该次选择。当前对话模型和思考等级保持不变，保存后下次降级使用新设置。

命令写入下述配置文件，保存前检查文件是否在菜单打开后发生变化，并通过 Pi 的文件写入队列原子替换。该队列只协调当前进程，不提供跨进程锁或断电后的持久性保证。配置无效时保留原文件并显示错误；配置文件是符号链接时继续支持读取，但需要直接编辑链接目标。非交互模式也可以直接编辑配置文件。

在 `~/.pi/agent/extensions/pi-codex-compaction/` 目录新建 `config.json`，目录不存在时先创建。设置了 `PI_CODING_AGENT_DIR` 时，配置路径为该目录下的 `extensions/pi-codex-compaction/config.json`。配置使用 UTF-8 JSON：

```json
{
  "version": 1,
  "fallback": {
    "enabled": true,
    "provider": "your-provider",
    "model": "gpt-6.1-sol",
    "thinkingLevel": "high"
  }
}
```

将 `provider` 和 `model` 替换为 Pi 中已配置的实际 ID；显示名称不能代替 ID。模型必须支持指定的 `thinkingLevel`，例如 `high` 或 `off`。扩展通过 Pi 的模型注册表使用该模型的认证、Provider 配置与思考等级映射，不需要额外配置 API key。

Remote Compaction V2 成功时继续使用当前模型的 opaque 检查点。远程请求失败，或当前模型不支持该协议时，扩展使用指定模型调用 Pi 原生文本压缩。手动 `/compact`、自动阈值压缩和上下文溢出恢复共用此规则。例如，使用 Astra 对话时可以把文本压缩交给 `gpt-6.1-sol` 的 `high`，摘要生成后仍由 Astra 继续对话，当前模型和对话思考等级不会被修改。

文本压缩复用 Pi 准备的消息范围、已有文本摘要、最近消息保留点、文件操作记录及 `/compact` 自定义指令。摘要用量由实际压缩模型报告并写入 Pi 的压缩记录；需要切分一轮对话时，Pi 可能生成两份摘要并合计用量。Provider 的传输、思考预算、超时与重试沿用 Pi 设置；未设置请求超时时默认使用五分钟。原生摘要请求按 Pi 的规则使用 `cacheRetention: "none"`。选择更低价格的模型可以减少压缩费用，实际费用还取决于输入范围、输出和思考用量。

每次需要降级时重新读取配置，修改后下次降级即生效。`fallback.enabled` 接受布尔值 `true` 或 `false`；旧配置省略该字段时视为 `true`。允许只保存开关，例如 `{"version":1,"fallback":{"enabled":true}}`；模型的 `provider`、`model`、`thinkingLevel` 三个字段必须同时提供或同时省略。模型未配置、开关为 `false`、文件不存在或移除 `fallback` 字段时，恢复 Pi 使用当前对话模型压缩的默认行为，不查找降级模型或调用其 Provider。配置格式错误仍会停止压缩；启用且已配置模型后，模型不可用、认证失败、请求失败、空摘要或达到输出长度上限也会停止此次压缩，避免再次转交当前对话模型。取消或切换会话时不保存压缩结果。

已有 Codex opaque 检查点中的加密历史不能被另一个 Provider 解读，也不会自动还原成文本。指定模型的降级压缩沿用 Pi 原生准备中可用的摘要和消息范围；本功能不改变 Codex 检查点格式。

配置格式、读取与菜单保存由 [fallback-settings.ts](extensions/fallback-settings.ts) 负责，命令交互由 [fallback-command.ts](extensions/fallback-command.ts) 负责。模型选择与原生摘要请求保留在 [fallback.ts](extensions/fallback.ts)；生命周期与降级决定保留在 [codex-compaction.ts](extensions/codex-compaction.ts)。

### Runtime parameters

Remote compaction captures the active session ID and current thinking level when it starts. It calls Pi's public `ModelRegistry.streamSimple()` facade so Pi resolves authentication, model and auth headers, provider environment, and the actual `baseUrl` before dispatch. The provider applies the selected model's thinking-level mapping, including `off`.

Cache options use the same provider defaults and resolved `PI_CACHE_RETENTION` environment as normal requests. The extension passes the active session ID for cache keys and routing instead of forcing `cacheRetention: "none"`. Model sampling parameters, resolved authentication, and provider headers remain owned by Pi.

压缩请求沿用 Pi 0.99 transcript 中声明提示词与工具的 system 消息；旧会话缺少 system 消息时回退到当前系统提示词和已激活工具。若其他扩展在 `before_agent_start` 覆盖整个 prompt，本包在普通请求发出前通过 `ctx.getSystemPrompt()` 记录实际生效的覆盖。随后压缩仅在 session、模型、后端及来源 system 消息指纹仍匹配时沿用它。

本包通过 `context_with_system` 保存普通请求经过 `context` 处理后的消息投影，包括工具输出占位文本。压缩时，只有原始会话历史仍与该请求的来源前缀逐条匹配，才沿用这份投影并追加新增消息，再交由 Pi Provider 序列化。历史编辑、系统状态变化、切换 session、模型或后端时丢弃旧投影；普通请求包含尚未写入会话的消息时不保存投影。Prompt 覆盖和消息投影仅保存在当前进程中；重启后需要先发出一次普通请求。

`images.blockImages`、`thinkingBudgets`、`websocketConnectTimeoutMs` 和 `retry.provider.maxRetryDelayMs` 按 Pi 设置生效；重试次数取 Pi 的 `retry.provider.maxRetries` 与 Codex 上限 2 中的较小值。压缩不会重新执行其他扩展的处理器；本包 `context_with_system` 之后的消息改写、`before_provider_request` 的额外 payload 改写及 `before_provider_headers` 处理器不会被快照重放。工具 `prepareLoadout` 隐藏的声明由 Pi 在 context 处理器之后过滤，扩展 API 无法取得，因此使用该能力时压缩请求仍会声明这些工具，缓存前缀会从工具定义处分叉。Remote Compaction V2 不接受 `/compact` 的自定义指令，提供时会显示 warning 并忽略。

The extension observes Responses events with `onProviderStreamEvent`, which works with Pi's HTTP and WebSocket adapters. It uses the configured transport for standard provider routes. An explicit nonstandard endpoint override uses HTTP because Pi exposes custom HTTP routing through `fetch`.

Tests compare ordinary and compaction requests through the real Pi Responses adapters using simulated HTTP responses. Matching parameters do not guarantee a cache hit or a billing reduction; those depend on the backend and request prefix.

回归测试覆盖含用户图片和工具输出图片的请求前缀、工具输出投影后遇到 HTTP 503 的重试、会话关闭后的快照清理，以及取消或切换会话后的迟到压缩响应。配置命令通过真实扩展入口和 Pi 模型注册表测试，覆盖取消不保存、外部修改冲突和受支持的思考等级；这些测试不向真实模型发送请求。

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

独立维护后继续使用原有 checkpoint、marker 和 completion entry 标识，并保留旧 fallback summary 的文字，以兼容已有 Pi 会话。因此会话记录和部分降级提示仍包含原包名。

实现基于 `@narumitw/pi-codex-compact`，许可证与 attribution 见 [LICENSE](LICENSE)。

## 开发与验证

使用 Node 24 或更新版本。在仓库根目录安装依赖并运行：

```bash
bun install --frozen-lockfile
npm run typecheck
npm test
npm run pack:check
```

测试脚本将 TypeScript 编译到 Git 忽略的 `dist/` 目录，再使用 Node 的测试运行器执行。打包检查使用 npm dry run，验证入口和全部运行时模块已包含，测试及迁移记录未进入发布包。CI 在 Linux 和 Windows 上运行相同命令。

版本变更使用 Changesets：`npm run changeset` 添加记录，`npm run version-packages` 应用版本变更。本次迁移没有发布 npm 包；仓库不自动发布。

## 来源与提交历史

本仓库仅提取源分支中本插件的源码、测试、文档、许可证、专属 Changeset 和 remote-compaction 设计记录。包目录移到仓库根目录，原始作者、提交者、时间、正文及署名行保持不变；提交标题中的 scope 改为对应功能模块。重建提交改变了 Git 对象，原加密签名不再保留。

[migration/history.json](migration/history.json) 记录源分支、源提交和重建提交的对应关系。现有 Changelog 的版本及旧提交引用保留为上游发布记录；`openspec/changes/archive/` 保留原设计阶段的包名和路径。运行行为以本 README 与当前测试为准，迁移不修改扩展运行时代码。

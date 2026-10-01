# pi-codex-compaction

本扩展让 Pi 的压缩流程使用 Codex Remote Compaction V2。Provider 生成的压缩结果保存在 session 中，恢复 session、fork 或再次压缩时都可以复用。

> [!WARNING]
> Remote Compaction V2 是实验协议。checkpoint 重放要求 Provider、API、`baseUrl` 和 endpoint 相同；同一后端内切换模型时仍会重放。

## 安装

需要 Pi 0.99.1 或更新版本。从 GitHub 安装：

```bash
pi install git:github.com/Criogaid/pi-codex-compaction
```

开发时可在克隆后的仓库根目录执行 `pi install .`。

## 使用

安装后无需配置。使用 Pi 官方 `openai-codex` 模型时，执行 `/compact` 或触发自动压缩，扩展会优先尝试远程压缩。

扩展在压缩开始和完成时显示提示。默认情况下，远程压缩失败会发出警告，再由 Pi 使用当前对话模型进行原生压缩。当前模型不支持远程压缩时，也由 Pi 原生处理。通过 `/codex-compaction` 可以关闭 V2，或为文本压缩指定独立模型。

### Remote Compaction V2 开关

`/codex-compaction` 菜单中的 `Remote Compaction V2` 默认 On。终端按回车或空格即可切换并保存，选中行保持不变；RPC 模式选中该项即可切换。

关闭后不再发起新的 V2 压缩请求。fallback 开关已开启且模型已配置时，使用指定模型；否则由 Pi 使用当前对话模型进行原生文本压缩。手动压缩、自动阈值压缩和上下文溢出恢复都遵循这条规则。重新开启后，支持该协议的模型会再次优先尝试 V2。

开关控制后续压缩请求，已有 opaque 检查点继续按原规则重放。关闭 V2 后，加密历史仍以 opaque 形式保留，检查点格式和当前对话模型保持不变。

要测试指定模型的文本压缩，将 V2 设为 Off、fallback 设为 On，选好模型和思考等级，再在已有可压缩内容的会话中执行 `/compact`。开始时应显示 `Using Pi text compaction with <provider>/<model> (<thinkingLevel>).`。

检查压缩是否完成、Provider 请求记录是否使用所选模型，以及后续对话是否仍由原模型继续。测试结束后可按需将 V2 恢复为 On。

每次压缩开始时读取一次配置，压缩期间的修改在下次生效。配置文件无法读取、JSON 无效或 V2 开关格式错误时，扩展停止压缩。V2 成功时，不校验尚未用到的 fallback 配置。

### 指定降级压缩模型

在 Pi 中执行 `/codex-compaction`。TUI 和 RPC 菜单依次显示 Remote Compaction V2、Fallback 开关、Fallback 模型与思考等级；TUI 默认选中第一项。

终端中的 `Fallback model` 开关按回车或空格直接切换 On/Off，保存后停留在同一行，不打开二级菜单。关闭开关会保留已选模型和思考等级。模型列表可按 Provider、模型 ID 或名称模糊搜索，选定模型后再选它支持的思考等级。

RPC 模式先通过输入框搜索，再从匹配结果中选择模型；选中开关项即可切换。

开关和模型分别配置，只有开关为 On 且模型已配置时才生效。尚未选模型时开启开关，只会显示未生效，不会弹出模型选择；首次选择模型也不会自动打开开关。

开关切换后立即保存，ESC 退出菜单不会撤销已保存的修改。取消模型或思考等级选择，则不保存该次选择。当前对话模型和思考等级保持不变，新设置在下次降级压缩时生效。

命令保存配置前，会检查文件是否在菜单打开后发生变化，再通过 Pi 的文件写入队列原子替换。队列只协调当前进程，不提供跨进程锁或断电后的持久性保证。

配置读取或保存出错时，会保留原文件并显示错误。符号链接配置可以读取，但保存时需要直接编辑链接目标。非交互模式也可以直接编辑配置文件。

在 `~/.pi/agent/extensions/pi-codex-compaction/` 目录新建 `config.json`，目录不存在时先创建。设置了 `PI_CODING_AGENT_DIR` 时，配置路径为该目录下的 `extensions/pi-codex-compaction/config.json`。配置使用 UTF-8 JSON：

```json
{
  "version": 1,
  "remoteCompaction": {
    "enabled": true
  },
  "fallback": {
    "enabled": true,
    "provider": "your-provider",
    "model": "gpt-6.1-sol",
    "thinkingLevel": "high"
  }
}
```

将 `provider` 和 `model` 换成 Pi 中已配置的实际 ID，不能使用显示名称。模型须支持指定的 `thinkingLevel`，例如 `high` 或 `off`。认证、Provider 配置和思考等级映射都由 Pi 的模型注册表处理，无需另外配置 API key。

选择虚拟模型时，每份摘要由 Pi 路由一次。输出预算受原生压缩预留量和实际模型上限约束，虚拟模型的展示限额不会提前截断摘要。

Remote Compaction V2 成功时，继续使用当前模型的 opaque 检查点。V2 关闭、远程请求失败或当前模型不支持该协议时，扩展会用已启用的指定模型调用 Pi 原生文本压缩。手动 `/compact`、自动阈值压缩和上下文溢出恢复都遵循这条规则。

例如，用 Astra 对话时，可以把文本压缩交给 `gpt-6.1-sol` 的 `high`。摘要生成后仍由 Astra 继续对话，当前模型和对话思考等级保持不变。

文本压缩复用 Pi 准备的消息范围、已有文本摘要、最近消息保留点、文件操作记录及 `/compact` 自定义指令。实际压缩模型报告的用量会写入 Pi 压缩记录；需要切分一轮对话时，Pi 可能生成两份摘要并合计用量。

传输方式、思考预算、超时和重试沿用 Pi 设置；未设置请求超时时，默认使用五分钟。原生摘要请求按 Pi 的规则使用 `cacheRetention: "none"`。选择价格更低的模型可以减少压缩费用，实际费用仍取决于输入范围、输出和思考用量。

`remoteCompaction.enabled` 接受布尔值 `true` 或 `false`。省略 `remoteCompaction` 时默认启用 V2，菜单保存时会明确写入 `enabled: true` 或 `enabled: false`。

`fallback.enabled` 也接受布尔值 `true` 或 `false`，旧配置省略该字段时视为 `true`。可以只保存开关，例如 `{"version":1,"fallback":{"enabled":true}}`。模型的 `provider`、`model`、`thinkingLevel` 三个字段须同时提供或同时省略。

模型未配置、fallback 开关为 `false`、文件不存在或移除 `fallback` 字段时，Pi 使用当前对话模型做文本压缩，不查找降级模型，也不调用它的 Provider。

需要降级时，fallback 配置错误会停止压缩。启用并配置模型后，模型不可用、认证失败、请求失败、摘要为空或达到输出长度上限，也会停止此次压缩，不再转交当前对话模型。取消或切换会话时不保存压缩结果。

另一个 Provider 无法解读已有 Codex opaque 检查点中的加密历史，这些历史也不会自动还原成文本。指定模型的降级压缩使用 Pi 原生准备中可用的摘要和消息范围，Codex 检查点格式保持不变。

配置格式、读取与菜单保存由 [fallback-settings.ts](extensions/fallback-settings.ts) 负责，命令交互由 [fallback-command.ts](extensions/fallback-command.ts) 负责。[fallback.ts](extensions/fallback.ts) 处理模型选择和原生摘要请求，[codex-compaction.ts](extensions/codex-compaction.ts) 处理生命周期、V2 开关及降级决定。

### 运行参数

远程压缩开始时记录当前 session ID 和思考等级。请求通过 Pi 的公开接口 `ModelRegistry.streamSimple()` 发出，由 Pi 解析认证、模型与认证请求头、Provider 环境和实际 `baseUrl`。Provider 应用所选模型的思考等级映射，包括 `off`。

缓存选项沿用普通请求的 Provider 默认值和解析后的 `PI_CACHE_RETENTION` 环境变量。扩展传入当前 session ID，供缓存键和路由使用，不强制设置 `cacheRetention: "none"`。采样参数、认证和 Provider 请求头由 Pi 管理。

压缩请求使用 Pi 0.99 transcript 中声明提示词和工具的 system 消息。旧会话缺少 system 消息时，使用当前系统提示词和已激活工具。

其他扩展通过 `before_agent_start` 覆盖整个 prompt 时，本包会在普通请求发出前通过 `ctx.getSystemPrompt()` 记录实际生效的文本。后续压缩只有在 session、模型、后端和来源 system 消息指纹仍匹配时，才沿用这份覆盖。

本包通过 `context_with_system` 保存普通请求经过 `context` 处理后的消息投影，包括工具输出占位文本。压缩时，原始会话历史须与请求来源前缀逐条匹配，才能复用投影、追加新消息，再交给 Pi Provider 序列化。

历史编辑、系统状态变化，以及切换 session、模型或后端，都会使旧投影失效。普通请求中包含尚未写入会话的消息时，不保存投影。提示词覆盖和消息投影只保存在当前进程中，重启后须先发出一次普通请求。

V2 请求固定使用 SSE，避免复用缺少 `remote_compaction_v2` 功能头的普通 WebSocket 连接。session ID、缓存参数和请求前缀沿用原规则，普通对话与文本降级仍使用 Pi 的传输设置。

`images.blockImages`、`thinkingBudgets` 和 `retry.provider.maxRetryDelayMs` 按 Pi 设置生效。重试次数取 Pi 的 `retry.provider.maxRetries` 与 Codex 上限 2 中的较小值。

压缩不会重新执行其他扩展的处理器。快照不包含本包 `context_with_system` 之后的消息改写、`before_provider_request` 的额外 payload 改写，以及 `before_provider_headers` 处理器的处理结果。

Pi 在 context 处理器之后过滤工具 `prepareLoadout` 隐藏的声明，扩展 API 无法取得过滤结果。因此压缩请求仍会声明这些工具，缓存前缀会从工具定义处分叉。

Remote Compaction V2 不接受 `/compact` 自定义指令，提供时会显示警告并忽略。

扩展通过 Pi 的 `onProviderStreamEvent` 收集 Responses 事件。显式配置非标准 endpoint 时，通过 `fetch` 将请求重定向到已校验的同源地址。

测试通过真实 Pi Responses 适配器和模拟 HTTP 响应，对比普通请求与压缩请求。参数一致不保证命中缓存或降低费用，实际结果取决于后端和请求前缀。

回归测试覆盖用户图片与工具输出图片的请求前缀、工具输出投影后遇到 HTTP 503 的重试、会话关闭后的快照清理，以及取消或切换会话后的迟到压缩响应。

配置命令的测试通过真实扩展入口和 Pi 模型注册表执行，覆盖取消不保存、外部修改冲突和受支持的思考等级。这些测试不向真实模型发送请求。

### 历史保留

[retention-input.ts](extensions/retention-input.ts) 按 [Codex rust-v0.159.2](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/compact_remote_v2.rs) 的默认规则筛选普通 Responses 消息，排除环境、技能、内部上下文和旧版提示片段，并识别可见 hook 提示。[history-groups.ts](extensions/history-groups.ts) 将图片缩放通知与来源消息分为同一组。

Hook XML 由固定版本的 `saxes` 解析，边界用例与官方 `quick-xml` 的实际运行结果对照。`saxes` 比 `quick-xml` 严格：带 XML 声明或 DOCTYPE、属性带命名空间前缀、属性值含未转义的 `<`、文本含 `]]>`、元素名非法或含控制字符的 hook 文本，都按普通用户文本处理。这些文本与其他内容同属一条消息时，才会影响保留结果。

Pi 会把 `!cmd` 执行结果、扩展消息和展开后的技能作为 user 消息发送，Codex 则将对应内容作为独立上下文消息处理。本包按 Pi 消息来源对齐这些 user 条目。

`bashExecution` 与隐藏的扩展消息（`display: false`）作为上下文排除；显示的扩展消息按 Codex 可见 hook 提示的规则保留。技能块只保留用户在技能之后输入的文字。来源序列与 Provider 实际发送的 user 条目数量不一致时，退回纯文本分类。

[retention.ts](extensions/retention.ts) 从最新消息开始，按 `RETAINED_MESSAGE_TOKEN_BUDGET` 保留消息组。[text-budget.ts](extensions/text-budget.ts) 用 UTF-8 字节估算 token，截断时保留文本首尾。[image-budget.ts](extensions/image-budget.ts) 使用官方默认启用的图片预算，通过 Pi 解码器读取原始尺寸。

边界图片和标签整体保留。图片放不下时，不回填更旧的消息。

发送压缩请求前，[context-window.ts](extensions/context-window.ts) 按官方 `trim_function_call_history_to_fit_context_window` 规则估算整份历史。超过模型 `contextWindow` 的 95% 时，从末尾开始将连续工具输出替换为固定截断提示，遇到非工具输出即停止。因此，上下文溢出恢复也能在请求前缩减历史。

opaque 项追加在保留消息之后，不占上述预算。旧 `compaction_summary` 项在接收或加载时规范化为 `compaction`。

Pi 未提供 Codex 的 harness 来源标记和 agent 消息类型，这些分支不在适配范围内。原始图片解码器和 XML 解析器也不同；回归用例通过，并不表示所有格式与异常输入都已证明等价。

## 自定义 Provider

自定义模型须使用 `openai-responses` 或 `openai-codex-responses` API，并在 `~/.pi/agent/models.json` 中声明 capability：

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

扩展根据 API 和 `baseUrl` 推导默认请求地址。网关使用非标准路由时，再指定 `endpoint`：

```json
{
  "remoteCompaction": {
    "protocol": "v2",
    "endpoint": "https://gateway.example.com/responses"
  }
}
```

`endpoint` 须与 Pi 认证解析后的 `baseUrl` 同源，且不能包含凭据、query 或 fragment。Provider 须支持 Codex compaction payload、`remote_compaction_v2` beta header 和 Pi 的 `onProviderStreamEvent` 回调。

为已有模型添加支持时，可通过 Provider 的 `modelOverrides` 设置相同的 `compat.remoteCompaction` 配置。

## 数据与限制

扩展将当前对话发送到所选 Provider 的 Responses endpoint。Provider 返回的 opaque `encrypted_content` 保存在本地 Pi session 中，供后续兼容请求重放。

与 Codex 一样，同一后端内切换模型时，checkpoint 继续重放，压缩项随新模型一起发送。

Codex 还会根据服务端下发的 `comp_hash` 判断模型间的压缩兼容性，不兼容时先用旧模型重新压缩。Pi 未提供这个标识，扩展无法提前判断。新模型拒绝旧压缩项时，须切回原模型。

切换 Provider、API、`baseUrl` 或 endpoint 后，已有 checkpoint 不会重放。近期未压缩消息仍可继续使用，opaque 历史不会转换成文本摘要。

检查点身份绑定认证后解析出的 endpoint。认证地址改变时，扩展会在发送 opaque 历史前拒绝重放。

扩展不对响应事件、opaque 项或保留历史施加额外的序列化字节上限，历史选择使用官方 token 预算。Pi 负责传输，扩展传递取消信号，并使用 [remote.ts](extensions/remote.ts) 的请求超时和重试设置。事件收集器只保存当前压缩项，不积累完整事件流。

[checkpoint.ts](extensions/checkpoint.ts) 通过 Pi 的 `buildSessionProjection()` 生成保留消息指纹。投影应用消息编辑和隐藏规则，忽略旧压缩记录，并按 `context` 事件约定排除 system 消息。

其他扩展或编辑改变保留消息、导致指纹不匹配时，检查点停止重放，扩展会在当前会话中提示一次。

同时使用会改写工具输出的 `context` 扩展时，在 Pi 的 `packages` 列表中将本包放在这些扩展之前。Pi 按加载顺序执行处理器；先投影 checkpoint，再处理近期消息，可以避免工具输出占位文本改变受保护的保留历史。重放前仍会校验指纹。

新检查点按 UTF-16 码元顺序排列对象键，再生成消息指纹，不依赖系统语言或 ICU 排序规则。

旧检查点加载时，扩展先在创建时的分支上精确验证指纹，包括按原始条目生成的指纹和按标准投影生成的 locale 排序指纹。匹配后只在内存中转换，不改写会话文件，也不改变 checkpoint version 1 的字段。创建检查点之后的消息编辑仍受重放校验约束。

旧检查点没有记录生成指纹时的 locale，当前环境须能复现原排序并通过精确校验，才能兼容。旧会话已因语言环境变化而无法重放时，需要在原排序环境中恢复，再生成一次新检查点。原始记录缺失或旧指纹不匹配时，不执行转换；扩展不会猜测排序或跳过校验。

为兼容已有 Pi 会话，独立维护后仍沿用原 checkpoint、marker 和 completion entry 标识，以及旧 fallback summary 的文字。因此，会话记录和部分降级提示仍包含原包名。

实现基于 `@narumitw/pi-codex-compact`，许可证和署名见 [LICENSE](LICENSE)。

## 开发与验证

需要 Node 24 或更新版本。在仓库根目录安装依赖并运行检查：

```bash
bun install --frozen-lockfile
npm run typecheck
npm test
npm run pack:check
```

测试脚本先将 TypeScript 编译到 Git 忽略的 `dist/` 目录，再用 Node 测试运行器执行。打包检查通过 npm dry run 确认入口和全部运行时模块已包含，测试及迁移记录未进入发布包。

CI 在 Ubuntu 24.04 和 Windows 上运行相同命令，配置见 [ci.yml](.github/workflows/ci.yml)。

版本变更使用 Changesets。用 `npm run changeset` 添加记录，用 `npm run version-packages` 应用版本变更。提取迁移没有发布 npm 包，仓库不自动发布。

## 来源与提交历史

本仓库以独立包 `pi-codex-compaction` 维护，来自 `Criogaid/pi-extensions-anthony` 的 `fix/compaction-runtime-parameters` 分支。原 `@oipsanthony/pi-codex-compaction` npm 包对应上游实现。

仓库只提取源分支中本插件的源码、测试、文档、许可证、专属 Changeset 和 remote-compaction 设计记录，并将包目录移到仓库根目录。原始作者、提交者、时间、提交正文和署名行保持不变，提交标题的 scope 改为对应功能模块。重建提交改变了 Git 对象，原加密签名不再保留。

[migration/history.json](migration/history.json) 记录源分支、源提交和重建提交的对应关系。现有 Changelog 的版本和旧提交引用作为上游发布记录保留，`openspec/changes/archive/` 保留原设计阶段的包名和路径。运行行为以本 README 和当前测试为准；迁移没有修改扩展运行时代码。

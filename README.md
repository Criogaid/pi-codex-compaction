# @criogaid/pi-codex-compaction

[![CI](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![license](https://img.shields.io/npm/l/@criogaid/pi-codex-compaction)](LICENSE)

让 [Pi](https://github.com/earendil-works/pi) 在 Codex 模型上使用 Codex Remote Compaction V2 压缩聊天记录，失败时自动退回 Pi 原生压缩，并且可以为原生压缩单独指定一个摘要模型。

- **装上即用：** 对 Codex 模型默认启用 V2 远程压缩，无需任何配置。
- **失败自动退回：** 当前模型不支持 V2，或 V2 请求失败时，改用 Pi 原生的文字摘要压缩。
- **独立摘要模型（可选）：** 退回 Pi 原生压缩时，可以使用你指定的模型和思考等级生成摘要。它只接管这一步，不影响 V2 远程压缩，也不改变当前对话模型。
- **Codex 式思考等级更新（可选，默认关闭）：** 开启后，普通请求和 V2 请求都按 Codex 的方式发送思考等级变化。启用前请先卸载独立的思考等级扩展，详见[思考等级更新](#思考等级更新)。

[安装](#安装) · [工作方式](#工作方式) · [独立摘要模型](#独立摘要模型) · [配置](#配置) · [自定义网关](#自定义网关) · [注意事项](#注意事项)

## 安装

需要 Pi 0.99.1 或更新版本：

```bash
pi install npm:@criogaid/pi-codex-compaction
```

也可以从 Git 仓库安装：

```bash
pi install git:github.com/Criogaid/pi-codex-compaction
```

> [!NOTE]
> 请安装带 `@criogaid` 作用域的包。不带作用域的 `pi-codex-compaction` 属于另一个仓库。

使用 Pi 自带的 `openai-codex` 服务商和官方地址时，安装后无需配置。手动执行 `/compact`、Pi 自动压缩，以及聊天记录超出模型容量后触发的压缩，都会经过本扩展。

## 工作方式

手动、自动或上下文溢出触发压缩时，扩展先按设置尝试 V2。文字回退按是否已有 V2 检查点区分：

| 情况 | 压缩方式 | 使用的模型 |
| --- | --- | --- |
| V2 开启，模型支持 V2，请求成功 | V2 远程压缩 | 当前对话模型 |
| 首次 V2 请求失败，尚无检查点 | Pi 原生压缩 | 摘要模型，未指定时为当前对话模型 |
| 已有兼容检查点，V2 遇到可确认的暂时故障且停止重发 | 保留原检查点，仅对新增且将移出窗口的内容做文字摘要 | 摘要模型，未指定时为压缩开始时的对话模型 |
| 模型不支持 V2，或 V2 已关闭 | Pi 原生压缩 | 摘要模型，未指定时为当前对话模型 |

压缩完成后继续原来的对话，当前对话模型和思考等级保持不变。V2 失败、改用独立摘要模型时，Pi 会显示提示及实际使用的模型。

例如，先用 V2 压缩出检查点 A，又完成了几轮工作。下一次 V2 遇到暂时故障时，摘要模型不会收到 A 的加密内容。回退成功后，同一后端的普通请求会依次重放 A、补充的文字摘要和仍保留的近期消息；后续 V2 也使用这段历史。没有新增内容需要摘要、后台身份或历史边界无法验证、遇到永久错误，或者文字摘要失败时，取消本次压缩，不替换已有检查点。

文字回退是本扩展有意保留的行为，与 Codex 客户端不同。Codex 在 V2 失败后直接报错，不改用文字摘要。本扩展沿用 Pi 的文字恢复策略，让 V2 不可用时压缩仍能完成：尚无检查点时改用 Pi 原生压缩；已有兼容检查点时只对可确认的暂时故障做分层恢复，其他失败取消压缩并保留原检查点。

分层回退生成的检查点需要本版或更新的插件才能完整重放。普通 V2 检查点仍使用原格式。主动关闭 V2 或选择不支持 V2 的模型时，仍走普通文字压缩，文字模型不能解读旧的加密历史。

`/compact` 后附加的要求（例如“重点保留尚未完成的任务”）只对 Pi 原生压缩生效。V2 不接受这些要求，扩展会提示它们被忽略。

### 请求失败与重试

V2 对一次完整的 SSE 请求及其响应收集进行有限重试，覆盖可确认的暂时 HTTP 错误、网络错误和有响应进展后提前结束的流。额外重试次数取 Pi 的 provider 重试设置与 2 的较小值；未设置时最多额外重试 2 次，总共最多 3 次请求，设置为 0 时不重试。每次重试使用同一份已准备的请求内容和同一后端，并重新通过 Pi 认证。

V2 采用 Codex 0.172.0 的 `Retry-After` 秒数和 HTTP 日期格式，也接受优先级更高的 Pi `retry-after-ms`。建议头仅接受可见 ASCII、空格和制表符。普通 HTTP 429 和明确的容量故障需要有效建议才会重发。流内已知限流码先读建议头，再读仅以 ASCII 空白为分隔的限流文案。HTTP 日期的等待不会因时钟采样间的暂停而缩短。真正由 `content_filter` 导致的 `response.incomplete` 可退避重试。

重试建议与 Codex 的表示差异包括 Fetch 合并重复 HTTP 头（Codex 取首值）、流内 JSON 数字形式的头值经 JavaScript 数字转换（例如 `0.0` 读为 `0`，超过 `2^53` 的整数会舍入），以及插件要求 RFC 850 日期的日期与时间之间使用空格。标准 `Retry-After` 秒数在 `2^63` 到 `2^64`（不含）之间按超出等待上限处理，不受操作系统影响。超出 `u64` 或无法表示截止时间的秒数视为缺少建议。Pi 的 `retry-after-ms` 数值溢出仍视为超出等待上限。

V2 只凭明确的暂时故障证据重发。HTTP 状态白名单优先服从永久 `error.code` 的否决，包括 `usage_limit_reached` 和 `usage_not_included`。HTTP 429 另外检查 `error.type` 中的用量或额度限制。`response.failed` 错误字段类型无效时按协议错误处理，保留旧检查点。未知错误码和限流字样本身不构成暂时故障证据。Pi 的适配器会在独立 `error` 帧提前结束读取，Codex 可跳过未识别的独立错误。无效压缩结果、重复输出、取消操作和会话变化也会阻止重发。HTTP 重定向沿用 provider 和 fetch 的处理方式。

Codex Responses 跳过空 `data:` 帧，V2 根据后续记录判断是否重试。标准 Responses 遇到空 `data:` 帧仍会报错。

建议等待超过上限、容量故障缺少建议或次数用尽时，已确认的暂时故障仍可使用上表中的分层恢复。

### 思考等级更新

Pi 的 `openai-responses` 适配器仅在模型声明 `compat.supportsMidConvoEffort`、请求有生效的思考等级且未使用 ChatGPT 登录时，才在输入中发送 `configuration_update`。Pi 会在同模型、有已记录等级的非空助手输出前插入对应的更新，并在输入末尾追加本次请求的等级更新。使用这种格式时，请求级 `reasoning.effort` 为 `medium`。`openai-codex-responses` 只设置请求级 effort。

Codex 用请求级 effort 记录当前窗口的基线，历史中只保留等级变化。压缩后第一条更新成为新基线并从历史中移除。V2 会省略紧邻压缩触发项之前的一串更新。

`Codex reasoning effort updates` 默认关闭。开启后，压缩扩展在重放检查点之后改写普通请求，并在发送 V2 请求（含重试）前应用同一套规则。

开启前请先卸载独立的 `@criogaid/pi-codex-reasoning-effort` 扩展。两者共存时，行为取决于加载顺序：

- 内置开关关闭、独立扩展后加载时，普通请求在快照采集之后被改写，V2 缺少这次改写。独立扩展先加载时，改写后的请求字段和历史可能进入快照，并被 V2 复用。
- 两者都开启时，后加载的独立扩展只有收到压缩扩展返回的同一个请求对象，才会通过共享标记跳过再次改写。中间的处理器若复制请求对象（例如 `{ ...payload, prompt_cache_key }`），不可枚举的标记会丢失，再次改写可能改变窗口基线。独立扩展先加载时，它也可能在重放检查点前就去重。例如，标记前的助手输出也记录了 `high` 时，提前去重可能省掉压缩窗口内首条 `high` 更新，使窗口基线变成后续的 `low`。

## 独立摘要模型

假设你平时用 `gpt-6-astra` 聊天，希望退回原生压缩时改用 `gpt-6.1-sol` 生成摘要：

1. 执行 `/codex-compaction` 打开设置菜单。
2. 在 `Summary model` 中选择 `gpt-6.1-sol` 及其思考等级。

之后的压缩过程如下：

- `gpt-6-astra` 支持 V2 时，仍由 `gpt-6-astra` 完成 V2 远程压缩，不经过 `gpt-6.1-sol`。
- V2 失败或不可用时，由 `gpt-6.1-sol` 生成文字摘要。
- 压缩结束后继续使用 `gpt-6-astra` 对话。

如果想始终用 `gpt-6.1-sol` 生成文字摘要，再关闭 `Remote Compaction V2`。

独立摘要模型的登录凭据沿用 Pi 的配置。选择虚拟模型时，Pi 按它的配置路由到实际发送请求的模型。

> [!IMPORTANT]
> 已指定的摘要模型不可用或请求失败时，本次压缩会停止，不会悄悄改用当前对话模型。摘要为空、生成被中断或因长度限制被截断时，也会停止压缩。

## 配置

### 设置菜单

执行 `/codex-compaction`：

| 设置 | 默认 | 用途 |
| --- | --- | --- |
| `Remote Compaction V2` | On | 是否优先尝试 V2 远程压缩 |
| `Codex reasoning effort updates` | Off | 是否按 Codex 的方式发送思考等级变化，见[思考等级更新](#思考等级更新) |
| `Summary model` | `Chat model` | 生成文字摘要的模型及其思考等级；`Chat model` 表示使用当前对话模型 |

- 终端菜单中按回车或空格切换开关，修改立即保存，光标停留在原来的行。选中一项时，列表下方会说明它的用途及与其他设置的关系。
- 模型可以按服务商（Provider）、ID 或名称搜索；取消选择不会保存。
- 在模型列表顶部选择 `Use the chat model` 可取消摘要模型，恢复使用当前对话模型。
- 通过 RPC 使用 Pi 的客户端会在选择框标题中看到何时使用文字摘要以及当前选用的模型，每次操作后退出菜单。

### 配置文件

设置保存在 `~/.pi/agent/extensions/pi-codex-compaction/config.json`。设置了 `PI_CODING_AGENT_DIR` 时，改用该目录下的 `extensions/pi-codex-compaction/config.json`。菜单会在保存时创建文件；非交互模式下可以直接编辑。

```json
{
  "version": 2,
  "remoteCompaction": {
    "enabled": true
  },
  "reasoningEffortUpdates": {
    "enabled": false
  },
  "summaryModel": {
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinkingLevel": "high"
  }
}
```

| 字段 | 对应菜单项 | 说明 |
| --- | --- | --- |
| `remoteCompaction.enabled` | `Remote Compaction V2` | 省略 `remoteCompaction` 时默认开启 |
| `reasoningEffortUpdates.enabled` | `Codex reasoning effort updates` | 普通请求和 V2 共用的开关，省略时默认关闭。读取时机见下方 |
| `summaryModel.provider`、`summaryModel.model`、`summaryModel.thinkingLevel` | `Summary model` | 使用 Pi 中的实际 ID 和该模型支持的思考等级；三项须同时提供 |

省略整个 `summaryModel` 表示使用当前对话模型生成文字摘要。V2 开关与摘要模型互不影响。

仍可读取 `"version": 1` 的旧配置：`fallback.enabled` 为 `true`（或省略）且填写了模型时按摘要模型处理，其余情况按未指定处理；下次通过菜单保存时改写为版本 2，已关闭的旧模型选择不会保留。配置文件不保存 API key，模型和认证须先在 Pi 中配置好。

<details>
<summary><strong>读取时机与校验规则</strong></summary>

- 配置文件须为 UTF-8 JSON，大小不超过 16 KiB。
- 每次压缩开始时读取 V2 开关和摘要模型的配置。
- 思考等级更新开关在会话开始时读取，包括启动、重载、新建、恢复和派生。SDK 未触发会话开始事件时，首次普通请求或压缩会初始化这个开关。直接编辑文件或由其他 Pi 进程保存的值，在下一次会话开始、首次初始化或本进程通过菜单保存时生效。之后开始的普通请求和压缩共用该值，进行中的压缩沿用启动时的值。
- 压缩时，配置文件无法读取、JSON 格式错误或开关设置无效会停止压缩。初始化思考等级更新开关时读取失败则使用 Off，有界面的会话会显示警告。
- `summaryModel` 只在需要原生压缩时校验，因此它填错不会影响成功的 V2 压缩。
- `summaryModel` 无效时菜单显示 `Invalid`。切换任一开关会保留已填写的内容。重新选择模型或 `Use the chat model` 即可修复。
- 多个 Pi 进程保存同一个配置时会互斥；同一旧版本只能有一个修改成功，其他菜单须重新打开。直接编辑文件时仍会在保存前检查版本；外部编辑器不参与 Pi 的保存锁。

</details>

## 自定义网关

模型是否尝试 V2 由 `compat.remoteCompaction` 决定：有配置时按配置判断；没有配置时，API 类型为 `openai-responses` 或 `openai-codex-responses` 且模型 ID 包含 `gpt`（不区分大小写）即尝试 V2。其他 API 的请求格式无法携带 V2 压缩，未配置时直接使用 Pi 原生压缩。服务商名称和是否使用官方地址不参与启用判断。显示名称不参与匹配。

显式配置须指定 `protocol: "v2"`，可同时指定 `endpoint`。协议或端点配置无效时不尝试 V2，也不会退回名称匹配。非 GPT 模型或需要覆盖端点时，可以在 Pi 的 `models.json` 中添加：

```json
{
  "providers": {
    "custom-codex": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-responses",
      "apiKey": "$CUSTOM_CODEX_API_KEY",
      "models": [
        {
          "id": "custom-model",
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

替换地址和模型 ID，并设置 `CUSTOM_CODEX_API_KEY` 环境变量。这个例子请求 `https://gateway.example.com/v1/responses`。

网关的压缩请求使用其他路径时，可以在 `remoteCompaction` 内增加 `endpoint`。它的协议、主机和端口须与 Pi 认证后实际使用的 `baseUrl` 一致，且不能包含用户名、密码、查询参数（`?`）或片段（`#`）。

V2 总开关仍决定是否发送新的远程压缩请求。模型名匹配只决定是否尝试；Pi 的适配器和网关仍须实际支持 V2，请求失败时退回 Pi 原生压缩。默认端点按 API 推导：`openai-codex-responses` 使用 Codex 路径，其他 API 使用 `/responses`。检查点继续绑定实际 provider、API 和端点，防止跨后端重放。

## 注意事项

- **V2 压缩结果绑定服务商。** V2 压缩后的旧记录以加密数据保存，扩展无法还原成文字。重新打开会话或创建分支时可以继续使用，但须保持服务商、API 类型和请求地址不变。换到其他后端后，扩展跳过加密历史，继续使用 Pi 可读取的摘要和近期消息。
- **同一服务内切换模型。** 扩展继续重放检查点，服务端决定新模型是否接受。模型切换本身不会触发压缩；后续 V2 使用当前对话模型，窗口容量由 Pi 和 provider 处理。普通请求的模型路由沿用 Pi 及其他扩展的处理结果。压缩进行中切换模型不会取消压缩，结果仍由开始时的模型生成并保存，与 Pi 原生压缩一致；如果新模型属于其他后端，扩展会提示新结果无法在当前后端重放。
- **关闭 V2 不影响已有记录的重放。** 已压缩记录仍可在原后端照常发送；下一次压缩按配置使用文字摘要。
- **关闭图片读取。** Pi 的 `images.blockImages` 设置也适用于检查点中保留的原始图片；普通重放和再次压缩都会用文字占位替换这些图片。已有保存记录不被修改，但关闭期间生成的新检查点会保留本次发送的占位符，之后重新开启读取不保证能恢复更早的原始图片。该设置不能删除已经包含在加密压缩结果中的图像信息。
- **上下文变换。** 本扩展不在 `context` 阶段改动消息，而是等所有扩展的 `context` 处理器执行完后，在 `context_with_system` 阶段替换检查点。其他扩展因此始终看到 Pi 原生消息，加载顺序不影响重放结果。请求快照分别记录持久化源历史与实际请求投影；其他扩展重排、过滤、改写消息或插入临时内容时，只要源历史不变，就可复用已观察到的前缀。若临时内容随后出现在持久化尾部，扩展重新构建请求，避免重复发送。检查点先与会话历史中的保留消息逐条精确校验；请求中由压缩摘要或保留消息变换而来的消息按角色、时间戳和工具调用 ID 对应回原消息，统一替换为一次加密历史，插入的临时内容和新消息保持原位。其他扩展删除压缩摘要，或某条消息无法确定属于已压缩部分还是新内容时，普通请求跳过加密历史，也不建立该次请求的复用快照。Pi 没有处理器优先级接口，之后执行的 `context_with_system` 处理器仍会看到私有标记；在标记前后添加或与之合并的内容会保留，只替换标记本身。
- **工具声明。** V2 保留工具声明、历史中的工具加载记录及实际调用与结果。符合快照条件时复用最近一次普通请求的声明；没有可用快照时，由 Pi 序列化会话中的工具元数据。Pi 未公开工具隐藏状态的修订号；只改变隐藏状态而其他公开设置未变时，旧快照仍可能被复用。
- **缓存复用。** 会话、模型、后端、历史前缀、工具和设置匹配时，压缩请求复用最近一次普通请求中观察到的完整前缀，包括中途工具加载和历史改写，再追加新增内容。快照后出现新的系统消息时，由 Pi 重新序列化完整输入、系统指令和工具。请求设置仍匹配时，缓存键、服务等级和思考参数等字段可继续复用。普通请求显式强制提示词时，V2 只折叠匹配的历史前缀，后续新增的系统消息保留原位。如果 `context` 处理器只在部分请求中让 Pi 折叠会话，V2 沿用上次观察到的投影，系统消息布局可能与下一次普通请求不同。没有采样到强制提示词时，如果观察到的请求只有一个系统头且与会话中保存的系统头相同，V2 无法从快照判断 `context` 处理器是否触发了折叠。若之后新增系统消息，V2 保留原系统头和新增消息的位置，Pi 的下一次普通请求则可能把新增内容合入开头。本轮结束后 Pi 回到基础提示词、本轮临时提示词结束，或只修改主题、思考块显示、终端和编辑器外观等界面设置，都不会使匹配的快照失效。真正的提示词或其他配置变化仍会使快照失效。随快照复用的字段还包括并行工具调用、输出格式、verbosity 及缓存模式/TTL，诊断响应 ID 和预热操作不被复制。普通请求依赖服务端会话引用时，仅复用独立参数，历史由 Pi 从本地上下文重建。服务端自行决定是否使用缓存，因此不保证命中或费用下降。
- **请求快照与扩展加载顺序。** 扩展在 Pi 的 `before_provider_request` 阶段记录普通请求，记下的是本扩展处理器执行那一刻的请求体。其他扩展也在这一阶段改写请求体（例如缓存键或指令）时，结果取决于 Pi 加载扩展的先后：先执行的改写会进入快照，并随前缀、缓存键和缓存模式等字段沿用到 V2 压缩请求；后执行的改写不进入快照，V2 请求沿用的前缀和缓存键可能与普通请求实际发送的内容不同，压缩请求因此可能无法命中普通请求的缓存。Pi 没有处理器优先级接口，也没有在所有处理器执行后观察最终请求的事件，扩展目前无法消除这一差异。

与 Codex 客户端的源码对照、已还原部分和差异见 [V2 实现对照](docs/verification/codex-v2-parity.md)。

## 开发

使用 Node 24 或更新版本，在仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

本地加载使用 `pi install .`。Pi 不会替本地包安装依赖，须先完成上面的安装步骤。

运行代码在 `src/`，入口为 `src/index.ts`，Pi 直接加载 TypeScript 源码；测试在 `tests/`，编译结果写入 Git 忽略的 `dist/`。打包检查同时验证发布文件清单和 Pi 的实际入口加载。[CI](.github/workflows/ci.yml) 在 Ubuntu 24.04 和 Windows 上使用 Node 24 执行验证。变更记录见 [CHANGELOG.md](CHANGELOG.md)，维护规则见 [AGENTS.md](AGENTS.md)。

<details>
<summary><strong>发布流程</strong></summary>

[Publish](.github/workflows/publish.yml) 在推送 `v*` 标签时运行。标签须与 `package.json` 的版本一致，例如版本 `0.5.2` 对应标签 `v0.5.2`。目前只发布正式版本，不接受 `-beta`、`-rc` 等预发布后缀。

首次发布前，在仓库的 **Settings → Secrets and variables → Actions** 中添加 `NPM_TOKEN`。按 [npm 文档](https://docs.npmjs.com/creating-and-viewing-access-tokens)创建 granular access token，授予 `@criogaid` 作用域的发布权限（Read and write / publish and stage），并启用 Bypass two-factor authentication。包创建后，可以将 token 权限缩小到该包。

准备版本时：

1. 运行 `npm version <版本号> --no-git-tag-version`，同步更新 `package.json` 和 `package-lock.json`。
2. 将 CHANGELOG 中“未发布”的改动整理到对应版本下。
3. 运行上面的验证命令，通过后提交。
4. 为该提交创建并推送 `v<版本号>` 标签。

工作流会核对版本，重新安装依赖，执行类型检查、测试和打包检查，全部通过后发布公开 npm 包，并附带可追溯到源码提交和工作流的来源证明（provenance）。普通分支推送不会发布；已发布的 npm 版本不能覆盖，后续修改须使用新版本号。

</details>

## 许可证

MIT，见 [LICENSE](LICENSE)。本仓库从 `Criogaid/pi-extensions-anthony` 提取并独立维护，实现基于 `@narumitw/pi-codex-compact`，保留 Narumi 和 Anthony 的署名。

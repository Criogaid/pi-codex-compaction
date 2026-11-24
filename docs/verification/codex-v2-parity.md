# Codex Remote Compaction V2 源码对照

> 上游引用固定到同一个发布提交。本扩展一栏描述当前实现，客户端回归使用真实 Pi 适配器和可控响应。

## 结论与审计边界

本扩展是在 Pi 上实现 **Codex Remote Compaction V2 请求与不透明结果重放协议**的适配器。它在正常 Responses 请求的输入末尾追加 `compaction_trigger`，收集完成事件前的唯一压缩项，按预算保留普通用户的文本和图片，并在后续请求中重放检查点。对应实现见 [上游请求构造][attempt]、[输出收集][collector]、[历史保留][retention]及本地 `remote.ts`、`protocol.ts`、`retention.ts`。

适配范围限于客户端可观察的请求、流和历史。Pi 负责认证、模型路由、会话事件及可选的文字摘要。服务端如何生成、加密和解释 `encrypted_content` 需要独立验证，摘要质量、模型兼容性、缓存命中、费用和延迟也需通过真实服务对照测量。

## 版本固定

| 对照对象 | 名称 | 固定 commit | 用途 |
| --- | --- | --- | --- |
| Codex 稳定版基线 | `rust-v0.172.0` | `3d86e43b075adeba2193ec5c22ac92f55afd82e6` | 核对 V2 协议、启用的默认行为和适配差异 |

GitHub 发布元数据的 `published_at` 为 **2026-11-24 00:03:55 UTC**，`prerelease: false`。附注标签对象 `fc3036dba44468096953f0e832f3fecd3adc0228` 指向表中的提交。[稳定版发布记录][stable-release]、[发布元数据][stable-release-metadata]、[标签对象][baseline-tag]。

## 逐项对照

| 范围 | Codex `rust-v0.172.0` | 本扩展 | 判断 |
| --- | --- | --- | --- |
| 启用条件 | `TokenBudget` 默认关闭。常规路径按 provider capability 选 V2 或本地压缩。配置型 provider 可覆盖能力，默认识别 OpenAI 和 Azure Responses，另有专用 provider 声明 V2。 | 显式 `compat.remoteCompaction` 优先，否则根据两个 Responses API 和模型 ID 的 `gpt` 子串判断。允许自定义 provider 和同源端点。 | Pi 使用自己的模型配置契约。 |
| 功能请求头 | 会话始终把 `remote_compaction_v2` 加入 beta feature 列表，旧配置项标为 Removed。 | 通过 Pi 的请求头变换器为压缩请求合并该标识，固定走 SSE。 | 标识相同，应用范围和传输策略各由宿主决定。 |
| 端点与 V2 触发 | 使用正常 Responses 路由，输入以 `CompactionTrigger` 结尾。 | 验证 Pi 的 Responses 端点或同源覆盖端点，展开唯一的旧检查点标记后追加末尾 trigger。 | 核心请求协议对应。 |
| 请求声明 | 非空基础指令作为 `input` 的 developer 前缀。增量工具模式读取历史里的工具声明，Responses Lite 将剩余声明放进 `input`，其他路由使用顶层 `tools`。 | Pi 负责序列化和认证。快照匹配时复用实际观察到的完整 wire 前缀、工具声明和缓存字段。 | 保留 Pi 普通请求的布局与顺序，包括适配器使用的顶层 `instructions`。 |
| 思考等级 | 支持的 OpenAI 模型默认可在窗口内固定原始 effort，并用 `configuration_update` 表达调整。压缩可复用仍受支持的 pin。 | 使用 Pi 当前 thinking level，匹配时复用观察到的 reasoning；请求级 effort 更新由 Pi 序列化。 | Codex 的窗口 pin 和 Pi 的请求快照各有生命周期。 |
| 压缩前容量裁剪 | 估算基础指令与历史，按模型的有效窗口从尾部替换连续工具输出。用户消息、函数输出和自定义工具输出才可携带尺寸提示，显式保留的条目可阻止裁剪。 | 使用请求模型窗口的 95%，估算并裁剪序列化后的历史，原样接回请求级尾部。按同样的来源规则配对尺寸提示。 | 裁剪范围和无元数据分组对应，Pi 的 95% 固定，Codex 可按模型调整。 |
| 文本与密文估算 | 普通文本每 4 个 UTF-8 字节估 1 token，向上取整。压缩密文每 12 字节估 1 token，向上取整。文本截断保留头尾。 | 同样估算 `compaction`、`compaction_summary` 和带密文的 `context_compaction`，`reasoning` 独立估算。文本截断保持 Unicode 字符边界。 | 都是客户端预算估值，实际 tokenizer 由模型服务决定。 |
| 图片预算 | 普通图片按 7,373 字节估计。原图探测尺寸，按 32px 方块计费，最多 10,000 个。原图文件引用取上限，探测失败取普通估值。使用 32 项 SHA-1 LRU。 | 采用相同估值常量和 LRU 容量，用 Pi 的 `resizeImage` 解码获取原图尺寸，并在单次请求内共享 URL 估值。 | 某些图片尺寸可读但像素解码失败，两端会取不同估值。 |
| 保留顺序与预算 | 按 64,000 token 预算从新向旧选组，恢复原序。媒体与相邻标签一起保留。存在待投递邮件时，摘要可插入其前。 | 对普通用户及 HookPrompt 组采用同一固定预算和文本、图片选择规则，检查点的替换历史以不透明压缩项结尾。 | 对应普通用户文本和图片，摘要位置由各自的历史模型决定。 |
| 特殊上下文与元数据 | 结合 contextual fragment、HookPrompt、AgentMessage、音频和来源元数据。默认允许符合条件的客户端工具输出跨窗口保留。 | 使用 Pi 消息来源与标记文本，剥离 skill 前缀，用 saxes 解析 HookPrompt。 | Pi 覆盖自己能表达的上下文子集，XML 接受范围有差异。 |
| 输出校验 | 收到首个 `Completed` 即结束收集，要求此前恰好一条 compaction 的 `OutputItemDone`。 | 首次成功完成决定结果，要求非空密文。仅 Pi Codex Responses 路径接受状态为 `completed` 的 `response.done`。 | 首次完成前的计数规则对应。Pi 对成功终态与密文另有约束。 |
| 重试与传输 | 前台按错误策略重试整次请求，每种传输最多额外 `min(provider stream retries, 2)` 次。可从 WebSocket 切换到 HTTPS，等待服务端截止时间后重置计数。 | 只走 SSE，最多额外 `min(Pi provider retries, 2)` 次，每次最多一次 fetch。按 HTTP 白名单及流内证据重发。 | 次数上限和主要等待规则对应，错误分类及传输边界见第 4 节。 |
| 失败与回退 | 特定换模型场景可用当前模型再尝试 V2。原生文字压缩由入口按能力选择，V2 失败返回错误。 | 无检查点时可交给 Pi 原生摘要。已有兼容检查点时，确认暂时故障后可保留加密项并生成增量文字摘要。 | 保留 Pi 的文字恢复策略。 |
| 不透明重放与模型兼容 | 持久化替换历史、响应 ID、模型 `comp_hash` 和窗口等元数据。 | v1 检查点绑定后端与保留消息的精确指纹。同后端可以切换模型，由服务端判定是否接受旧加密项。 | Codex 的模型兼容性校验超出 Pi 的后端绑定范围。 |
| 小窗口准备与检查 | 在已知 `comp_hash` 不同或降到更小窗口且预算不足时，可先用旧模型压缩。 | 被动切换模型，下一次 V2 选择启动压缩时的对话模型，普通请求窗口由 Pi 和 provider 处理。 | 两端对换模型和缩窗采用各自的会话流程。 |
| 生命周期、状态刷新与用量 | 有 PreCompact/PostCompact hooks。完整安装重建上下文、记录窗口与状态基线，重新估算活动用量。 | 通过 Pi 会话事件安装检查点，返回 Pi provider Usage 和 `tokensBefore`，对重放历史中的明文图片应用 Pi 设置。 | Pi 的事件、状态和统计口径由宿主定义。 |

## 1. V2 请求协议确实有直接移植依据

手动和自动压缩先检查默认关闭的 `TokenBudget`，再读取解析后的 provider capability。配置型 provider 支持显式 `v2` 或 `unsupported`，缺省时按 OpenAI 或 Azure Responses 判断，专用 GCP provider 声明 V2。[功能默认值][token-budget-feature]、[手动入口][task]、[自动入口][auto-task]、[配置型 provider][provider]、[GCP provider][gcp-provider]。

V2 先克隆并裁剪历史，再准备模型可见输入与工具，发送时追加 trigger，生成检查点的输入则排除 trigger。HTTP transport 使用 `POST /responses` 和 SSE。会话始终声明 `remote_compaction_v2`，Responses 请求用 `x-codex-beta-features` 传递该标识。[准备请求][attempt]、[追加与移除 trigger][trigger]、[HTTP 端点][endpoint]、[会话功能列表][session-header]、[请求头][client-header]。

插件在 Pi 的普通 Responses 请求形状上追加 V2 trigger，通过 Pi 注册器发送请求。文字回退走独立的 Pi 原生摘要路径。实现见 [remote.ts](../../src/remote.ts)、[protocol.ts](../../src/protocol.ts)、[fallback.ts](../../src/fallback.ts)。

## 2. 请求复用与工具声明的明确边界

Codex 用同一套客户端构造普通及 V2 请求。V2 根据原历史中有无工具声明选择基础指令，再根据投影后的 `additional_tools` 判断是否只保留 WebSearch 的声明。客户端把非空基础指令放入 developer 前缀，Lite 将非空工具声明放入 `input`，其他路由使用顶层 `tools`。缓存 key 可以由会话派生、由宿主指定或省略，请求可携带缓存 TTL。[V2 请求准备][attempt]、[Responses 序列化][client-request]、[缓存 key 策略][cache-key]。

插件按会话、模型、后端、源历史前缀、有效提示词、思考等级、工具及设置匹配快照。匹配时复用观察到的实际前缀，包括中途工具加载、隐藏工具投影、工具搜索与配对记录，以及 provider 钩子改写的历史。随后拼上 Pi 当次序列化的新增历史和请求级尾部，移除内部边界，检查点只展开一次。临时提示词恢复到其未改变的源提示词时也可匹配。没有快照时由 Pi 序列化，依赖服务端会话引用的快照只复用独立字段。[request-snapshot.ts](../../src/request-snapshot.ts)。

独立字段包括已观察到的 `prompt_cache_key`、`prompt_cache_options` 的模式与 TTL、`parallel_tool_calls` 和完整 `text`。Codex V2 的 `output_schema` 为 `None`，Pi 复用的 `text` 可以含 `format`。Pi 的工具选择仍由适配器决定。凭证、响应 ID、预热操作、旧输出上限和传输标志由当前请求单独决定。[Codex V2 Prompt][attempt]、[Codex 请求字段][client-request]。

Pi 在 context hook 之后应用隐藏工具投影，未公开可见性修订号。只改变隐藏状态且有效提示词、公开工具列表、选择和设置都保持一致时，旧快照仍可能复用。没有快照时，由会话声明序列化的工具也可能与普通请求的隐藏投影不同。后续扩展及模型服务仍可影响最终载荷和缓存命中。[request-snapshot.ts](../../src/request-snapshot.ts)。

Codex 默认开启 reasoning effort override，受 provider 和模型支持约束。压缩可以复用已有 pin，模型目录撤销对该 effort 的支持时跳过它，失败不改变 live pin。请求副本会过滤不支持的 `configuration_update`，支持时合并相邻更新并保留最后一项。Pi 按当前 thinking level 与匹配快照构造请求。[默认配置][token-budget-feature]、[支持条件][effort-support]、[压缩读取 pin][effort]、[请求副本处理][client-request]。

## 3. 历史裁剪和保留算法的对应范围

Codex 在投影历史、附加已执行工具调用和追加 trigger 之前，仅估算基础指令和历史。从尾部连续工具输出开始，函数与自定义工具输出替换为固定文案，工具搜索输出清空 `tools`，遇到独立非输出项或受保留策略保护的项停止。Pi 在序列化及检查点重放后以历史段执行相同方向的裁剪，再将已识别的请求级尾部原样接回，例如 Pi 本次附加的 `configuration_update`，最后追加 trigger。历史里的同类更新仍属于历史。Codex 默认有效窗口比例为 95%，可由模型调整，Pi 固定取准备请求的模型窗口的 95%。[上游请求顺序][attempt]、[裁剪算法][trim]、[窗口默认值][window-default]、[模型窗口计算][window]、[remote.ts](../../src/remote.ts)。

只有用户角色的消息、函数输出和自定义工具输出可与紧随其后的尺寸提示成组。裁剪输出时移除所属提示，搜索输出后的提示保持独立。Codex 还根据来源元数据将客户端创作或带显式保留策略的提示独立分组，并可配对显式保留的相邻调用与输出。Pi 用条目形状与标记文本识别提示，元数据规则限于 Codex。[上游分组][notice-groups]、[history-groups.ts](../../src/history-groups.ts)。

两端按条目内容估算 UTF-8 字节，每 4 字节向上取整为 1 token。`compaction`、它的别名 `compaction_summary` 和带密文的 `context_compaction` 单独按 `ceil(密文 UTF-8 字节数 / 12)` 估算。`reasoning` 密文仍先按 `max(floor(字节数 × 3 / 4) − 650, 0)` 估算可见字节。文本截断在字符边界保留头尾，省略标记另外计入输出。[条目估算][estimates]、[压缩密文公式][encrypted-estimate]、[压缩项别名][compaction-item]、[文本截断][text-budget]、[context-window.ts](../../src/context-window.ts)。

普通图片按 7,373 字节估算，约 1,844 token。`original` 图片按 32px 方块计费，最多 10,000 token，文件引用取上限。Codex 按字节识别格式并只读取尺寸，Pi 用 `resizeImage` 解码以取得尺寸，失败时两者均回退普通估值。因此，只有尺寸可读的图片可能在 Codex 得到原图估值，在 Pi 则走普通估值。两者跨请求缓存成功和失败的估值，使用 32 项 SHA-1 LRU，Pi 还在一次请求内共享 URL 估值。[图片常量与缓存][image-cache]、[上游尺寸探测与回退][image-estimates]、[image-budget.ts](../../src/image-budget.ts)。

保留算法在固定的 64,000 token 内从新向旧选择，再恢复原顺序。附属提示占用预算。边界文本可截断，含图片的边界消息从后向前选取，图片与相邻标签需一起放入，放不下的媒体会占据保留边界。Codex 默认启用 `compaction_image_budget` 和客户端工具输出保留，客户端 developer 消息保留默认关闭。Codex 还支持音频及基于来源的显式保留。Pi 采用普通用户文本、图片和 HookPrompt 的规则。[保留预算][retention-budget]、[选择算法][retention-selection]、[媒体保留][media-retention]、[功能默认值][features]、[retention.ts](../../src/retention.ts)。

Codex 将普通用户、已知上下文片段和 HookPrompt 分开识别。其 HookPrompt 使用 quick-xml 0.41.0 反序列化 `@hook_run_id` 和直接文本，拒绝空白 ID。Pi 的 saxes 解析接受范围有差异，例如某些带 XML 声明或 DOCTYPE 的输入在 Codex 可识别为 HookPrompt，在 Pi 会作为普通文本处理。[quick-xml 锁定版本][xml-version]、[XML 结构][hook-xml-fields]、[HookPrompt 解析][hook-xml]、[上下文分类][contextual]、[事件映射][event-mapping]、[retention-input.ts](../../src/retention-input.ts)。

Codex 对部分 AgentMessage 按作者、接收者、类型与 10,000 token 上限保留。还可参照之前普通推理已读的位置，把摘要插入第一条待投递邮件及后续输入之前。Pi 检查点的替换历史始终以不透明压缩项结尾。[AgentMessage 选择][client-retention]、[待投递邮件与摘要位置][pending-mail]、[checkpoint.ts](../../src/checkpoint.ts)。

## 4. 输出校验、重试与失败行为必须分别评价

Codex 在首个 `Completed` 停止收集，要求此前收到恰好一条 compaction 的 `OutputItemDone`。最终 `response.output` 不计入，`response.created` 也不重置计数。Pi 同样用首个成功完成及此前的条目决定结果，并要求密文非空。只有 `openai-codex-responses` 将显式成功的 `response.done` 归一化为 `response.completed`，Rust Codex 的 SSE 解析器跳过该别名。Rust Codex 可将 `response.incomplete` 的 `interrupted` 原因映射成 `Completed`，Pi 的 V2 安装要求成功终态，不接受 incomplete。[上游收集器][collector]、[上游事件解析][events]、[protocol.ts](../../src/protocol.ts)。

前台 V2 对建流和收流使用同一个重试循环，每种传输最多额外 `min(provider stream retries, 2)` 次。切换 WebSocket 到 HTTPS 时同样遵守服务端重试截止时间，切换后重置计数。Pi 固定 SSE，每次最多一次 fetch，provider 内部重试设置为 0。各次尝试独立收集输出，复用首次准备的请求体和后端，重新通过 Pi 认证并检查会话归属。重定向交给 provider 与 fetch。[Codex 重试循环][retry-loop]、[传输切换][retry-policy]、[remote.ts](../../src/remote.ts)。

普通 HTTP 429 和明确的 `server_is_overloaded`、`policy_capacity_unavailable` 容量故障需要有效的服务端建议才重发。Codex 从 `Retry-After` 解析整数秒或 HTTP 日期。`response.failed` 从 `response.error.headers` 取建议，独立容量错误优先取 `error.headers`，其次取事件顶层 `headers`。已知的流内限流码先读建议头，再尝试文案里的等待时间。真正的 `response.incomplete` 若原因为 `content_filter`，可按本地退避策略重试。[HTTP 错误转换][http-errors]、[流内错误与建议][stream-errors]、[Retry-After 解析][retry-after]、[重试分类][error-policy]、[SSE 事件分派][events]。

Pi 额外接受优先级更高的 `retry-after-ms`，使用先墙钟后单调钟的采样次序，建议等待高于 Pi 有效正数上限和 60 秒中的较小值时停止重发。本地退避只用于允许退避的错误。重复 HTTP 头、流内 JSON 数字、RFC 850 日期分隔符和超大秒数的表示差异见 [README 的重试说明](../../README.md#请求失败与重试)。[retry_after.rs][retry-after]、[remote-retry.ts](../../src/remote-retry.ts)。

Pi 对 HTTP 采用 `408`、`409`、`429`、`500`、`502`、`503`、`504` 状态白名单。永久 `error.code`（包括 `usage_limit_reached` 和 `usage_not_included`）可否决白名单，429 另查 `error.type` 的用量或配额限制，并尊重 `x-should-retry: false`。Codex 按错误映射和重试策略处理状态，其中部分永久码受状态约束。Codex 将结构合法的未知 `response.failed` 码归为通用可重试错误，Pi 要求已知暂时故障证据，拒绝把未知码、限流字样或畸形失败字段用作重试依据。Pi 还使用明确的网络错误码和有进展但缺少终止事件的 EOF 作为暂时证据，取消、会话变化和无效输出会终止尝试。[Codex 永久错误映射][terminal-errors]、[HTTP 错误转换][http-errors]、[流内错误映射][stream-errors]、[Codex 重试分类][error-policy]、[remote-retry.ts](../../src/remote-retry.ts)。

Pi 的两个适配器都可能在独立 `error` 帧停止，扩展按实际终止的记录判断。Rust Codex 跳过未识别的独立错误，继续读后续记录。Pi Codex Responses 适配器跳过空 `data:`，标准 Responses 的 SDK 会把空数据当作 JSON 解析错误。[独立错误分派][standalone-error]、[SSE 读取][sse-reader]、[README 的适配器说明](../../README.md#请求失败与重试)。

Codex 入口按 capability 选择本地或 V2 压缩。V2 失败时，特定场景可切换到当前模型继续尝试 V2，失败路径返回错误。Pi 有意保留文字回退：当前会话在没有检查点时可调用原生摘要，已有兼容检查点时只对已确认的暂时故障做分层恢复。分层保留旧密文，文字摘要只读取本次移出的明文。关闭 V2 或模型不支持时也使用原生文字压缩。会话变化会丢弃旧请求结果，仅切换模型时则完成已启动的压缩。安装后若当前后端不兼容，扩展提示无法重放。[Codex 模式选择][task]、[模型回退][fallback-v2]、[index.ts](../../src/index.ts)。

## 5. 后端身份、comp_hash 与持久化并不等价

插件以 provider、API、认证解析后的 base URL 和 endpoint 绑定 v1 检查点，并精确校验保留消息指纹。重放还要求请求包含可唯一定位的压缩摘要和可验证的消息来源。条件不符时，普通请求继续使用 Pi 可读取的上下文。插件的模型切换流程保持被动，普通 payload 路由仍由 Pi 负责。[capability.ts](../../src/capability.ts)、[checkpoint.ts](../../src/checkpoint.ts)。

Codex 另存压缩响应 ID、`compaction_model_hash`、窗口和状态等信息。两个已知 `comp_hash` 不同，或降到更小模型窗口且预算不足时，Codex 可先用旧模型压缩。Guardian 等特定消费者还校验 producer/reviewer hash。Pi 的同后端重放资格以客户端后端身份为依据，由服务端判定旧密文能否跨模型使用。[历史安装元数据][installation]、[切换模型与缩窗][model-switch]、[检查点 hash 校验][checkpoint-hash]。

## 6. 钩子、上下文刷新和 usage

Codex 先执行 PreCompact，再执行压缩和安装，成功后执行 PostCompact。PostCompact 仍可停止该轮，已安装的历史保持生效。完整替换使用 replacement step 与 world state 重建窗口前缀和上下文，恢复活跃的额外上下文，并保留压缩快照之后的目标编辑。收集器在决定压缩项能否安装之前记录已消费的用量，也处理 incomplete 用量。[压缩钩子][hooks]、[上下文重建][initial-context]、[历史安装][install]、[流用量结算][collector]。

Codex 还提供默认关闭的后台推测压缩。候选安装会验证模型、窗口前缀与认证归属，再拼接实时后缀。Pi 通过 `session_before_compact` 接入当前会话的前台流程，使用 Pi 系统声明和检查点，返回 provider Usage 与 `preparation.tokensBefore`。[功能默认值][features]、[后台候选安装][background-install]、[前缀归属与拼接][prefix-replacement]、[index.ts](../../src/index.ts)。

Pi 的图片阻止设置作用于新鲜上下文和检查点重放中的明文图片。保存记录保持原样，关闭图片读取期间成功生成的新检查点可保留发送过的占位符。设置的作用范围限于客户端可见的图片内容。[protocol.ts](../../src/protocol.ts)。

## 7. 可以和不可以作出的声明

可以说本扩展使用基线版本的 V2 trigger 和不透明结果协议，移植普通用户文本、图片保留规则，并结合 Pi 的认证、事件、历史和缓存字段实现重放。快照满足约束时复用普通请求中观察到的工具声明和历史前缀。

完整运行时对齐和服务端效果需要各自的证据。这里的源码及离线测试仅覆盖列出的客户端规则和 Pi 适配边界。线上比较需固定服务端与模型版本、输入及工具状态。

## 8. 验证与复现边界

测试通过真实的 Pi 会话、模型注册器和 provider 适配器构造请求，模型响应使用可控 fixture。配置竞争使用独立 Node 子进程，重定向使用本机 HTTP 服务。

| 范围 | 关键回归场景 |
| --- | --- |
| 历史裁剪和保留 | 压缩项密文估算、尺寸提示来源、带与不带可复用前缀的请求级尾部，以及文本、图片的预算边界。 |
| 工具声明与请求前缀 | 两种 Responses API 下复用完整 wire 前缀，包括临时提示词、中途隐藏工具、历史投影、缓存字段及单次检查点展开。 |
| 终止与重试 | 首次完成时检查唯一压缩项，覆盖 Codex 适配器的成功别名、服务端重试建议、暂时错误、永久错误、取消及固定请求体和后端。 |
| 文字回退与检查点 | 普通文字回退、兼容暂时故障的分层恢复、图片阻止与跨后端降级。 |
| 会话与配置 | 被动换模型、会话归属和配置跨进程竞争。 |

开发和测试使用锁文件中的 Pi 1.5.0。最低支持版本见[安装说明](../../README.md#安装)。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

[stable-release]: https://github.com/openai/codex/releases/tag/rust-v0.172.0
[stable-release-metadata]: https://api.github.com/repos/openai/codex/releases/456141969
[baseline-tag]: https://api.github.com/repos/openai/codex/git/tags/fc3036dba44468096953f0e832f3fecd3adc0228
[provider]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/model-provider/src/capabilities.rs#L33-L55
[gcp-provider]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/model-provider/src/gcp/mod.rs#L81-L93
[attempt]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_attempt.rs#L98-L199
[trigger]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_attempt.rs#L224-L281
[endpoint]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/endpoint/responses.rs#L165-L196
[session-header]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/mod.rs#L1445-L1457
[client-header]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/client.rs#L2957-L2978
[features]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/features/src/lib.rs#L2491-L2527
[token-budget-feature]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/features/src/lib.rs#L2323-L2346
[client-request]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/client.rs#L1250-L1395
[cache-key]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/client.rs#L789-L797
[effort-support]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/client.rs#L737-L741
[effort]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/reasoning_effort.rs#L94-L144
[notice-groups]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_history.rs#L54-L109
[trim]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_history.rs#L111-L225
[window-default]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/openai_models.rs#L414-L416
[window]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/openai_models.rs#L576-L582
[text-budget]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/utils/output-truncation/src/lib.rs#L42-L104
[estimates]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/context_manager/history.rs#L1347-L1451
[encrypted-estimate]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/protocol.rs#L3841-L3852
[compaction-item]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/models.rs#L1397-L1415
[image-cache]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/context_manager/history.rs#L1377-L1398
[image-estimates]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/context_manager/history.rs#L1561-L1623
[retention]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L557-L601
[retention-budget]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L98-L101
[retention-selection]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L725-L862
[client-retention]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L618-L678
[media-retention]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_media.rs#L19-L103
[pending-mail]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_pending_input.rs#L1-L49
[xml-version]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/Cargo.lock#L12618-L12626
[hook-xml-fields]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/items.rs#L132-L140
[hook-xml]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/items.rs#L811-L819
[contextual]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/context/contextual_user_message.rs#L82-L124
[event-mapping]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/event_mapping.rs#L178-L206
[collector]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L438-L555
[events]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/sse/responses.rs#L459-L555
[standalone-error]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/sse/responses.rs#L399-L410
[sse-reader]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/sse/responses.rs#L635-L706
[retry-loop]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L355-L436
[retry-policy]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/responses_retry.rs#L134-L183
[error-policy]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/protocol/src/error.rs#L481-L557
[http-errors]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/api_bridge.rs#L133-L282
[terminal-errors]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/error.rs#L95-L201
[stream-errors]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/codex-api/src/sse/responses_error.rs#L12-L123
[retry-after]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/http-client/src/retry_after.rs#L13-L38
[task]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/tasks/compact.rs#L52-L105
[auto-task]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/turn.rs#L1834-L1915
[fallback-v2]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_installation.rs#L129-L182
[hooks]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2.rs#L188-L271
[initial-context]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact.rs#L89-L121
[installation]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_installation.rs#L218-L309
[background-install]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/compact_remote_v2_installation.rs#L80-L99
[prefix-replacement]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/compaction_replacement.rs#L37-L100
[install]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/mod.rs#L4966-L5084
[model-switch]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/turn.rs#L1700-L1790
[checkpoint-hash]: https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/history/src/compaction_checkpoint.rs#L14-L56

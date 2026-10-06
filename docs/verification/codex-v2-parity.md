# Codex Remote Compaction V2 源码对照

> 审计基于本扩展 `0.4.1` 的 commit `17365cbf69a36b0b4b0cd41fae6e3995414afba1`、第一轮安全修复及第二轮重试/模型切换补丁。上游引用固定到先前已核对的 commit，以下区分原有行为和两轮补丁后的行为。本次验证未调用真实模型服务；上游版本查询时间不因本文更新而改变。

## 结论与审计边界

本扩展实现了 **Codex Remote Compaction V2 的请求与不透明结果重放协议，并把 Codex 面向普通用户消息的文本、图片保留算法移植到 Pi**。这具有真实源码依据：它在正常 Responses 请求的历史末尾加入 `compaction_trigger`，收集唯一的 compaction 输出项，把预算内的用户历史放在新的不透明项之前，并在后续请求中恢复这份历史。[上游请求构造][attempt]、[输出收集和历史安装][v2]与本扩展的 `remote.ts`、`protocol.ts`、`retention.ts` 可以逐项对应。

第二轮补丁进一步加入整次 SSE 请求重试、显式模型兼容性元数据，以及通过 Pi 公共 API 完成的小窗口准备与容量保护。它们补齐了先前对照中的部分差异，但“完全复刻 Codex”仍超出了可证实范围。Pi 不会自动提供 Codex 的服务端 `comp_hash`；WebSocket 切换、窗口状态、工具与权限状态刷新、生命周期钩子、多智能体元数据和统计流程也没有被整体移植。服务端怎样生成、加密和解释 `encrypted_content` 不在本次可见的客户端源码和离线测试范围内。不能由协议相同推导出摘要内容、长期记忆质量、缓存命中、费用或延迟相同。

更准确的项目描述是：**采用 Codex Remote Compaction V2 协议、移植其主要历史保留规则的 Pi 适配器**。

## 版本固定

查询时间：**2026-10-06 13:28:50 UTC**。对照官方 `openai/codex` 的源码、分支与发布记录，annotated tag 已解析到对应 commit。

| 对照对象 | 名称 | 固定 commit | 用途 |
| --- | --- | --- | --- |
| 本扩展声明基线 | `rust-v0.159.2` | `ff6aec96948b70d94983af2641a6b67c94faeff5` | 判断声明的移植对象 |
| 查询时最新稳定版 | `rust-v0.160.1` | `d27764b82f7118f674371e6d6e76271d9d606edb` | 排除只对旧版本成立的结论 |
| 查询时默认分支 | `main` | `c0c230e6730b3b3c9101b8aff4b9aea4027cea5b` | 检查尚未稳定发布的相关变化 |

稳定版发布于 **2026-10-05 18:29:37 UTC**，`prerelease: false`。[稳定版发布记录][stable-release]、[发布元数据][stable-release-metadata]。基线与稳定版的 annotated tag 分别解析到上表 commit，见 [基线 tag 对象][baseline-tag]和[稳定版 tag 对象][stable-tag]。2026-10-06 13:43:24 UTC 再次核对时，最新稳定版仍为 `rust-v0.160.1`；main 保留初次查询时固定的 commit，三个引用不能混作同一个版本。

## 逐项对照

| 范围 | Codex `rust-v0.159.2` | 本扩展及两轮补丁 | 判断 |
| --- | --- | --- | --- |
| 启用条件 | 默认关闭 TokenBudget 的通常路径按 provider capability 选择 V2/local；配置型 provider 的 OpenAI、识别为 Azure Responses 的 provider 支持 V2。这里没有模型 ID 包含 `gpt` 的规则。 | 显式 `compat.remoteCompaction` 优先；否则按两个 Responses API 和 `gpt` 子串决定是否尝试；允许自定义 provider 和同源端点。 | 有意扩展的 Pi 启用策略，不能说复制了原生模型门控。 |
| 功能请求头 | 会话构造时无条件把 `remote_compaction_v2` 加入 beta feature 列表，正常 Responses 传输使用这份列表；配置中的旧 feature 开关已经移除。 | 通过 Pi 请求头变换器为压缩请求合并该 feature，固定 SSE，避免 Pi 既有 WebSocket 握手缺少新头。 | 压缩请求携带同一标识；头的生命周期和传输策略不同。 |
| 端点与 V2 触发 | provider 的正常 `/responses` 路由；在输入末尾附加 `CompactionTrigger`。 | 根据 Pi API 推导正常 Responses/Codex Responses 地址，可同源覆盖；精确替换旧 checkpoint marker 后，追加唯一末尾 trigger。 | 核心 V2 形状一致；不是单独调用 `/responses/compact` 的实现。 |
| 请求声明 | 从冻结的 step/tool router 取得模型可见工具与基础指令；走正常 ModelClient，沿用 reasoning、service tier、prompt cache key 等构造。 | 由 Pi ModelRegistry 序列化与认证，按会话、模型、后端、历史前缀及当前设置约束快照复用；内部保留历史工具序列化所需元数据，但所有 V2 最终请求都移除结构化工具声明。 | 核心请求字段仍可条件复用；工具声明路径有明确差异，不能承诺工具前缀或缓存一致。 |
| 思考等级 | `reasoning_effort_for_request(..., Compaction)` 可复用该窗口已经固定的原始 effort；失败不改变 live pin。 | 使用 Pi 当前 thinking level；满足条件时复用观察到的 reasoning 字段。Pi 没有移植 Codex 的 configuration-update/effort-pin 状态机。 | 普通情况相近；动态 effort override 状态机不同。 |
| 压缩前容量裁剪 | 粗估模型可见内容，计入基础指令；从末尾开始替换工具输出，删掉附属 resize notice；遇到非输出项停止。有效窗口百分比默认 95，来自模型配置。 | 相同方向、替换文案、停止条件、notice 分组和主要估算项；直接采用 Pi `contextWindow × 95%`。 | 支持的 Pi 数据子集内移植程度高；95% 为固定默认，未读取 Codex 模型专有调整。 |
| 文本估算与截断 | UTF-8 字节数除以 4 向上取整；保留头尾、删除中间，加入省略标记。 | 采用同一估算和中间截断策略，避免切断 Unicode 字符。 | 对正常有效文本可直接对应；这是启发式预算，不是真实 tokenizer。 |
| 图片预算 | 普通图片按 7,373 字节估计；original detail 按 32px patches，最多 10,000；original 文件引用取上限，解码失败回退普通估值；跨请求 32 项 SHA-1 LRU 缓存。 | 常量、规则和 32 项跨请求 LRU 策略相同，图片解码通过 Pi 的 `resizeImage`，另外在一次请求内复用 URL 估值。 | 主要估算与缓存策略对应；解码器、格式支持和并发初始化机制不保证完全相同。 |
| 保留顺序与预算 | 普通用户/HookPrompt 组在固定 64,000 token 预算内从新向旧选择，最终恢复原顺序，最后追加新 compaction 项；图片边界与标签原子保留。 | 默认采用同样预算和选择规则；第二轮仅在小窗口准备时允许降低明文预算，最低可只保留新 opaque 项。 | 默认核心算法对应；小窗口降低预算是额外的 Pi 容量保护。 |
| 特殊上下文与元数据 | 通过 Codex context fragment 与 HookPrompt 解析判断；还有 `AgentMessage`、来源与权限元数据，以及可选的 client-authored developer retention。 | 标记文本启发式加 Pi 消息来源映射；剥离 Pi skill 前缀；只有普通用户消息保留路径，未移植完整 AgentMessage/来源元数据系统。XML 解析使用 saxes，源码列出与 quick-xml 的差异。 | 只覆盖 Pi 可表达子集，存在明示的解析差异。 |
| 输出校验 | 消费输出项完成事件，必须恰好一项 compaction，再收到 completed；其他输出项可忽略，不能把最终 response.output 再计数一次。 | 相同计数原则，验证非空 encrypted_content，支持 compaction_summary 别名。本轮修复额外适配 Pi Codex raw event 的成功 response.done 别名。 | 核心不变量一致；response.done 是 Pi 边界兼容扩展。 |
| 重试与传输 | 对可重试错误，每种传输最多额外重试 `min(provider stream retry, 2)` 次，覆盖建流和收流失败；WebSocket 重试耗尽后可切到 HTTP 并重置计数。 | 第二轮以外层循环覆盖整次 SSE 请求和收流，额外次数取 Pi 配置与 2 的较小值，内层 HTTP 重试为 0；请求体和后端固定，暂时错误需有明确证据。 | SSE 分支的尝试边界和总预算已补齐；未实现 WebSocket→HTTP 切换及计数重置，错误分类仍是 Pi 适配。 |
| 失败与回退 | V2 失败不会改走本地文字摘要；特定换模型场景可换当前模型继续尝试 V2。请求未成功时不安装新历史。 | 原实现对未取消且仍属当前会话的 V2 错误进入 Pi 文字回退。本轮修复：存在 opaque checkpoint 时取消并保留旧 checkpoint；没有 opaque checkpoint 时仍支持 Pi 文字回退。 | 修复恢复关键的“无法读旧记录时不覆盖它”约束；首次文字回退仍是扩展产品行为。 |
| Opaque 重放与模型兼容 | 持久化 replacement history、compaction response ID、模型 comp_hash、窗口/来源信息；hash 变化或模型窗口缩小时可先用旧模型再压缩。 | v1 检查点可保存创建模型的有效窗口及显式 `compactionModelHash`；已知 hash/后端冲突停止请求，同后端跨模型缺少可比较 hash 时提示未知并允许继续。 | 增加了兼容性证据区分；显式配置不是自动取得的 Codex comp_hash，未知仍不构成兼容证明。 |
| 小窗口准备与检查 | 原模型和目标模型、压缩触发原因、模型窗口及历史预算共同参与换模型准备流程。 | 空闲 `model_select` 可用同后端的上一/创建模型先做 V2；按目标完整帧估算降低明文保留，保留实际 producer 身份，并在普通请求展开后再检查容量。 | 通过 Pi 公共 API 实现保守准备；后选择事件、启发式预算及已知 hash 冲突停止策略不能视为 Codex 状态机复刻。 |
| 生命周期、状态刷新与用量 | 执行 PreCompact/PostCompact hooks；成功后更新窗口，按注入模式插入上下文或延后重建，保存或保留 world-state baseline，重置 reasoning pin，并重新估计 active usage、记录 telemetry。 | 接入 Pi `session_before_compact` 等事件；使用 Pi 的系统声明与 checkpoint；返回 Pi provider Usage/原 tokensBefore。本轮修复应用 Pi 图片阻止设置到 opaque history 的明文图片部分。 | Pi 生命周期适配，不具备 Codex 全量状态刷新、钩子语义或统计口径。 |

各项证据与重要限制如下。

## 1. V2 请求协议确实有直接移植依据

上游 capability 对 V2 的定义就是“在 Responses endpoint 上发送 compaction_trigger”，见 [provider.rs 37–67][provider-definition]；配置 provider 的判断见 [provider.rs 421–433][provider]。默认关闭 `TokenBudget` 的通常压缩路径按这一能力选择 V2/local；启用该实验开关时，手动和自动压缩会先进入专用流程，见 [默认设置][token-budget-feature]、[手动选择路径][task]和[自动选择路径][auto-task]。构造 V2 请求时先克隆历史、裁剪工具输出、准备可见输入与工具，然后 `input.push(ResponseItem::CompactionTrigger {})`，见 [compact_remote_v2_attempt.rs 38–87][attempt]。HTTP transport 使用 `POST /responses` 和 SSE，见 [endpoint/responses.rs 123–149][endpoint]。

因此，本扩展的 trigger、输出项收集和 opaque 重放属于 V2 对接；不能仅因为使用一个独立的摘要模型，就把文字压缩算作 V2。`fallback.ts` 调用 Pi 原生摘要是另一种机制，应保持明确的模式说明。

功能头的依据是 [session/mod.rs 1178–1196][session-header]，实际 Responses header 写入见 [client.rs 2311–2335][client-header]。基线的旧 `remote_compaction_v2` 配置项虽标为 Removed，并不代表 V2 关闭；通常路径已经按 provider capability 选择压缩机制，header 仍无条件携带 V2 标识。[features.rs 1836–1853][features]

## 2. 请求复用与工具声明的明确边界

上游正常 client 统一构造 instructions、工具、tool_choice、parallel_tool_calls、reasoning、service_tier、prompt_cache_key、text 等字段，见 [client.rs 884–1008][client-request]。压缩取得冻结 step 的 tool router，并复用 ModelClientSession；自动压缩可沿用当前会话的连接与路由状态。[请求构造][attempt]

插件采用 Pi 的模型注册器，保留 Pi 的认证与序列化职责，并在会话、模型、后端、历史前缀、提示词、工具配置及设置满足约束时复用已观察的非工具请求字段。这不能导出 Codex 完整的工具路由、namespace、executed-tool metadata、环境/权限 contributor 或 MCP attribution。

**修复后的所有 V2 最终请求都移除结构化工具声明，即使之前已经观察过普通请求的可见工具。** Pi 在 context hook 之后应用隐藏工具投影；只改变隐藏状态时，扩展能读取的公共工具列表和选择状态可能保持不变。因而“最近一次普通请求里可见”不能证明“现在仍可见”，现有 API 也没有提供可靠的最终投影或可见性修订号。本轮复现了这一动态边界，未继续采用按历史观察结果选择性放行 schema 的方案。

插件内部仍保留 `Context.tools` 和系统工具元数据，用于正确识别与序列化历史 custom-tool 调用及结果；在快照复用和旧 checkpoint 展开完成后，统一移除最终 V2 payload 顶层的 `tools` 和 `tool_choice`，删除输入中的 `additional_tools` 声明项及 Pi 生成的 `pi_tool_load_` 工具加载搜索配对。真实历史中的 tool search 调用和结果继续保留，但其中的 `tools` 数组清空；普通及 custom-tool 调用、结果继续保留。普通请求仍按 Pi 自身的可见性流程处理。

这使 V2 请求的工具前缀明确不同于普通请求，也不同于基线 Codex 从冻结 tool router 取得完整可见工具声明的方式。**本扩展暂不具备工具声明前缀或相应缓存复用的一致性保证**；保留相同 `prompt_cache_key` 也不能推出相同缓存命中。恢复这一能力需要 Pi 提供可验证的当前工具投影或修订 API；本次没有用真实服务测量省略声明对摘要、缓存或费用的影响。

思考等级也是一个实质边界：Codex 在窗口内可以固定原始 effort，后续变化由 configuration update 表达；压缩读取原先的 pin，而不提前改变它。[reasoning_effort.rs 93–135][effort] Pi 当前 thinking level 和条件成立时的 reasoning 快照复用不能替代整个状态机。

## 3. 历史裁剪和保留算法的对应范围

裁剪函数只处理末尾连续工具输出组，不是任意删除最老消息；工具输出与紧随其后的 resize notice 成组，替换输出时移除 notice。[compact_remote_history.rs 27–130][trim] 有效窗口的 95% 是 Codex 默认值，模型可声明别的百分比；插件固定复用了默认值。数值见 [openai_models.rs 389–391][window-default]，模型字段和计算见 [openai_models.rs 463–522][window]。

文本估算与中间截断见 [output-truncation/lib.rs][text-budget]；模型可见 item 的字节估算和图片规则见 [context_manager/history.rs 1023–1304][estimates]。7,373 字节对应向上取整后的 1,844 个估计 token；original 图片估值最多 10,000 个估计 token。上游跨请求缓存采用 SHA-1 keyed、32 项 LRU，通过 `OnceLock<Option<i64>>` 同时保存成功与失败估值；插件移植了 32 项 LRU 策略，并额外使用请求内 URL 查找表，但使用 Pi 的图片解码器。[图片常量与缓存][image-cache]、[图片解码与回退][image-estimates]。这些图片缓存服务于本地尺寸估算，与 Responses prompt cache 不同；估值也是客户端容量启发式，不能直接用于承诺实际账单或视觉质量。

64,000 token 预算定义见 [compact_remote_v2.rs 75–79][v2-constants]；选择次序、附属 notice 的费用、边界截断和最后添加 compaction 的逻辑分别见 [compact_remote_v2.rs 504–532、620–752][v2]、[compact_remote_v2_images.rs 31–104][image-retention]。插件对应的是启用 `CompactionImageBudget` 的默认路径；基线的 client-authored developer retention 默认关闭，见 [features.rs 1836–1853][features]。

第二轮在 [retention.ts](../../src/retention.ts) 增加可选的较小明文预算，默认值与 64,000 上限不变，仅由小窗口准备路径传入。预算为 0 时返回新 opaque 项；负数、非整数及非有限值拒绝处理。降低预算仍保持从新向旧选择、恢复原顺序、图片与标签原子保留、Unicode 边界和不修改来源消息。截断文案与请求结构也占空间，因此准备流程还会用完整帧重新估算，不能把保留预算本身解释为完整请求的上限。

“保留用户消息”也不是简单的 role 判断。Codex 使用 [contextual_user_message.rs 23–120][contextual] 及 [event_mapping.rs 101 起][event-mapping]；插件用 Pi 的消息来源补偿 bash/隐藏 custom 消息，并以文本标记近似上下文分类。它还用 saxes 近似 quick-xml HookPrompt；部分 XML 输入（例如声明、DOCTYPE、某些命名空间/不规范字符）行为有明示差异。其 `retention-input.ts` 已有差异注释，测试只覆盖列出的样例，不能声称两个 XML parser 等价。

Codex 还会按作者/接收者关系、消息类型和 10,000 token 上限保留部分 AgentMessage，见 [上限常量][v2-constants]及 [compact_remote_v2.rs 555–583][v2]。插件没有对应的 Codex AgentMessage 数据模型；这属于尚未移植的功能域，不应被普通 user-history 测试覆盖率掩盖。

## 4. 输出校验、重试与失败行为必须分别评价

上游收集器在收到 completed 后要求 **恰好一条** compaction 的 OutputItemDone；最终 response.output 不会再作为另一份输出来源。[compact_remote_v2.rs 440–501][collector] 插件保留了这个关键约束。本轮 `response.done` 修复源自 Pi Codex adapter 在 raw observer 之后才规范化成功事件；它是对 Pi provider 合同的适配，不能倒过来说上游 Codex 自身以 response.done 作为 V2 必需事件。

上游重试包住整个“发起请求 + 收集流”过程，仅对可重试错误执行重试，每种传输最多额外重试 `min(provider stream retry, 2)` 次；这里的 2 不是请求总次数。常量见 [compact_remote_v2.rs 75–79][v2-constants]；[请求循环][retry-loop]和[重试策略][retry-policy]还处理 WebSocket 到 HTTP 的切换，并在切换成功后重置重试计数。普通重试会等待 server retry advice 指定的时间或本地 backoff；但 WS→HTTPS 切换的首次请求尚未等待该建议，源码 L98 对此留有 TODO。

第一轮审计时，插件只是把 Pi provider 的请求级 `maxRetries` 限制为 2。离线复现显示，成功 HTTP response 的 SSE 在终止事件前断开时仍只 fetch 一次。**第二轮已改为整个 V2 attempt 的外层重试**，见 [remote.ts](../../src/remote.ts) 和 [remote-retry.ts](../../src/remote-retry.ts)：默认最多额外 2 次，Pi 配置较小时按较小值；provider 内层 `maxRetries` 固定为 0，每次 attempt 最多一次 fetch，避免重试层数相乘。

每次 attempt 使用独立输出收集器。首次准备完成后固定请求体、输入估值、后端及 Pi 实际解析出的模型窗口/兼容标识，后续重新认证并复核这些信息及会话/所选模型归属，不把失败 attempt 的半成品或下一次序列化差异混入结果。实际发送层设置 `redirect: "error"`，防止自动重定向绕过端点检查。成功仍要求完整终止事件及唯一有效 compaction 项；新检查点的模型元数据来自实际准备请求的模型，配置和旧检查点中已知的标识与它冲突时在发送前拒绝。

可重试证据在 Pi 将错误简化为字符串之前收集，包括明确的暂时 HTTP 状态、白名单网络错误码、显式暂时服务端错误码，以及已经出现 Responses 进展后尚未收到终止事件的 EOF。权限、额度耗尽、内容/上下文限制等永久错误，冲突或畸形错误字段、无效完整 SSE 帧、重复/无效 compaction 输出、取消和后端漂移会阻止重试；不能只凭错误消息包含某个词就重试。SSE 旁路观察只负责分类证据，输出校验仍由收集器完成。

等待遵循可用的 `Retry-After`、`retry-after-ms`，或明确 rate-limit 错误中的受支持等待提示；没有提示时采用本地退避。单次等待上限为 Pi 的有效正数上限与 60 秒的较小值；要求等待超过上限时停止，不提前重发。这里仍固定 SSE，**没有实现 Codex 的 WebSocket→HTTP 切换、切换后的预算重置或完整 ResponsesRetryPolicy 状态机**。新增测试检查的是列出的 Pi transport/error 边界，不能据此声称所有线上故障行为等同。

原实现会将未取消、仍属当前会话的 V2 错误转到 Pi 文字回退，这不同于 Codex。上游 [tasks/compact.rs 35–74][task] 在 TokenBudget 专用分支之后根据 capability 选择 V2 或 local；V2 内部仅在特定旧模型→当前模型场景继续尝试 V2，失败返回，见 [compact_remote_v2.rs 253–294][fallback-v2]，没有把它转成文字摘要。

第一轮增加了已有 opaque checkpoint 的保护：文字摘要模型无法解读已存在的 encrypted_content，因而在 V2 失败、关闭或不适用时继续覆盖 checkpoint 会丢弃不可重建的信息。修复后会取消这次压缩并保留原 checkpoint；没有 opaque checkpoint 时，Pi 文字回退仍作为本扩展的独立功能存在。第二轮把所选模型、显式端点及兼容性元数据变化也纳入安装和重试前的归属检查；为小窗口进行的准备失败时同样保留已有历史。

“失败不覆盖旧 checkpoint”只适用于安装前的失败。上游 PostCompact hook 发生在成功执行与历史安装之后，hook 要求停止时会返回 TurnAborted，但这不意味着已经安装的压缩历史回滚。[compact_remote_v2.rs 160–195][hooks]

## 5. 后端身份、comp_hash 与持久化并不等价

插件使用 provider、API、认证解析后的 base URL 和 endpoint 绑定 opaque checkpoint，并对 Pi 保留近期消息做精确指纹校验，解决 Pi 的重复消息/恢复边界。第二轮把模型兼容性证据与后端身份分开判断，具体见 [capability.ts](../../src/capability.ts)、[model-transition.ts](../../src/model-transition.ts) 和 [checkpoint.ts](../../src/checkpoint.ts)。

Codex 自身还记录 `compaction_model_hash`、compaction response ID、窗口 ID、来源、MCP 和 world-state 信息；安装与持久化操作见 [session/mod.rs 4099–4208][install]。模型切换时，两个已知 `comp_hash` 不同，或切到更小窗口且预算不足，会尝试用前一模型先压缩，见 [session/turn.rs 1309–1441][model-switch]。某些消费者（例如 Guardian 的 checkpoint 复用）还有严格的 producer/reviewer hash 校验，见 [history/compaction_checkpoint.rs 14–56][checkpoint-hash]。后者不应被概括为所有普通请求都要求非空 hash。

Pi 0.99.1 的公开模型目录没有提供服务端 `comp_hash`。本扩展仅从 `compat.remoteCompaction` 中读取 `protocol: "v2"` 下的可选 `compactionModelHash`，由提供方显式配置；不会推导模型名称、窗口或 URL 的哈希，也不检查 opaque 的内部明文。该值必须是 1–1024 个无空白/控制字符的字符，按大小写敏感的原值比较。相同标识是配置提供的兼容性声明，不是本扩展从服务端独立验证出的事实。

| 检查点与目标模型关系 | 第二轮行为 |
| --- | --- |
| provider/API/实际 base URL/endpoint 不同 | 停止请求；相同 hash 不能覆盖后端隔离。 |
| 同后端，双方已知 hash 不同 | 停止请求；同一 model ID 的 hash 修订也优先判为冲突。 |
| 同后端，双方已知 hash 相同 | 按显式配置判为兼容，继续独立容量检查。 |
| 同后端，model ID 改变但 hash 缺失或只有一边可用 | 标为未知并提示，保留允许继续的行为；不能声称兼容已被证明。 |
| 仍为创建检查点的模型，且无已知 hash 冲突 | 保留同模型恢复行为；缺失 hash 仍不等于已验证的匹配。 |

v1 检查点可增加 `modelContextWindow` 与 `compactionModelHash`，来源是实际执行本次压缩的模型。前者只保存有效的正安全整数。缺失或无效的可选元数据不会让旧检查点无法解析，也不改变 marker、历史摘要、消息指纹或 legacy 修复规则。对旧检查点，可以从当前目录查询原模型窗口来辅助预检，但不能据此补写它创建时的 hash。没有可比较 hash 的同后端重放仍可能被服务端拒绝，恢复原模型的路径必须保留。

### 小窗口准备的具体范围

Pi 的 `model_select` 在选择完成后触发。插件观察到窗口变小且估算容量不足时，只在会话空闲、V2 开启、原模型可用、后端相同且无已知 hash 冲突的条件下，通过公共 `ctx.compact()` 回调请求准备；不会从活跃 provider hook 内启动压缩。会话正在运行时提示稍后手动 `/compact`，可用时由上一模型或检查点创建模型执行。用户选中的对话模型保持不变。

[model-budget.ts](../../src/model-budget.ts) 的输入预算为 `max(0, floor(0.95 × contextWindow) - max(model.maxTokens, Pi reserveTokens))`。无效窗口或预留值返回 0。估算覆盖完整 JSON 的提示词、工具、结构和未知字段；已识别图片/opaque 字段用现有 item 估值代替，不把 base64 再当成同量明文收费。无法估算时返回有限的最大安全整数，让容量判断停止通过。

准备时另扣 `min(4096, ceil(0.05 × contextWindow))`，给下一轮与请求结构留余量。只有这条路径会降低明文 retention 预算；反复估算后仍超出时可退到 opaque-only，连 opaque、当前提示词及工具都放不下则不安装。新记录保留实际 producer 身份及其元数据，不会把旧模型结果改标成由目标模型生成，也不会声称旧模型再压缩解决了已知 hash 冲突。

普通请求在 marker 展开后会针对较小目标窗口再次估算当前完整 payload；超过预算则调用 `ctx.abort()` 停止发送。后端/hash 冲突、精确消息投影失败、marker 缺失，或 payload 的 `model` 与当前选择不同也停止请求。Pi 会吞掉扩展钩子异常，因此取消必须先于抛错。检查发生在本扩展的钩子位置：后续扩展仍可改写请求，Pi 未公开的隐藏/路由状态也不能从最后一次快照推断出来。

这是一条可恢复的 Pi 准备流程及启发式容量保护，不是 Codex 完整换模型状态机或真实 tokenizer；相同预算、显式 hash 和离线测试都不能保证任意线上模型接受同一 opaque 项。

## 6. 钩子、上下文刷新和 usage

上游执行 PreCompact 与 PostCompact hooks，支持取消/停止；并记录 compaction reason、trigger、phase、usage、cache、保留图片数等 attempt 数据。钩子与 attempt 生命周期见 [compact_remote_v2.rs 134–213][hooks]，用量和图片统计见 [compact_remote_v2.rs 304–327][usage]。

成功后推进窗口，按 `InitialContextInjection` 模式插入上下文或延后重建，保存或保留相应 world-state baseline、重置 reasoning pin，并重新估算活动上下文 usage。基线的 `BeforeLastUserMessage` 分支会构造上下文，`DoNotInject` 分支返回空列表与 `None`；因此不能把立即构造 initial context 写成所有成功路径的共同动作。见 [compact.rs 87–106][initial-context]、[compact_remote_v2.rs 323–375][v2]及 [session/mod.rs 4099–4208][install]。

Pi 的事件和扩展返回值允许安全地接入压缩，但其生命周期并不等于 Codex hooks。插件返回 Pi provider 的 Usage 与 preparation.tokensBefore，不包含 Codex 的全套 compaction analytics、window/rollout budget 或 provider response metadata；这些字段也不能视作统一口径的性能比较数据。

本轮图片阻止修复覆盖 marker 展开后重新加入的**明文图片内容**；客户端不能进入 opaque 字符串删除其中已经编码的信息。过滤不会改写已有的保存记录，但在关闭图片读取期间成功生成的新 checkpoint 会保留本次实际发送的图片占位符；之后再打开读取，不保证最新 checkpoint 能恢复更早的明文图片。该设置也不会追溯抹去远端已经处理的图片。

## 7. 最新稳定版与 main 的核对结果

Git tree 对照未截断。以下文件在基线、最新稳定版和查询时 main 的 blob SHA 完全相同：

| 文件 | 三个版本共同的 blob SHA |
| --- | --- |
| `core/src/compact_remote_history.rs` | `aa7cd7607eeebef75a295a4409aa8f25dc2b2d6d` |
| `core/src/compact_remote_v2_images.rs` | `e1ae5be0fa8633481dd98224971af9f31059685c` |
| `core/src/context/contextual_user_message.rs` | `a74f10a616479a181d26f701f6d869245484206d` |
| `core/src/event_mapping.rs` | `176e33da175d0edb8f74bf84b312b4ea5674f5a2` |
| `codex-api/src/endpoint/responses.rs` | `9c41a802eadd57cf20ffc733121921d8d3ba9d08` |

稳定版 `0.160.1` 的 `compact_remote_v2.rs` 相对基线仅把 retry handler 的参数从 turn context 改为 step context，retention/collector 算法未变，也没有把 V2 失败改成文字回退。[稳定版 V2 源码][stable-v2] 另外，手动压缩遇到 `UsageLimitExceeded` 时增加生命周期通知；sampling 的 content-filter 错误会记录指导消息。分别见 [stable task L71–L80][stable-task]和 [stable retry L65–L81][stable-retry]。

main 已有额外的生命周期变化，应独立列出：

- `build_compaction_replacement_history` 基于 replacement step/world state 统一重新构造窗口前缀和普通上下文，见 [main compact.rs 79–110][main-refresh]。
- 当 `uses_incremental_tools()` 为 true 时，V2 attempt 将顶层 `BaseInstructions` 置空且 `tools` 设为空集合；同时从历史提取本次输入的 goal IDs，见 [main attempt.rs 43–103][main-attempt]。
- 安装新历史记录 input_goal_ids，并按 replacement step 的模型重新计算 usage，见 [main V2 313–363][main-v2]。

这些变化强化了“协议和普通消息保留算法可复用，但完整运行时不能声称一致”的判断。本轮没有把这些尚未稳定发布的 Codex 内部状态机制搬进 Pi。

## 8. 可以和不可以作出的声明

可以说：本扩展使用 V2 trigger/opaque response 协议，按已核对的 Codex 基线移植主要文本、图片保留规则，并针对 Pi 的认证、事件、工具可见性和 checkpoint 恢复增加适配。其中工具可见性适配采用全部省略 V2 结构化工具声明的策略，不能描述为完整沿用普通请求的工具声明或其缓存前缀。

不可以仅凭这些源码和离线测试说：与官方 Codex 在所有模型、上下文类型、重试故障、换模型/权限变化及服务端缓存状态下行为完全相同；或摘要质量、恢复率、成本和耗时相同。严肃评价后者需要固定服务端与模型版本、输入与工具状态，并进行真实服务的受控对照；本次没有做这类请求。


## 9. 本轮验证与复现边界

**第一轮安全修复**的完整测试记录为 **408 项通过，0 项失败、取消或跳过**；相对审计基线的 364 项测试新增 44 项，并更新了与修复行为相关的原有断言。这是第一轮历史结果，不是第二轮补丁的最终测试总数。验证通过真实的 Pi 会话、模型注册器和 provider adapter 发送请求，网络层使用可控 fixture；跨进程配置测试使用独立 Node 子进程竞争同一文件。

| 修复 | 关键回归场景 |
| --- | --- |
| 保留已有 opaque checkpoint | 两种 Responses API × V2 失败/关闭 × 启用/未启用独立摘要模型；确认没有文字摘要请求、后续普通请求仍重放旧记录，并能在服务恢复后再次 V2 压缩。 |
| 图片读取设置 | 普通重放与递归压缩均不发送被阻止的明文图片；在下一次压缩前重新开启读取可再次使用旧记录中的图片；旧 checkpoint details 不被修改。 |
| 隐藏工具声明 | 两种 API 下改变 thinking、增删工具、恢复会话、仅改变隐藏状态而公共工具状态不变，以及旧 checkpoint 再展开后的声明过滤；V2 最终请求省略全部结构化工具声明，保留普通/custom-tool 调用与结果；删除 Pi 合成的工具加载搜索配对，保留真实搜索历史并清空 tools 数组。 |
| Codex 终止事件 | 实际 Codex adapter 的成功 response.done；拒绝未完成、失败和取消的 terminal status；仍要求唯一 compaction 输出项。 |
| 配置竞争 | 已存在与首次创建的配置均只有一个基于旧版本的保存成功；持锁期间拒绝写入；释放后可保存；文件权限及临时文件清理。 |

第二轮新增整次重试、模型兼容性、完整预算和小预算保留的验证。验证重点包括：两种 Responses API 的建流与收流暂时失败、明确永久错误与取消、固定请求体/后端、内外重试总数；旧 v1 元数据兼容、同 ID 的 hash 冲突、未知 hash 不冒充兼容；新旧窗口、当前工具/提示词与 opaque 的完整估算，以及小预算下 Unicode 和图片标签的边界。模型切换集成验证关注准备模型与保存的实际来源、空闲回调、失败时保留历史及普通请求的最终停止行为。**第二轮累计补丁最终完整回归为 511 项通过，0 项失败、取消或跳过，相比第一轮增加 103 项；包含 54 项新的真实 provider 重试/元数据回归和 20 项模型切换及重试会话集成回归。**

类型检查和测试编译使用 **TypeScript 6.0.3**，执行环境为 **Node 24.19.0**。仓库固定的 TypeScript 7.0.2 原生编译器在本次执行环境无法读取 `/proc/self/exe`，因此使用外置便携编译器完成验证；没有修改仓库的 TypeScript 版本，也没有把这次结果标记成原始 TS7 命令通过。第二轮单独执行无输出类型检查、编译和编译后的完整测试，包含 npm 发布文件清单检查和 Pi 的真实入口加载检查；`git diff --check` 也通过。

普通请求钩子只提供载荷，不提供 V2 调用中可取得的实际 `preparedModel`。因此普通重放能检查 Pi 公开的所选模型元数据及序列化后的 `model`，却不能完整核验同一 ID 下的隐藏路由是否另换了窗口/哈希。V2 压缩会额外核验实际准备模型并保存它的元数据。这一可见性差异，以及后续钩子仍可改写载荷的限制，保留为与 Codex 完整客户端的差距。

在正常开发/CI 环境仍应使用仓库固定版本运行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

这类离线验证可以检查列出的客户端行为是否在可控输入下成立；它们没有测量真实服务端摘要质量、模型间 opaque 兼容性、缓存命中、费用或延迟。

[stable-release]: https://github.com/openai/codex/releases/tag/rust-v0.160.1
[stable-release-metadata]: https://api.github.com/repos/openai/codex/releases/404001397
[baseline-tag]: https://api.github.com/repos/openai/codex/git/tags/8b9fa496bbf2c47aebd62e85a080b9a522a455b5
[stable-tag]: https://api.github.com/repos/openai/codex/git/tags/c3e23d4c4385619ecec78408766e46b7fa7dd9ad
[provider-definition]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/model-provider/src/provider.rs#L37-L67
[provider]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/model-provider/src/provider.rs#L421-L433
[attempt]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2_attempt.rs#L38-L111
[endpoint]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/codex-api/src/endpoint/responses.rs#L123-L149
[session-header]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/mod.rs#L1178-L1196
[client-header]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/client.rs#L2311-L2335
[features]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/features/src/lib.rs#L1836-L1853
[token-budget-feature]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/features/src/lib.rs#L1692-L1697
[client-request]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/client.rs#L884-L1008
[effort]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/reasoning_effort.rs#L93-L135
[trim]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_history.rs#L27-L130
[window]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/openai_models.rs#L463-L522
[window-default]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/protocol/src/openai_models.rs#L389-L391
[text-budget]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/utils/output-truncation/src/lib.rs
[estimates]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/context_manager/history.rs#L1023-L1304
[image-cache]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/context_manager/history.rs#L1044-L1065
[image-estimates]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/context_manager/history.rs#L1220-L1278
[v2]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs
[v2-constants]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L75-L79
[image-retention]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2_images.rs#L31-L104
[contextual]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/context/contextual_user_message.rs#L23-L120
[event-mapping]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/event_mapping.rs#L101-L164
[collector]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L440-L501
[retry-loop]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L386-L437
[retry-policy]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/responses_retry.rs#L51-L153
[task]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/tasks/compact.rs#L35-L74
[auto-task]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/turn.rs#L1460-L1482
[fallback-v2]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L253-L294
[hooks]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L134-L213
[usage]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact_remote_v2.rs#L304-L327
[initial-context]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/compact.rs#L87-L106
[install]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/mod.rs#L4099-L4208
[model-switch]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/session/turn.rs#L1309-L1441
[checkpoint-hash]: https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/history/src/compaction_checkpoint.rs#L14-L56
[stable-v2]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/core/src/compact_remote_v2.rs
[stable-task]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/core/src/tasks/compact.rs#L71-L80
[stable-retry]: https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/core/src/responses_retry.rs#L65-L81
[main-refresh]: https://github.com/openai/codex/blob/c0c230e6730b3b3c9101b8aff4b9aea4027cea5b/codex-rs/core/src/compact.rs#L79-L110
[main-attempt]: https://github.com/openai/codex/blob/c0c230e6730b3b3c9101b8aff4b9aea4027cea5b/codex-rs/core/src/compact_remote_v2_attempt.rs#L43-L103
[main-v2]: https://github.com/openai/codex/blob/c0c230e6730b3b3c9101b8aff4b9aea4027cea5b/codex-rs/core/src/compact_remote_v2.rs#L313-L363

# @criogaid/pi-codex-compaction

[![CI](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![license](https://img.shields.io/npm/l/@criogaid/pi-codex-compaction)](LICENSE)

让 [Pi](https://github.com/earendil-works/pi) 在 Codex 模型上使用 Codex Remote Compaction V2 压缩聊天记录，并提供可选的 Pi 原生摘要回退和独立摘要模型。

- **装上即用：** 对 Codex 模型默认启用 V2 远程压缩，无需任何配置。
- **回退与历史保护：** 没有活动 V2 检查点时，V2 失败或不可用会退回 Pi 原生文字摘要。已有 V2 检查点时，无法继续 V2 就停止本次压缩，保留旧历史供后续重试。
- **独立摘要模型（可选）：** 退回 Pi 原生压缩时，可以使用你指定的模型和思考等级生成摘要。它只接管这一步，不影响 V2 远程压缩，也不改变当前对话模型。
- **切换模型保护：** 检查点的后端或已知兼容性标识不匹配时停止请求；切换到更小窗口且容量不足时，可在空闲状态下用原模型先做 V2 准备，保留实际来源。

[安装](#安装) · [工作方式](#工作方式) · [切换对话模型](#切换对话模型) · [独立摘要模型](#独立摘要模型) · [配置](#配置) · [自定义网关](#自定义网关) · [注意事项](#注意事项)

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

手动、自动或上下文溢出触发压缩时，扩展先按设置尝试 V2。无法使用 V2 时，只有没有活动 V2 检查点的会话才能转为文字摘要；已压缩的加密历史需要继续通过 V2 保留。

| 情况 | 压缩方式 | 使用的模型 |
| --- | --- | --- |
| V2 开启，模型支持 V2，请求成功 | V2 远程压缩 | 当前对话模型；小窗口准备时可使用原模型 |
| V2 请求失败，且没有活动 V2 检查点 | Pi 原生压缩 | 独立摘要模型，未启用时为当前对话模型 |
| 模型不支持 V2 或 V2 已关闭，且没有活动 V2 检查点 | Pi 原生压缩 | 独立摘要模型，未启用时为当前对话模型 |
| 已有活动 V2 检查点，但 V2 失败、关闭或不可用 | 停止本次压缩，保留检查点 | 不发送文字摘要请求 |

压缩完成后继续原来的对话，当前对话模型和思考等级保持不变。V2 失败、改用独立摘要模型时，Pi 会显示提示及实际使用的模型。

已有 V2 检查点时，恢复 V2 和原服务后可重试压缩。Pi 的文字摘要输入无法读取检查点中的加密历史，因此扩展会阻止用不完整的摘要替换它。

`/compact` 后附加的要求（例如“重点保留尚未完成的任务”）只对 Pi 原生压缩生效。V2 不接受这些要求，扩展会提示它们被忽略。

### 请求失败与重试

V2 对一次完整的 SSE 请求及其响应收集进行有限重试，覆盖可确认的暂时 HTTP 错误、网络错误和有响应进展后提前结束的流。额外重试次数取 Pi 的 provider 重试设置与 2 的较小值；未设置时最多额外重试 2 次，总共最多 3 次请求，设置为 0 时不重试。每次重试使用同一份已准备的请求内容和同一后端，并重新通过 Pi 认证。

无效压缩结果、重复输出、权限或额度等永久错误、取消操作，以及无法确认属于暂时故障的错误，不会重试。服务端要求等待的时间超过允许上限时也会停止。V2 不自动跟随 HTTP 重定向；请直接配置最终压缩地址，避免重定向绕过后端校验。只有经过这些处理仍失败后，才按上表决定保留旧检查点或转为 Pi 文字摘要。

## 切换对话模型

检查点仍绑定创建它的服务商、API、认证后的地址和 V2 端点。切换模型时，还会比较创建检查点时保存的兼容性标识与目标模型的显式配置：

| 检查结果 | 行为 |
| --- | --- |
| 后端不同，或两边已知的兼容性标识不同 | 停止使用该检查点的请求，保留旧记录；同一模型 ID 的标识变更也会检查 |
| 同一后端，且两边显式标识相同 | 按配置判为兼容，继续进行容量检查 |
| 同一后端，但切换模型后缺少一边或两边的标识 | 明确提示兼容性未知，仍允许继续；同一地址不能证明新模型可读取旧记录 |
| 继续使用创建检查点的模型，且没有已知冲突 | 保留已有会话的恢复行为；不会把缺失标识解释为已验证的哈希相同 |

Pi 当前不会自动提供 Codex 的服务端 `comp_hash`。可选配置字段是 `compat.remoteCompaction.compactionModelHash`，只应填写服务商确认的兼容性标识，不能用模型名称或相同地址猜测；配置方式见[自定义网关](#自定义网关)。旧检查点仍可读取，无需修改会话文件。

当切换到更小窗口、估算容量不足且会话空闲时，扩展会尝试用上一模型或检查点的原模型做一次 V2 准备。两者须位于同一后端且没有已知标识冲突。当前对话模型仍保持为你选中的目标模型；原模型只负责这次准备。会话正在运行时不会额外启动准备请求，可在空闲后执行 `/compact`；符合条件且原模型可用时，手动压缩也会使用原模型。

准备成功后，新检查点记录实际执行压缩的模型和可用元数据，不会被改写成由目标模型创建。原模型不可用、准备失败，或结果仍放不进目标预算时，本次准备停止并保留已有历史。已知标识不兼容也不会通过“先用旧模型压缩”变成兼容。

<details>
<summary><strong>小窗口预算与限制</strong></summary>

容量估算包括当前提示词、工具声明、展开后的历史和新不透明项。输入预算为 `floor(95% × 模型 contextWindow) - max(模型 maxTokens, Pi compaction.reserveTokens)`，不足 0 时按 0 处理；无效容量或预留值同样不给出可用预算。模型的 `maxTokens` 作为保守的输出预留，使用模型配置中的值。

小窗口准备额外预留 `min(4096, ceil(5% × contextWindow))`，给下一轮输入和请求结构留出空间。只有这条准备路径会降低默认 64,000 token 的明文用户历史保留预算，必要时只保留新不透明项；如果连不透明项、提示词和工具都超过预算，就不安装该结果。

这些数字是 UTF-8 字节与图片/不透明数据估值组成的启发式检查，不是真实 tokenizer，也不保证下一条任意长度的消息都能放入窗口。小模型的普通请求在检查点展开后还会重新估算；超过预算时停止发送，并提示重新 `/compact` 或选择更大模型。检查只能覆盖本扩展当前钩子看到的内容，之后执行的扩展仍可能修改请求。

</details>

## 独立摘要模型

假设你平时用 `gpt-6-astra` 聊天，希望退回原生压缩时改用 `gpt-6.1-sol` 生成摘要：

1. 执行 `/codex-compaction` 打开设置菜单。
2. 在 `Summary model and thinking level` 中选择 `gpt-6.1-sol` 及其思考等级。
3. 打开 `Use separate summary model`。

之后的压缩过程如下：

- `gpt-6-astra` 支持 V2 时，仍由 `gpt-6-astra` 完成 V2 远程压缩，不经过 `gpt-6.1-sol`。
- V2 失败或不可用且没有活动 V2 检查点时，由 `gpt-6.1-sol` 生成文字摘要。
- 压缩结束后继续使用 `gpt-6-astra` 对话。

如果想始终用 `gpt-6.1-sol` 生成文字摘要，在会话第一次压缩前关闭 `Remote Compaction V2`。已存在 V2 检查点的会话需要继续使用 V2；关闭后再次压缩会停止。

独立摘要模型的登录凭据沿用 Pi 的配置。选择虚拟模型时，Pi 按它的配置路由到实际发送请求的模型。

> [!IMPORTANT]
> 已启用的独立摘要模型不可用或请求失败时，本次压缩会停止，不会悄悄改用当前对话模型。摘要为空、生成被中断或因长度限制被截断时，也会停止压缩。

## 配置

### 设置菜单

执行 `/codex-compaction`：

| 设置 | 默认 | 用途 |
| --- | --- | --- |
| `Remote Compaction V2` | On | 是否优先尝试 V2 远程压缩 |
| `Use separate summary model` | Off | 退回原生压缩时是否使用独立摘要模型 |
| `Summary model and thinking level` | 未选择 | 独立摘要模型及其思考等级 |

- 终端菜单中按回车或空格切换开关，修改立即保存，光标停留在原来的行。选中一项时，列表下方会说明它的用途及与其他设置的关系。
- 模型可以按服务商（Provider）、ID 或名称搜索；取消选择不会保存。
- 关闭 `Use separate summary model` 会保留已选模型，之后重新打开即可使用。
- 通过 RPC 使用 Pi 的客户端会在选择框标题中看到何时使用文字摘要以及当前选用的模型，每次操作后退出菜单。

### 配置文件

设置保存在 `~/.pi/agent/extensions/pi-codex-compaction/config.json`。设置了 `PI_CODING_AGENT_DIR` 时，改用该目录下的 `extensions/pi-codex-compaction/config.json`。菜单会在保存时创建文件；非交互模式下可以直接编辑。

```json
{
  "version": 1,
  "remoteCompaction": {
    "enabled": true
  },
  "fallback": {
    "enabled": true,
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinkingLevel": "high"
  }
}
```

| 字段 | 对应菜单项 | 说明 |
| --- | --- | --- |
| `remoteCompaction.enabled` | `Remote Compaction V2` | 省略 `remoteCompaction` 时默认开启 |
| `fallback.enabled` | `Use separate summary model` | 旧配置省略此字段时按开启处理 |
| `fallback.provider`、`fallback.model`、`fallback.thinkingLevel` | `Summary model and thinking level` | 使用 Pi 中的实际 ID 和该模型支持的思考等级；三项须同时提供或同时省略 |

省略整个 `fallback` 表示未指定独立摘要模型。配置文件不保存 API key，模型和认证须先在 Pi 中配置好。

<details>
<summary><strong>读取时机与校验规则</strong></summary>

- 配置文件须为 UTF-8 JSON，大小不超过 16 KiB。
- 每次压缩开始时读取一次配置，压缩途中的修改在下次生效。
- 文件无法读取、JSON 格式错误或 V2 设置无效时，停止压缩。
- `fallback` 部分只在需要原生压缩时校验，因此它填错不会影响成功的 V2 压缩。
- `fallback` 无效时菜单显示 `Invalid`。你仍可切换 V2，已填写的内容会原样保留；重新选择模型即可修复，之后需要打开 `Use separate summary model` 才会使用它。
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

如果服务商另外提供了模型间的压缩兼容性标识，可在同一对象内增加 `compactionModelHash`：

```json
{
  "remoteCompaction": {
    "protocol": "v2",
    "compactionModelHash": "backend-provided-compatibility-id"
  }
}
```

上例仅展示 `compat` 内部的字段形状，标识文本须替换为服务商确认的值。扩展把它视为区分大小写的不透明标识，不计算哈希、不读取加密内容，也不会自动从 Codex 模型目录补全。有效值为 1–1024 个字符，不能含空白或控制字符；无效可选值按缺失处理，不会单独关闭有效的 V2 配置。新检查点可保存该标识及创建模型的有效 `contextWindow`；旧版 version 1 检查点没有这些字段时仍可恢复。

V2 总开关仍决定是否发送新的远程压缩请求。模型名匹配只决定是否尝试；Pi 的适配器和网关仍须实际支持 V2。请求失败时，没有活动 V2 检查点的会话退回 Pi 原生压缩，已有检查点的会话停止本次压缩。默认端点按 API 推导：`openai-codex-responses` 使用 Codex 路径，其他 API 使用 `/responses`。检查点继续绑定实际 provider、API 和端点，防止跨后端重放。

## 注意事项

- **V2 压缩结果绑定后端。** 旧记录以加密数据保存，扩展无法还原成文字。重新打开会话或创建分支时可以继续使用，但须通过后端身份、已知兼容性标识和消息对应关系检查。检查失败时普通请求与进一步压缩都会停止，保留旧记录供恢复原模型或原上下文后继续使用。
- **模型兼容性有边界。** 同后端但没有可比较标识的模型切换仍允许继续，并显示未知提示；新模型若不接受，需要切回原模型。选择模型与实际请求的 `model` 不同时，扩展停止不透明历史重放，不替虚拟路由推断实际后端或哈希。V2 协议仍属实验性质。
- **关闭 V2 保留已有记录的重放。** 已经用 V2 压缩的记录仍会在原后端照常发送；下一次压缩会停止，直到恢复可用的 V2。
- **关闭图片读取。** Pi 的 `images.blockImages` 设置也适用于检查点中保留的原始图片；普通重放和再次压缩都会用文字占位替换这些图片。已有保存记录不被修改，但关闭期间生成的新检查点会保留本次发送的占位符，之后重新开启读取不保证能恢复更早的原始图片。该设置不能删除已经包含在加密压缩结果中的图像信息。
- **加载顺序。** 压缩后 Pi 会保留一部分近期消息。如果它们被其他扩展改写，本扩展可能无法确认其与已压缩记录对应，从而停止本次请求，保留检查点。搭配会改写聊天内容的扩展时，请把本包放在 Pi 的 `packages` 列表靠前的位置；它无法保证之后执行的请求钩子不再修改已检查的内容。
- **工具声明。** Pi 当前没有公开工具隐藏状态；即使工具名称、定义和设置未变，隐藏状态也可能变化。因此 V2 压缩请求统一省略工具声明，保留实际工具调用与结果；普通对话仍由 Pi 按当前状态声明工具。省略发生在 Pi 完成历史序列化之后，避免改变历史中的自定义工具调用格式。
- **缓存复用。** 会话、模型、历史前缀、工具和设置未变时，压缩请求仍会复用最近一次普通请求中观察到的系统指令、缓存标识和思考等选项。工具声明前缀不再复用，可能降低缓存命中。记录只覆盖本扩展收到的请求内容，之后执行的扩展仍可能改写它；服务端也自行决定是否使用缓存，因此不保证缓存命中或费用下降。

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

[Publish](.github/workflows/publish.yml) 在推送 `v*` 标签时运行。标签须与 `package.json` 的版本一致，例如版本 `0.4.1` 对应标签 `v0.4.1`。目前只发布正式版本，不接受 `-beta`、`-rc` 等预发布后缀。

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

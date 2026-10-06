# @criogaid/pi-codex-compaction

[![CI](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![license](https://img.shields.io/npm/l/@criogaid/pi-codex-compaction)](LICENSE)

让 [Pi](https://github.com/earendil-works/pi) 在 Codex 模型上使用 Codex Remote Compaction V2 压缩聊天记录，失败时自动退回 Pi 原生压缩，并且可以为原生压缩单独指定一个摘要模型。

- **装上即用：** 对 Codex 模型默认启用 V2 远程压缩，无需任何配置。
- **失败自动退回：** 当前模型不支持 V2，或 V2 请求失败时，改用 Pi 原生的文字摘要压缩。
- **独立摘要模型（可选）：** 退回 Pi 原生压缩时，可以使用你指定的模型和思考等级生成摘要。它只接管这一步，不影响 V2 远程压缩，也不改变当前对话模型。

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

手动、自动或上下文溢出触发压缩时，扩展先按设置尝试 V2。V2 关闭、不支持或请求失败时，按配置使用 Pi 原生文字摘要。

| 情况 | 压缩方式 | 使用的模型 |
| --- | --- | --- |
| V2 开启，模型支持 V2，请求成功 | V2 远程压缩 | 当前对话模型 |
| V2 请求失败 | Pi 原生压缩 | 独立摘要模型，未启用时为当前对话模型 |
| 模型不支持 V2，或 V2 已关闭 | Pi 原生压缩 | 独立摘要模型，未启用时为当前对话模型 |

压缩完成后继续原来的对话，当前对话模型和思考等级保持不变。V2 失败、改用独立摘要模型时，Pi 会显示提示及实际使用的模型。

已有 V2 检查点也允许文字摘要回退。Pi 的文字摘要只能使用可读取的摘要和近期消息，无法解读检查点的加密历史；回退成功后，新的文字摘要成为后续对话上下文。

`/compact` 后附加的要求（例如“重点保留尚未完成的任务”）只对 Pi 原生压缩生效。V2 不接受这些要求，扩展会提示它们被忽略。

### 请求失败与重试

V2 对一次完整的 SSE 请求及其响应收集进行有限重试，覆盖可确认的暂时 HTTP 错误、网络错误和有响应进展后提前结束的流。额外重试次数取 Pi 的 provider 重试设置与 2 的较小值；未设置时最多额外重试 2 次，总共最多 3 次请求，设置为 0 时不重试。每次重试使用同一份已准备的请求内容和同一后端，并重新通过 Pi 认证。

无效压缩结果、重复输出、权限或额度等永久错误、取消操作，以及无法确认属于暂时故障的错误，不会重试。服务端要求等待的时间超过允许上限时也会停止重试。重试耗尽后按上表转为 Pi 文字摘要。HTTP 重定向沿用 provider 和 fetch 的处理方式。

## 独立摘要模型

假设你平时用 `gpt-6-astra` 聊天，希望退回原生压缩时改用 `gpt-6.1-sol` 生成摘要：

1. 执行 `/codex-compaction` 打开设置菜单。
2. 在 `Summary model and thinking level` 中选择 `gpt-6.1-sol` 及其思考等级。
3. 打开 `Use separate summary model`。

之后的压缩过程如下：

- `gpt-6-astra` 支持 V2 时，仍由 `gpt-6-astra` 完成 V2 远程压缩，不经过 `gpt-6.1-sol`。
- V2 失败或不可用时，由 `gpt-6.1-sol` 生成文字摘要。
- 压缩结束后继续使用 `gpt-6-astra` 对话。

如果想始终用 `gpt-6.1-sol` 生成文字摘要，再关闭 `Remote Compaction V2`。

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

V2 总开关仍决定是否发送新的远程压缩请求。模型名匹配只决定是否尝试；Pi 的适配器和网关仍须实际支持 V2，请求失败时退回 Pi 原生压缩。默认端点按 API 推导：`openai-codex-responses` 使用 Codex 路径，其他 API 使用 `/responses`。检查点继续绑定实际 provider、API 和端点，防止跨后端重放。

## 注意事项

- **V2 压缩结果绑定服务商。** V2 压缩后的旧记录以加密数据保存，扩展无法还原成文字。重新打开会话或创建分支时可以继续使用，但须保持服务商、API 类型和请求地址不变。换到其他后端后，扩展跳过加密历史，继续使用 Pi 可读取的摘要和近期消息。
- **同一服务内切换模型。** 扩展继续重放检查点，服务端决定新模型是否接受。模型切换本身不会触发压缩；后续 V2 使用当前对话模型，窗口容量由 Pi 和 provider 处理。普通请求的模型路由沿用 Pi 及其他扩展的处理结果。
- **关闭 V2 不影响已有记录的重放。** 已压缩记录仍可在原后端照常发送；下一次压缩按配置使用文字摘要。
- **关闭图片读取。** Pi 的 `images.blockImages` 设置也适用于检查点中保留的原始图片；普通重放和再次压缩都会用文字占位替换这些图片。已有保存记录不被修改，但关闭期间生成的新检查点会保留本次发送的占位符，之后重新开启读取不保证能恢复更早的原始图片。该设置不能删除已经包含在加密压缩结果中的图像信息。
- **加载顺序。** 压缩后 Pi 会保留一部分近期消息。如果它们被其他扩展改写，本扩展可能无法确认其与已压缩记录对应，便跳过加密历史并继续普通请求。搭配会改写聊天内容的扩展时，请把本包放在 Pi 的 `packages` 列表靠前的位置。
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

# @criogaid/pi-codex-compaction

[![CI](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml/badge.svg)](https://github.com/Criogaid/pi-codex-compaction/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![npm downloads](https://img.shields.io/npm/dm/@criogaid/pi-codex-compaction)](https://www.npmjs.com/package/@criogaid/pi-codex-compaction) [![license](https://img.shields.io/npm/l/@criogaid/pi-codex-compaction)](LICENSE)

让 [Pi](https://github.com/earendil-works/pi) 在 Codex 模型上使用 Codex Remote Compaction V2 压缩聊天记录，失败时自动退回 Pi 原生压缩，并且可以为原生压缩单独指定一个摘要模型。

- **装上即用：** 对 Codex 模型默认启用 V2 远程压缩，无需任何配置。
- **失败自动退回：** 当前模型不支持 V2，或 V2 请求失败时，改用 Pi 原生的文字摘要压缩。
- **独立摘要模型（可选）：** 退回 Pi 原生压缩时，可以使用你指定的模型和思考等级生成摘要。它只接管这一步，不影响 V2 远程压缩，也不改变当前对话模型。
- **Codex 式思考等级更新（可选，默认关闭）：** 开启后，普通请求和 V2 请求都按 Codex 的方式发送思考等级变化。

[安装](#安装) · [工作方式](#工作方式) · [独立摘要模型](#独立摘要模型) · [配置](#配置) · [自定义网关](#自定义网关) · [注意事项](#注意事项)

## 安装

需要 Pi 1.5.0 或更新版本：

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

每次压缩先按设置尝试 V2，失败时的处理取决于会话里是否已有 V2 检查点：

| 情况 | 压缩方式 | 使用的模型 |
| --- | --- | --- |
| V2 开启，模型支持 V2，请求成功 | V2 远程压缩 | 当前对话模型 |
| V2 失败，会话里还没有检查点 | Pi 原生压缩 | 摘要模型，未指定时为当前对话模型 |
| V2 遇到暂时故障，已有兼容检查点 | 分层恢复：保留原检查点，只对新移出窗口的内容做文字摘要 | 摘要模型，未指定时为压缩开始时的对话模型 |
| 模型不支持 V2，或 V2 已关闭 | Pi 原生压缩 | 摘要模型，未指定时为当前对话模型 |

压缩完成后继续原来的对话，当前对话模型和思考等级保持不变。改用文字摘要时，Pi 会提示原因和实际使用的模型。

**分层恢复。** 例如先用 V2 压缩出检查点 A，又聊了几轮；下一次 V2 遇到暂时故障时，摘要模型只读新移出的明文，不会收到 A 的加密内容。之后的请求依次发送 A、补充的文字摘要和保留的近期消息。遇到永久错误、没有新内容可摘要、历史无法验证或文字摘要失败时，本次压缩取消，原检查点保持不变。分层恢复生成的检查点需要 0.6.0 或更新的版本才能完整重放。

**与 Codex 的区别。** Codex 在 V2 失败后直接报错。本扩展有意保留 Pi 的文字回退，让 V2 不可用时压缩仍能完成。

**重试。** V2 只在能确认是暂时故障时重发整次请求，例如可重试的 HTTP 状态、网络错误、中途断开的流，以及带有效等待建议的限流和容量故障（按 Codex 0.172.0 的 `Retry-After` 规则）。额外重试次数取 Pi 的 provider 重试设置与 2 的较小值，未设置时最多共 3 次请求，设为 0 则不重试。用量或额度耗尽等永久错误、无效的压缩结果、取消和切换会话都不会重发。具体规则见 [V2 实现对照](docs/verification/codex-v2-parity.md#4-输出校验重试与失败行为必须分别评价)。

`/compact` 后附加的要求（例如“重点保留尚未完成的任务”）只对文字摘要生效。V2 不接受这些要求，扩展会提示它们被忽略。

## 独立摘要模型

假设你平时用 `gpt-6-astra` 聊天，希望退回文字摘要时改用 `gpt-6.1-sol`：

1. 执行 `/codex-compaction` 打开设置菜单。
2. 在 `Summary model` 中选择 `gpt-6.1-sol` 及其思考等级。

之后：

- `gpt-6-astra` 支持 V2 时，仍由它完成 V2 远程压缩，不经过 `gpt-6.1-sol`。
- V2 失败或不可用时，由 `gpt-6.1-sol` 生成文字摘要。
- 压缩结束后继续使用 `gpt-6-astra` 对话。

想始终用 `gpt-6.1-sol` 生成文字摘要，就再关闭 `Remote Compaction V2`。

摘要模型的登录凭据沿用 Pi 的配置。选择虚拟模型时，由 Pi 路由到实际发送请求的模型。

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

- 按回车或空格切换开关，修改立即保存。选中一项时，列表下方会说明它的用途。
- 模型可以按服务商（Provider）、ID 或名称搜索；取消选择不会保存。选择列表顶部的 `Use the chat model` 可恢复使用当前对话模型。
- 通过 RPC 使用 Pi 的客户端会在选择框标题中看到当前设置，每次操作后退出菜单。

### 配置文件

设置保存在 `~/.pi/agent/extensions/pi-codex-compaction/config.json`；设置了 `PI_CODING_AGENT_DIR` 时，改用该目录下的 `extensions/pi-codex-compaction/config.json`。菜单会在保存时创建文件，非交互模式下可以直接编辑。

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
| `remoteCompaction.enabled` | `Remote Compaction V2` | 省略时默认开启 |
| `reasoningEffortUpdates.enabled` | `Codex reasoning effort updates` | 省略时默认关闭 |
| `summaryModel.provider`、`summaryModel.model`、`summaryModel.thinkingLevel` | `Summary model` | 使用 Pi 中的实际 ID 和该模型支持的思考等级，三项须同时提供；省略整个 `summaryModel` 表示使用当前对话模型 |

配置文件不保存 API key，模型和认证须先在 Pi 中配置好。仍可读取 `"version": 1` 的旧配置，下次通过菜单保存时改写为版本 2。

<details>
<summary><strong>读取时机与校验规则</strong></summary>

- 配置文件须为 UTF-8 JSON，大小不超过 16 KiB。
- V2 开关和摘要模型在每次压缩开始时读取。配置无法读取、JSON 格式错误或开关无效时，压缩停止。
- `summaryModel` 只在需要文字摘要时校验，填错不影响成功的 V2 压缩。它无效时菜单显示 `Invalid`，重新选择模型或 `Use the chat model` 即可修复。
- 思考等级更新开关在会话开始时读取（启动、重载、新建、恢复和派生），通过菜单修改时立即生效；直接编辑文件或由其他 Pi 进程保存的值，要到下一次会话开始才生效。进行中的压缩沿用启动时的值。读取失败时视为关闭，有界面的会话会显示警告。
- 旧版 `"version": 1` 配置中，`fallback.enabled` 为 `true`（或省略）且填写了模型时按摘要模型处理，其余情况按未指定处理。
- 多个 Pi 进程保存同一个配置时会互斥，只有一个能保存成功，其他菜单须重新打开。外部编辑器不参与这把锁。

</details>

### 思考等级更新

Codex 把请求级的思考等级当作当前窗口的基线，历史中只记录等级变化，压缩后重新确定基线。Pi 默认的做法与此不同。开启 `Codex reasoning effort updates` 后，扩展按 Codex 的规则改写普通请求和 V2 请求（含重试）里的思考等级。规则细节见 [V2 实现对照](docs/verification/codex-v2-parity.md#逐项对照)。

> [!WARNING]
> 开启前请先卸载独立的 `@criogaid/pi-codex-reasoning-effort` 扩展。两者同时安装时，结果取决于 Pi 加载扩展的顺序：V2 请求可能和普通请求的改写不一致，或者同一请求被改写两次、改变窗口基线。

## 自定义网关

是否尝试 V2 由模型的 `compat.remoteCompaction` 决定。没有配置时，API 类型为 `openai-responses` 或 `openai-codex-responses` 且模型 ID 包含 `gpt`（不区分大小写）就会尝试；其他 API 无法携带 V2 请求，直接使用 Pi 原生压缩。服务商名称、显示名称和是否使用官方地址都不参与判断。

非 GPT 模型或需要覆盖端点时，在 Pi 的 `models.json` 中显式配置：

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

这个例子请求 `https://gateway.example.com/v1/responses`。`openai-codex-responses` 默认使用 Codex 路径，其他 API 使用 `/responses`。

- 显式配置须写 `protocol: "v2"`。配置无效时不尝试 V2，也不会退回按名称判断。
- 网关的压缩接口在其他路径时，在 `remoteCompaction` 中加 `endpoint`。它的协议、主机和端口须与 Pi 实际使用的 `baseUrl` 一致，且不能包含用户名、密码、查询参数（`?`）或片段（`#`）。
- 判断只决定是否尝试。网关不支持 V2 时请求会失败，再按[工作方式](#工作方式)退回。

## 注意事项

- **检查点绑定后端。** V2 压缩掉的历史以加密数据保存，扩展无法还原成文字。只要服务商、API 类型和请求地址不变，重新打开会话、创建分支或在同一服务内切换模型后都能继续使用；换到其他后端时，扩展跳过加密历史，只发送 Pi 能读取的摘要和近期消息。关闭 V2 不影响已有检查点的重放。
- **压缩中切换模型。** 压缩不会因此取消，结果仍由开始时的模型生成，与 Pi 原生压缩一致。新模型属于其他后端时，扩展会提示新检查点无法在当前后端重放。
- **图片读取设置。** Pi 的 `images.blockImages` 同样作用于检查点里保留的原始图片，关闭读取期间生成的新检查点只保存占位文字，之后重新开启也无法恢复。已经压进加密结果的图像信息不受这个设置影响。
- **粘性路由。** 扩展按 Codex 的规则，在同一轮对话的后续请求和自动压缩中回传服务端下发的 `x-codex-turn-state`。`openai-codex-responses` 模型只在 Pi 的传输设置为 `sse` 时为普通请求回传；Pi 默认的 `auto` 走 WebSocket，不回传。
- **缓存复用。** 压缩请求会尽量沿用最近一次普通请求的前缀和缓存键，让服务端缓存继续命中；会话、模型、历史、提示词、工具或设置变化时，改由 Pi 重新序列化。是否命中由服务端决定。
- **与其他扩展共存。** 扩展不改动 `context` 阶段的消息，其他扩展始终看到 Pi 原生消息。其他扩展删除压缩摘要，或改写得无法对应回原消息时，该次请求不重放加密历史。在 `before_provider_request` 阶段改写请求体的扩展，是否计入复用的前缀取决于加载顺序，可能让压缩请求无法命中普通请求的缓存。

复用条件、加载顺序和已知边界的完整说明见[请求复用验证记录](docs/verification/request-reuse.md)，与 Codex 客户端的逐项对照见 [V2 实现对照](docs/verification/codex-v2-parity.md)。

## 开发

使用 Node 24 或更新版本，在仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

本地加载使用 `pi install .`，Pi 不会替本地包安装依赖，须先完成上面的安装步骤。

源码在 `src/`，入口为 `src/index.ts`，Pi 直接加载 TypeScript 源码；测试在 `tests/`，编译结果写入 Git 忽略的 `dist/`。[CI](.github/workflows/ci.yml) 在 Ubuntu 和 Windows 上用 Node 24 验证。变更记录见 [CHANGELOG.md](CHANGELOG.md)，维护规则见 [AGENTS.md](AGENTS.md)。

<details>
<summary><strong>发布流程</strong></summary>

1. 运行 `npm version <版本号> --no-git-tag-version`，同步 `package.json` 和 `package-lock.json`。
2. 把 CHANGELOG 中“未发布”的改动归入该版本。
3. 运行上面的验证命令，通过后提交。
4. 为该提交推送 `v<版本号>` 标签，例如 `v0.6.0`。

[Publish](.github/workflows/publish.yml) 在推送 `v*` 标签时运行：核对标签与 `package.json` 版本一致，重新执行类型检查、测试和打包检查，通过后发布带来源证明（provenance）的公开 npm 包。只发布正式版本，不接受 `-beta`、`-rc` 等后缀；已发布的版本不能覆盖。

首次发布前，在仓库 **Settings → Secrets and variables → Actions** 中添加 `NPM_TOKEN`：按 [npm 文档](https://docs.npmjs.com/creating-and-viewing-access-tokens)创建 granular access token，授予 `@criogaid` 作用域的发布权限（Read and write / publish and stage），并启用 Bypass two-factor authentication。包创建后可以把权限缩小到该包。

</details>

## 许可证

[MIT](LICENSE)

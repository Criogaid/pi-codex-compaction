# pi-codex-compaction

为 [Pi](https://github.com/earendil-works/pi) 提供 Codex Remote Compaction V2，让支持它的服务压缩聊天记录。你也可以指定一个独立模型生成文字摘要，用一个模型聊天，用另一个模型压缩。

手动执行 `/compact`、Pi 自动压缩，以及聊天记录超出模型容量后触发的压缩，都使用这套设置。压缩不会改变当前对话模型或思考等级。

## 安装

需要 Pi 0.99.1 或更新版本：

```bash
pi install npm:@criogaid/pi-codex-compaction
```

也可以从 Git 仓库安装：

```bash
pi install git:github.com/Criogaid/pi-codex-compaction
```

不要安装不带作用域的 `pi-codex-compaction`，它属于另一个仓库。

## 开始使用

如果你使用 Pi 自带的 `openai-codex` 服务商配置和官方地址，安装后即可执行 `/compact`。扩展默认先尝试 V2；V2 失败时，交给 Pi 使用当前模型生成文字摘要。

要用指定模型生成文字摘要，执行：

```text
/codex-compaction
```

菜单按以下顺序显示：

| 设置 | 用途 |
| --- | --- |
| Remote Compaction V2 | 是否优先尝试远程压缩，默认 On |
| Use separate summary model | 是否使用独立模型生成文字摘要，默认 Off |
| Summary model and thinking level | 选择摘要模型及其思考等级 |

首次选择模型后，还需要打开 `Use separate summary model`。如果想始终使用指定模型生成文字摘要，同时关闭 `Remote Compaction V2`。

在终端菜单中选中一项，列表下方会显示它的用途及其与其他设置的关系。通过 RPC 使用 Pi 的客户端会在选择框标题中看到何时使用文字摘要，以及当前选用了哪个模型。

终端菜单中按回车或空格切换开关，修改立即保存，菜单停留在原来的行。模型可以按服务商（Provider）、ID 或名称搜索。关闭 `Use separate summary model` 会保留已选模型；取消模型选择不会保存。RPC 模式每次操作后退出菜单。

例如，你希望保留当前对话模型，但用另一个模型压缩：在第三项选好模型和思考等级，将前两项分别设为 Off、On，再执行 `/compact`。扩展会显示实际使用的压缩模型，摘要完成后继续原来的对话。

## 压缩规则

| V2 设置与当前模型 | 下一步 |
| --- | --- |
| V2 开启，模型支持协议 | 用当前模型尝试 V2；失败后改用文字摘要压缩 |
| V2 关闭，或模型不支持协议 | 直接用文字摘要压缩 |

需要文字摘要时，只有打开 `Use separate summary model` 且选好了模型，才会使用该模型；否则由 Pi 使用当前对话模型。模型的登录凭据和思考等级沿用 Pi 的配置。如果选择的是虚拟模型，Pi 会按它的配置选择实际发送请求的模型。

如果启用的独立摘要模型不可用或请求失败，本次压缩会停止，不再改用当前对话模型。摘要为空、生成被中断或因长度限制而截断时，也会停止压缩。

在 `/compact` 后面附加的要求，例如“重点保留尚未完成的任务”，只对文字摘要生效。V2 不接受这些要求，扩展会提示它们被忽略。

## 手动配置

设置保存在：

```text
~/.pi/agent/extensions/pi-codex-compaction/config.json
```

如果设置了 `PI_CODING_AGENT_DIR`，则使用该目录下的 `extensions/pi-codex-compaction/config.json`。菜单会在保存时创建文件；非交互模式可以直接编辑它。

下面的配置优先尝试 V2，需要文字摘要时使用指定模型：

```json
{
  "version": 1,
  "remoteCompaction": {
    "enabled": true
  },
  "fallback": {
    "enabled": true,
    "provider": "your-provider",
    "model": "your-model",
    "thinkingLevel": "high"
  }
}
```

将 `provider`、`model` 替换为 Pi 中的实际 ID，`thinkingLevel` 使用该模型支持的值。这里不保存 API key，模型和认证需要先在 Pi 中配置好。

配置中的 `fallback` 对应菜单里的独立摘要模型设置，`fallback.enabled` 对应 `Use separate summary model`。省略整个 `fallback` 表示未指定模型；旧配置如果省略了 `enabled`，按开启处理。模型的 `provider`、`model` 和 `thinkingLevel` 必须同时提供或同时省略。

省略 `remoteCompaction` 默认开启 V2。配置文件须为 UTF-8 JSON，大小不超过 16 KiB。

每次压缩开始时读取配置，压缩途中修改设置会在下次生效。文件无法读取、JSON 格式错误或 V2 设置无效时会停止压缩。独立摘要模型的配置只在需要文字摘要时检查，因此这部分填错不会影响成功的 V2 压缩。

独立摘要模型的配置无效时，菜单显示 `Invalid`。你仍可切换 V2，已填写的模型配置会保留。重新选择模型可以修复这部分配置，但之后需要打开 `Use separate summary model` 才会使用它。如果打开菜单后配置文件被其他程序修改，保存会失败；重新打开菜单再操作即可。

## 自定义网关

网关必须支持 Codex Remote Compaction V2，只有普通 Responses API 兼容性还不够。模型的 API 类型须为 `openai-responses` 或 `openai-codex-responses`。

在 Pi 的 `models.json` 中为模型添加 `compat.remoteCompaction`。以下是 `openai-responses` 配置示例：

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

替换地址和模型 ID，并设置 `CUSTOM_CODEX_API_KEY` 环境变量。这个例子请求 `https://gateway.example.com/v1/responses`。

如果网关的压缩请求使用其他路径，可以在 `remoteCompaction` 内增加 `endpoint`。它的协议、主机和端口必须与 Pi 登录认证后实际使用的 `baseUrl` 一致，URL 不能包含用户名、密码、`?` 后的查询参数或 `#` 后的片段。填写这些字段前，须确认网关本身支持 V2。

## 使用前需要了解

关闭 V2 后改用文字摘要压缩，不影响已压缩的聊天记录。

V2 压缩后的旧聊天记录以加密数据保存，只有支持它的模型服务才能使用，扩展无法把它还原成完整文字。重新打开会话或从会话创建分支时，可以继续使用这部分记录，但必须连接原来的服务商，并保持 API 类型和请求地址不变。换到其他服务商或地址后，文字摘要只能根据 Pi 仍能读取的摘要和消息生成，无法包含那部分加密的旧记录。

在同一服务和地址下切换模型，扩展也会继续发送已压缩的记录。如果新模型不接受这些数据，需要切回原模型。V2 协议仍属实验性质。

压缩后，Pi 还会保留一部分近期消息。如果这些消息被修改，扩展可能无法确认它们与已压缩记录是否对应，从而停止使用那部分记录。搭配会改写聊天内容的扩展时，请把本包放在 Pi 的 `packages` 列表中靠前的位置。

扩展会尽量让压缩请求与普通聊天请求使用相同的历史内容和系统提示词，便于模型服务复用缓存。但 Pi 和其他扩展仍可能改变最终发送的内容，因此不能保证缓存命中或费用下降。

## 开发

使用 Node 24 或更新版本。在克隆后的仓库根目录运行：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

本地加载可以使用 `pi install .`。Pi 不会替本地包安装依赖，须先完成上面的安装步骤。

运行代码在 `src/`，入口是 `src/index.ts`；测试在 `tests/`，编译结果写入 Git 忽略的 `dist/`。Pi 直接加载 TypeScript 源码。打包检查同时验证发布文件清单和 Pi 的实际入口加载。

[CI](.github/workflows/ci.yml) 在 Ubuntu 24.04 和 Windows 上使用 Node 24 执行验证。变更记录见 [CHANGELOG.md](CHANGELOG.md)，维护规则见 [AGENTS.md](AGENTS.md)。

## 发布

[Publish](.github/workflows/publish.yml) 在推送 `v*` 标签时运行。标签必须与 `package.json` 的版本一致，例如版本 `0.3.0` 对应标签 `v0.3.0`。流程目前只发布正式版本，不接受带 `-beta`、`-rc` 等后缀的预发布版本。

首次发布前，在本仓库的 **Settings → Secrets and variables → Actions** 中添加 `NPM_TOKEN`。按 [npm 文档](https://docs.npmjs.com/creating-and-viewing-access-tokens)创建 granular access token，授予 `@criogaid` 作用域的发布权限（Read and write / publish and stage），并启用 Bypass two-factor authentication。包创建后，可以将 token 权限缩小到该包。

准备版本时，运行 `npm version <版本号> --no-git-tag-version` 同步更新 `package.json` 和 `package-lock.json`，将本次改动从 CHANGELOG 的“未发布”整理到对应版本下。运行上面的三项验证命令，通过后提交，再为该提交创建并推送 `v<版本号>` 标签。

工作流会核对版本，重新安装依赖，执行类型检查、测试和打包检查，全部通过后才发布公开 npm 包，并附带可追溯到源码提交和工作流的来源证明（provenance）。普通分支推送不会发布；已经发布的 npm 版本不能覆盖，后续修改需要使用新版本号。

## 许可证

MIT，见 [LICENSE](LICENSE)。本仓库从 `Criogaid/pi-extensions-anthony` 提取并独立维护，实现基于 `@narumitw/pi-codex-compact`，保留 Narumi 和 Anthony 的署名。

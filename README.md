# pi-codex-compaction

为 [Pi](https://github.com/earendil-works/pi) 提供 Codex Remote Compaction V2，并允许指定独立的文本压缩模型。你可以用一个模型继续对话，用另一个模型生成压缩摘要。

扩展接入 Pi 自带的压缩流程：手动 `/compact`、自动压缩和上下文溢出恢复都使用同一套设置。压缩不会改变当前对话模型或思考等级。

## 安装

需要 Pi 0.99.1 或更新版本：

```bash
pi install git:github.com/Criogaid/pi-codex-compaction
```

请使用这个 Git 地址。npm 上的同名包 `pi-codex-compaction` 指向另一个仓库。

## 开始使用

如果你使用 Pi 官方 `openai-codex` Provider 和官方地址，安装后即可执行 `/compact`。扩展默认先尝试 V2；V2 失败时，交给 Pi 使用当前模型生成文本摘要。

要把文本压缩交给指定模型，执行：

```text
/codex-compaction
```

菜单按以下顺序显示：

| 设置 | 用途 |
| --- | --- |
| Remote Compaction V2 | 是否优先尝试远程压缩，默认 On |
| Use separate summary model | 是否使用独立模型生成文本摘要，默认 Off |
| Summary model and thinking level | 选择摘要模型及其思考等级 |

首次选择模型后，还需要打开 `Use separate summary model`。如果想始终使用指定模型做文本压缩，同时关闭 `Remote Compaction V2`。

TUI 选中设置时，列表下方会说明它与其他设置的关系；RPC 将文本压缩条件和当前模型状态显示在选择框标题中。

TUI 中按回车或空格切换开关，修改立即保存，菜单停留在原来的行。模型可以按 Provider、ID 或名称搜索。关闭 fallback 会保留已选模型；取消模型选择不会保存。RPC 模式使用选择框，每次操作后退出菜单。

例如，你希望保留当前对话模型，但用另一个模型压缩：在第三项选好模型和思考等级，将前两项分别设为 Off、On，再执行 `/compact`。扩展会显示实际使用的压缩模型，摘要完成后继续原来的对话。

## 压缩规则

| V2 设置与当前模型 | 下一步 |
| --- | --- |
| V2 开启，模型支持协议 | 用当前模型尝试 V2；失败后转入文本压缩 |
| V2 关闭，或模型不支持协议 | 直接使用文本压缩 |

文本压缩时，只有 fallback 开关开启且模型已配置，才使用指定模型；否则由 Pi 使用当前对话模型。指定模型的认证、思考等级和虚拟模型路由都由 Pi 处理。

已启用的指定模型如果不可用、请求失败，或返回空白、被中止、达到输出上限的摘要，本次压缩会停止，不再换用当前对话模型。

`/compact` 的附加摘要指令只对文本压缩生效。V2 会提示并忽略这些指令。V2 固定使用 SSE；普通对话和文本压缩仍沿用 Pi 的传输设置。

## 手动配置

设置保存在：

```text
~/.pi/agent/extensions/pi-codex-compaction/config.json
```

如果设置了 `PI_CODING_AGENT_DIR`，则使用该目录下的 `extensions/pi-codex-compaction/config.json`。菜单会在保存时创建文件；非交互模式可以直接编辑它。

下面的配置优先尝试 V2，需要文本压缩时使用指定模型：

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

文件须为不超过 16 KiB 的 UTF-8 JSON。省略 `remoteCompaction` 默认开启 V2；省略整个 `fallback` 表示未指定文本压缩模型。旧 fallback 配置未写 `enabled` 时按开启处理，模型的 `provider`、`model` 和 `thinkingLevel` 必须同时提供或同时省略。

每次压缩开始时读取配置，之后的修改在下次生效。文件无法读取、JSON 无效或 V2 设置不合法时会停止压缩。fallback 只在需要文本压缩时校验，其错误不会阻止一次成功的 V2 请求。

fallback 配置损坏时，菜单显示 `Invalid`。你仍可切换 V2，原 fallback 内容会保留；选择新模型可以替换无效配置，新模型以 Off 保存，需要另行开启。菜单检测到文件被外部修改时会拒绝覆盖，重新打开菜单后再保存。

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

非标准路由可以在 `remoteCompaction` 内增加 `endpoint`。它必须与 Pi 认证解析后的实际 `baseUrl` 同源，URL 不允许带凭据、查询参数或 fragment。配置只声明模型支持 V2，不能让不支持协议的网关获得该能力。

## 使用前需要了解

V2 保存的是 Provider 生成的加密检查点，扩展无法将它还原为完整文本。恢复会话、fork 和再次压缩可以复用检查点，但 Provider、API、实际 `baseUrl` 和 endpoint 必须一致，保留消息也须通过校验。换到其他 Provider 或地址后，文本压缩只能使用 Pi 当前可见的摘要和消息，不能读取旧加密历史。

关闭 V2 只停止新的远程压缩，已有检查点仍会重放。同一后端内切换模型也会继续重放；如果新模型不接受旧检查点，需要切回原模型。远程压缩协议仍属实验性质。

修改被检查点保护的保留消息可能导致重放停止。与会改写 `context` 消息的扩展一起使用时，把本包放在 Pi 的 `packages` 列表中靠前的位置。

扩展会在条件匹配时复用普通请求的上下文和提示词，以保持请求前缀。Pi 的隐藏工具声明和其他扩展的后续改写可能造成差异，因此不能保证缓存命中或费用下降。

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

[CI](.github/workflows/ci.yml) 在 Ubuntu 24.04 和 Windows 上使用 Node 24 执行验证，不自动发布。变更记录见 [CHANGELOG.md](CHANGELOG.md)，维护规则见 [AGENTS.md](AGENTS.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。本仓库从 `Criogaid/pi-extensions-anthony` 提取并独立维护，实现基于 `@narumitw/pi-codex-compact`，保留 Narumi 和 Anthony 的署名。

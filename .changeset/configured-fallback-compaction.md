---
"pi-codex-compaction": minor
---

支持在 `~/.pi/agent/extensions/pi-codex-compaction/config.json` 中指定降级压缩模型和思考等级。远程压缩失败或当前模型不支持 Remote Compaction V2 时，使用已配置模型生成 Pi 原生文本摘要，压缩后继续使用原来的对话模型。

已启用的降级模型在配置、认证、请求或摘要校验失败时停止压缩，避免再次交给当前对话模型。复用 Pi 的消息准备、最近消息保留、文件记录、用量和重试机制，保持现有 Codex 检查点格式。

新增 `/codex-compaction` 配置菜单，可在终端或 RPC 中选择已认证模型和受支持的思考等级。`Fallback model: On/Off` 开关独立控制是否使用已选模型，关闭保留模型和思考等级，再次开启直接恢复。配置新增布尔字段 `fallback.enabled`，旧配置省略时保持启用。取消菜单不保存；保存时检查外部修改，并使用 Pi 的文件写入队列原子替换配置文件。

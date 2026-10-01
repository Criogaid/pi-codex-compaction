---
"pi-codex-compaction": patch
---

V2 压缩固定使用 SSE，确保普通对话已建立 WebSocket 后，压缩请求仍携带 `remote_compaction_v2` 功能头并校验 endpoint。保留 session ID、缓存参数、思考等级和重试配置；普通对话与文本降级的传输设置不变。

---
"pi-codex-compaction": patch
---

当前模型不支持 Remote Compaction V2 时，普通请求不再为整段对话计算消息指纹，减少长会话（尤其含内嵌图片时）的每轮 CPU 开销。支持 V2 的模型行为不变。

---
"pi-codex-compaction": patch
---

`/codex-compaction` 在 fallback 配置无效时仍可打开：开关与模型行显示 `Invalid` 并给出原因，可继续切换 V2，或选择新模型替换无效配置。切换 V2 时原样保留无效的 fallback；合法配置仍按规范化格式保存。fallback 校验错误现在包含配置文件路径。

---
"pi-codex-compaction": major
---

Inherit the active Pi session's thinking level and session ID during Remote Compaction V2. Use Pi's simple provider adapter for effort mapping and cache defaults instead of forcing caching off. Preserve the resolved provider environment and nullable header overrides.

Require Pi 0.99.1 or newer and test both Responses adapters against ordinary requests with simulated HTTP responses. Document installation from the maintained local workspace.

Run the compaction tests through npm using TypeScript compilation and Node's test runner. Use npm for workspace verification and make dry-run package checks portable on Windows. Exclude test sources from the published compaction package.

Build the compaction request from the transcript's system messages instead of re-injecting the system prompt and tools, and apply Pi's image blocking, thinking budgets, WebSocket connect timeout, and retry delay settings. Trim trailing tool outputs to Codex's usable context window before compaction. Classify retained user items by Pi message origin so user shell commands, hidden extension messages, and expanded skill blocks follow Codex's contextual rules.

Reuse the last ordinary request's projected context and effective prompt override so the compaction request shares its full prompt-cache prefix, as Codex does; reuse ends when the session, model, backend, or source history changes. Keep replaying checkpoints after a model switch on the same provider backend.

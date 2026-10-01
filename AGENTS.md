# Pi Codex Compaction

- Maintain this standalone package at the repository root; its `package.json` `pi` field owns extension entrypoints.
- Install dependencies with Bun. Run `npm test`, `npm run typecheck`, and `npm run pack:check` before committing implementation changes.
- Keep local TypeScript imports on `.js` specifiers under `NodeNext`; tests compile with TypeScript and run with Node's test runner.
- Write repository documentation in Simplified Chinese. Write code comments, tests, prompts, and maintainer instructions in English.
- Use the changed functional module as the commit scope; preserve contributor metadata and message trailers when migrating history.

## Ownership

- Keep lifecycle hooks and in-memory snapshot state in `extensions/codex-compaction.ts`; keep snapshot capture, matching, and reuse in `extensions/request-snapshot.ts`.
- Capture ordinary context through `context_with_system` and the effective prompt through `ctx.getSystemPrompt()` before ordinary provider requests. Bind reuse to the session, model, backend, and unchanged canonical source prefix.
- Keep checkpoint persistence, canonical Pi projection, and legacy fingerprint normalization in `extensions/checkpoint.ts`. Preserve checkpoint version 1, legacy markers, summary wording, and completion entry identifiers across the package rename.
- Keep provider identity in `extensions/capability.ts`, Responses wire rules in `extensions/protocol.ts`, and provider adaptation and transport defaults in `extensions/remote.ts`. Dispatch through Pi's `ModelRegistry.streamSimple()` with SSE so each V2 request sends its feature header and checks its endpoint.
- Keep configured fallback model resolution and Pi native text summarization in `extensions/fallback.ts`. Keep the versioned configuration format, bounded reads, and revision-bound atomic updates in `extensions/fallback-settings.ts`; keep `/codex-compaction` interaction in `extensions/fallback-command.ts`. Read `extensions/pi-codex-compaction/config.json` under Pi's agent directory once at compaction start, default V2 to enabled, and validate fallback only when needed. Disabling V2 skips new remote compaction requests but preserves checkpoint replay. Resolve models and authentication through Pi, leave the chat model unchanged, and cancel compaction if an enabled fallback fails.
- Keep message classification in `extensions/retention-input.ts`, selection and truncation in `extensions/retention.ts`, tool-output trimming and item estimates in `extensions/context-window.ts`, and UTF-8 estimates in `extensions/text-budget.ts`.
- Keep image decoding and byte estimates in `extensions/image-budget.ts`; estimate each remote request once and share its URL-keyed snapshot with trimming and retention.
- Follow enabled defaults from Codex `rust-v0.159.2`; check hook XML edge cases against its actual quick-xml parser.
- Load this extension before context handlers that rewrite retained messages; preserve exact checkpoint fingerprint checks.

## History

- Keep `migration/history.json` as the source-to-extracted commit map. Imported commits change only their title scope and package-root paths; author, committer, dates, body, trailers, file modes, and selected blob contents match the source branch.
- Treat `openspec/changes/archive/` and existing changelog entries as historical records; their old package names and paths describe the original repository.

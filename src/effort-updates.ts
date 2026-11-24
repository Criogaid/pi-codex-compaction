// Own the optional Codex reasoning-effort rewrite of a finished OpenAI Responses payload.
import { isObject, type JsonObject } from "./protocol.js";

// Mirrors COMPACTION_SUMMARY_PREFIX from Pi's dist/core/messages.js.
const PI_COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
// Mirrors COMPACTION_SUMMARY_SUFFIX from Pi's dist/core/messages.js.
const PI_COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/**
 * Marks rewritten payloads. A compacted window's dropped first update survives only as the request
 * baseline, and Pi's own payloads always carry a fixed request effort, so content alone cannot tell a
 * rewritten payload from Pi's. Symbol.for keeps reloaded copies of this module, and the standalone
 * @criogaid/pi-codex-reasoning-effort extension, in agreement.
 */
const REWRITTEN = Symbol.for("@criogaid/pi-codex-reasoning-effort/rewritten");

function updateEffort(item: JsonObject): string | undefined {
  if (item.type !== "configuration_update") return undefined;
  const { reasoning } = item;
  if (!isObject(reasoning)) return undefined;
  const { effort } = reasoning;
  return typeof effort === "string" ? effort : undefined;
}

/** Codex starts a fresh context window after any compaction, remote or local. */
function startsCompactedWindow(item: JsonObject): boolean {
  const { type } = item;
  if (type === "compaction" || type === "compaction_summary" || type === "context_compaction") return true;
  const { content } = item;
  if (item.role !== "user" || !Array.isArray(content) || content.length !== 1) return false;
  const part: unknown = content[0];
  if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string") return false;
  const { text } = part;
  // A user pasting the exact summary as one text part is indistinguishable on the wire.
  return text.length >= PI_COMPACTION_SUMMARY_PREFIX.length + PI_COMPACTION_SUMMARY_SUFFIX.length &&
    text.startsWith(PI_COMPACTION_SUMMARY_PREFIX) && text.endsWith(PI_COMPACTION_SUMMARY_SUFFIX);
}

/**
 * Rewrite Pi's per-output updates into Codex's sparse history.
 *
 * Codex (`core/src/session/reasoning_effort.rs`) keeps effort changes within each
 * window and sends the window's baseline as `reasoning.effort`. The first update
 * after compaction sets that baseline without appearing in the history.
 * A shared history prefix rewrites identically in later requests, except that a
 * `compaction_trigger` drops the run of retained updates immediately before it.
 * Everything before that run stays stable for prompt caching.
 * Rewriting a returned payload again returns it unchanged; a copy loses the mark.
 */
export function applyCodexEffortUpdates(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.input) || REWRITTEN in payload) return payload;
  const input: unknown[] = payload.input;
  if (!input.some((item) => isObject(item) && updateEffort(item) !== undefined)) return payload;

  type WindowState = "fresh" | "compacted" | { baseline: string; latest: string };
  let windowState: WindowState = "fresh";
  const kept: unknown[] = [];
  let runStart = 0;
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const item = isObject(raw) ? raw : undefined;
    if (item && startsCompactedWindow(item)) windowState = "compacted";
    const effort = item && updateEffort(item);
    if (effort === undefined) {
      // The extension trims the preceding run of retained updates to mirror Codex V2,
      // which sends the existing history plus the trigger before the next sampling update.
      // The window keeps its recorded effort.
      if (item?.type === "compaction_trigger") kept.length = runStart;
      runStart = kept.push(raw);
      continue;
    }
    if (typeof windowState === "string") {
      const keepFirst = windowState === "fresh";
      windowState = { baseline: effort, latest: effort };
      if (!keepFirst) continue;
    } else {
      if (effort === windowState.latest) continue;
      windowState.latest = effort;
    }
    kept.push(raw);
  }

  const changed = kept.length !== input.length;
  const baseline = typeof windowState === "string" ? undefined : windowState.baseline;
  const reasoning = isObject(payload.reasoning) && baseline !== undefined && payload.reasoning.effort !== baseline
    ? { ...payload.reasoning, effort: baseline }
    : payload.reasoning;
  if (!changed && reasoning === payload.reasoning) return payload;
  const rewritten = { ...payload, input: changed ? kept : input, reasoning };
  // Non-enumerable, so serialization and later spreads leave no trace on the wire.
  return Object.defineProperty(rewritten, REWRITTEN, { value: true });
}

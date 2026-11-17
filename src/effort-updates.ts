// Own the Codex reasoning-effort rewrite of a finished OpenAI Responses payload.
type JsonObject = Record<string, unknown>;

/** Pi's user-message prefix for native compaction summaries (`core/messages.ts`). */
const PI_COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

/**
 * Marks rewritten payloads. A compacted window's dropped first update survives only as the request
 * baseline, and Pi's own payloads always carry a fixed request effort, so content alone cannot tell a
 * rewritten payload from Pi's. Symbol.for keeps reloaded copies of this module in agreement.
 */
const REWRITTEN = Symbol.for("@criogaid/pi-codex-reasoning-effort/rewritten");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateEffort(item: unknown): string | undefined {
  if (!isObject(item) || item.type !== "configuration_update" || !isObject(item.reasoning)) return undefined;
  const effort = item.reasoning.effort;
  return typeof effort === "string" ? effort : undefined;
}

/** Codex starts a fresh context window after any compaction, remote or local. */
function startsCompactedWindow(item: unknown): boolean {
  if (!isObject(item)) return false;
  if (item.type === "compaction" || item.type === "compaction_summary" || item.type === "context_compaction") return true;
  if (item.role !== "user" || !Array.isArray(item.content)) return false;
  const first = item.content[0];
  return isObject(first) && first.type === "input_text" && typeof first.text === "string" &&
    first.text.startsWith(PI_COMPACTION_SUMMARY_PREFIX);
}

/**
 * Rewrite Pi's update before every same-model output into Codex's sparse history.
 *
 * Codex (`core/src/session/reasoning_effort.rs`) records an update only when the
 * selected effort differs from the window's latest update or pinned baseline,
 * writes none for the first turn after compaction, sends the window baseline as
 * `reasoning.effort`, and appends no update to a compaction request. Each kept
 * item depends only on the items before it, so a shared prefix rewrites the same
 * way in every later request. Rewriting a returned payload again returns it unchanged;
 * pass Pi's own payload, not a copy of a rewritten one.
 */
export function applyCodexEffortUpdates(payload: unknown): unknown {
  if (!isObject(payload) || !Array.isArray(payload.input) || REWRITTEN in payload) return payload;
  const input: unknown[] = payload.input;
  if (!input.some((item) => updateEffort(item) !== undefined)) return payload;

  const kept: unknown[] = [];
  let baseline: string | undefined;
  let latest: string | undefined;
  let compacted = false;
  for (const item of input) {
    if (startsCompactedWindow(item)) {
      baseline = undefined;
      latest = undefined;
      compacted = true;
    }
    const effort = updateEffort(item);
    if (effort === undefined) {
      kept.push(item);
      continue;
    }
    if (baseline === undefined) {
      baseline = effort;
      latest = effort;
      // The first turn after compaction pins its effort as the request baseline without an update.
      if (!compacted) kept.push(item);
      continue;
    }
    if (effort === latest) continue;
    latest = effort;
    kept.push(item);
  }
  // Codex's V2 request is history plus the trigger; the next sampling step's update is not history yet.
  for (let index = kept.length - 1; index > 0; index--) {
    if (isObject(kept[index]) && (kept[index] as JsonObject).type === "compaction_trigger" &&
        updateEffort(kept[index - 1]) !== undefined) {
      kept.splice(index - 1, 1);
    }
  }

  const changed = kept.length !== input.length || kept.some((item, index) => item !== input[index]);
  const reasoning = isObject(payload.reasoning) && baseline !== undefined && payload.reasoning.effort !== baseline
    ? { ...payload.reasoning, effort: baseline }
    : payload.reasoning;
  if (!changed && reasoning === payload.reasoning) return payload;
  const rewritten = { ...payload, input: changed ? kept : input, reasoning };
  // Non-enumerable, so serialization and later spreads leave no trace on the wire.
  return Object.defineProperty(rewritten, REWRITTEN, { value: true });
}

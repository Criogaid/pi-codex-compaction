// Own per-turn `x-codex-turn-state` sticky-routing tokens matching Codex's OnceLock contract:
// latch the first server-issued token within a turn, replay it across subsequent requests and
// in-turn compactions, and clear it at turn settlement, model switch, or session change.
import type { Api, ProviderHeaders } from "@earendil-works/pi-ai";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { isObject } from "./protocol.js";

const TURN_STATE_HEADER = "x-codex-turn-state";

function headerTurnState(headers: Readonly<Record<string, unknown>>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== TURN_STATE_HEADER) continue;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Mutate `headers` in place with `token` unless a caller or earlier hook already set or deleted the header. */
export function applyTurnStateHeader(headers: ProviderHeaders, token: string | undefined): void {
  if (token === undefined || Object.keys(headers).some((key) => key.toLowerCase() === TURN_STATE_HEADER)) return;
  headers[TURN_STATE_HEADER] = token;
}

/** Write-once sticky-routing token matching Codex's `OnceLock<String>` per-turn contract. */
export class TurnStateSlot {
  private token?: string;

  get value(): string | undefined {
    return this.token;
  }

  observeHeaders(headers: Headers | Readonly<Record<string, string>>): void {
    this.observe(headers instanceof Headers ? headers.get(TURN_STATE_HEADER) ?? undefined : headerTurnState(headers));
  }

  observeStreamEvent(event: unknown): void {
    if (!isObject(event) || event.type !== "response.metadata" || !isObject(event.headers)) return;
    this.observe(headerTurnState(event.headers));
  }

  private observe(value: string | undefined): void {
    // Stream-event values are server JSON; one that fetch would reject as a header value is dropped.
    if (this.token !== undefined || value === undefined || /[\r\n\0]/.test(value)) return;
    const trimmed = value.trim();
    if (trimmed.length > 0) this.token = trimmed;
  }
}

interface ActiveTurn {
  readonly sessionId: string;
  readonly identity: ProviderIdentity;
  readonly slot: TurnStateSlot;
}

/**
 * Scope one `TurnStateSlot` to an active user turn on a capable Responses model.
 * Never replays a token across user turns, sessions, or model/backend switches.
 */
export class TurnStateTracker {
  private active?: ActiveTurn;

  reset(): void {
    this.active = undefined;
  }

  startTurn(sessionId: string, target: CapableModel | undefined): void {
    this.active = target ? { sessionId, identity: target.identity, slot: new TurnStateSlot() } : undefined;
  }

  /** Preserve an active turn across Pi's internal continuations (retries, overflow compaction). */
  ensureTurn(sessionId: string, target: CapableModel | undefined): void {
    if (this.slotFor(sessionId, target)) return;
    this.startTurn(sessionId, target);
  }

  /** Clear any latched token when switching models mid-turn while keeping the turn active for the new model. */
  selectModel(sessionId: string, target: CapableModel | undefined): void {
    if (!this.active || this.slotFor(sessionId, target)) return;
    this.startTurn(sessionId, target);
  }

  endTurn(): void {
    this.active = undefined;
  }

  /**
   * `after_provider_response` names no model, so a response that arrives after a mid-request model
   * switch latches into the new model's slot. Pi exposes no request identity to rule that out.
   */
  observeResponse(
    sessionId: string,
    target: CapableModel | undefined,
    headers: Readonly<Record<string, string>>,
  ): void {
    this.slotFor(sessionId, target)?.observeHeaders(headers);
  }

  observeStreamEvent(
    sessionId: string,
    target: CapableModel | undefined,
    event: { readonly provider: string; readonly api: Api; readonly model: string; readonly data: unknown },
  ): void {
    if (!target || event.provider !== target.identity.provider ||
        event.api !== target.identity.api || event.model !== target.identity.modelId) {
      return;
    }
    this.slotFor(sessionId, target)?.observeStreamEvent(event.data);
  }

  applyToHeaders(sessionId: string, target: CapableModel | undefined, headers: ProviderHeaders): void {
    applyTurnStateHeader(headers, this.slotFor(sessionId, target)?.value);
  }

  /**
   * In-turn automatic compactions share the active turn's slot. Compactions outside a turn, including
   * manual ones (Pi aborts and settles the run first), get a fresh slot for their own retries.
   */
  compactionSlot(sessionId: string, target: CapableModel | undefined): TurnStateSlot {
    return this.slotFor(sessionId, target) ?? new TurnStateSlot();
  }

  private slotFor(sessionId: string, target: CapableModel | undefined): TurnStateSlot | undefined {
    const current = this.active;
    return current && target && current.sessionId === sessionId &&
      sameModel(current.identity, target.model) && sameBackend(current.identity, target.identity)
      ? current.slot : undefined;
  }
}

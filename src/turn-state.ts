// Own per-turn `x-codex-turn-state` sticky-routing tokens matching Codex's OnceLock contract:
// latch the first server-issued token within a turn, replay it across subsequent requests and
// in-turn compactions, and clear it at turn settlement, model switch, or session change.
import type { Api, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { CODEX_API, isObject } from "./protocol.js";

const TURN_STATE_HEADER = "x-codex-turn-state";

type TransportSetting = ReturnType<ExtensionAPI["getSettings"]>["transport"];

/** Codex reads a JSON header value as a string or, recursively, the first element of an array. */
function jsonHeaderString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? jsonHeaderString(value[0]) : undefined;
}

function headerTurnState(headers: Readonly<Record<string, unknown>>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== TURN_STATE_HEADER) continue;
    const text = jsonHeaderString(value);
    if (text !== undefined) return text;
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

  /** Codex latches a token only from a response whose request succeeded. */
  observeResponse(status: number, headers: Headers | Readonly<Record<string, string>>): void {
    if (status < 200 || status >= 300) return;
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
  /** The slot that was current when Pi assembled the headers of its in-flight request. */
  private requestSlot?: TurnStateSlot;

  reset(): void {
    this.active = undefined;
    this.requestSlot = undefined;
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
    this.requestSlot = undefined;
  }

  /**
   * `after_provider_response` names no model, so the response latches into the slot captured with its
   * request's headers: a response that arrives after a model switch cannot seed the new model's slot.
   */
  observeResponse(status: number, headers: Readonly<Record<string, string>>): void {
    this.requestSlot?.observeResponse(status, headers);
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

  /**
   * Pi sends Codex WebSocket headers only in the handshake of a pooled connection that later turns
   * reuse, while Codex sends turn state per request in `client_metadata` and never in the handshake.
   * Only SSE requests can therefore carry the token.
   */
  applyToHeaders(
    sessionId: string,
    target: CapableModel | undefined,
    transport: TransportSetting,
    headers: ProviderHeaders,
  ): void {
    const slot = this.slotFor(sessionId, target);
    // Pi's session sends one provider request at a time, so the next response belongs to this request.
    this.requestSlot = slot;
    if (target?.identity.api === CODEX_API && transport !== "sse") return;
    applyTurnStateHeader(headers, slot?.value);
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

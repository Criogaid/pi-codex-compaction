// Own per-turn `x-codex-turn-state` sticky-routing tokens matching Codex's OnceLock contract:
// latch the first token from a successful agent-loop HTTP response within a turn, replay it across subsequent requests and
// in-turn compactions, and clear it at turn settlement, model switch, or session change.
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { CODEX_API } from "./protocol.js";

const TURN_STATE_HEADER = "x-codex-turn-state";

type TransportSetting = ReturnType<ExtensionAPI["getSettings"]>["transport"];

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

  /**
   * Codex latches an HTTP token only from a successful response's headers; `response.metadata` stream events
   * carry turn state only over WebSocket. Pi records response headers through `Headers`, whose names are
   * lowercase and whose values are valid to send again.
   */
  observeResponse(status: number, headers: Headers | Readonly<Record<string, string>>): void {
    if (this.token !== undefined || status < 200 || status >= 300) return;
    const value = headers instanceof Headers ? headers.get(TURN_STATE_HEADER) : headers[TURN_STATE_HEADER];
    if (value) this.token = value;
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
  /** The active slot when the agent loop began its in-flight request; unset outside agent-loop requests. */
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
   * `context` opens an agent-loop request. Pi's cache warmer replays a request through the same provider
   * callbacks without `context`, so only agent-loop responses latch. Capturing the slot here also keeps a
   * response that arrives after a model switch out of the new model's slot.
   */
  beginRequest(sessionId: string, target: CapableModel | undefined): void {
    this.requestSlot = this.slotFor(sessionId, target);
  }

  /** The assistant `message_end` closes the agent-loop request. */
  endRequest(): void {
    this.requestSlot = undefined;
  }

  /**
   * `after_provider_response` names neither its request nor its model. A warming response that arrives while
   * an agent-loop request still awaits its own response headers is indistinguishable and may latch first.
   */
  observeResponse(status: number, headers: Readonly<Record<string, string>>): void {
    this.requestSlot?.observeResponse(status, headers);
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
    if (target?.identity.api === CODEX_API && transport !== "sse") return;
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

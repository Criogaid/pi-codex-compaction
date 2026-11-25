// Own per-turn `x-codex-turn-state` sticky-routing tokens matching Codex's OnceLock contract:
// latch the first server-issued token within a turn, replay it across subsequent requests and
// in-turn compactions, and clear it at turn settlement, model switch, or session change.
import type { Api, ProviderHeaders } from "@earendil-works/pi-ai";
import { sameBackend, sameModel, type CapableModel, type ProviderIdentity } from "./capability.js";
import { isObject } from "./protocol.js";

export const TURN_STATE_HEADER = "x-codex-turn-state" as const;

function validTurnState(value: string | undefined): string | undefined {
  if (!value || /[\r\n\0]/.test(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTurnStateHeader(headers: Headers | Readonly<Record<string, string | undefined>>): string | undefined {
  if (headers instanceof Headers) return validTurnState(headers.get(TURN_STATE_HEADER) ?? undefined);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === TURN_STATE_HEADER) return validTurnState(value);
  }
  return undefined;
}

function hasTurnStateHeader(headers: ProviderHeaders): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === TURN_STATE_HEADER);
}

/** Mutate `headers` in place with `token` unless a caller or earlier hook already set or deleted the header. */
export function applyTurnStateHeader(headers: ProviderHeaders, token: string | undefined): void {
  if (token === undefined || hasTurnStateHeader(headers)) return;
  headers[TURN_STATE_HEADER] = token;
}

/** Write-once sticky-routing token matching Codex's `OnceLock<String>` per-turn contract. */
export class TurnStateSlot {
  private token?: string;

  get value(): string | undefined {
    return this.token;
  }

  observe(value: string | undefined): void {
    if (this.token !== undefined) return;
    const valid = validTurnState(value);
    if (valid !== undefined) this.token = valid;
  }

  observeHeaders(headers: Headers | Readonly<Record<string, string | undefined>>): void {
    if (this.token !== undefined) return;
    this.observe(readTurnStateHeader(headers));
  }

  observeStreamEvent(event: unknown): void {
    if (this.token !== undefined || !isObject(event) || event.type !== "response.metadata" || !isObject(event.headers)) {
      return;
    }
    for (const [key, value] of Object.entries(event.headers)) {
      if (key.toLowerCase() === TURN_STATE_HEADER && typeof value === "string") {
        this.observe(value);
        return;
      }
    }
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
    const slot = this.slotFor(sessionId, target);
    if (!slot || event.provider !== target!.identity.provider ||
        event.api !== target!.identity.api || event.model !== target!.identity.modelId) {
      return;
    }
    slot.observeStreamEvent(event.data);
  }

  applyToHeaders(sessionId: string, target: CapableModel | undefined, headers: ProviderHeaders): void {
    applyTurnStateHeader(headers, this.slotFor(sessionId, target)?.value);
  }

  /**
   * In-turn automatic compactions share the active turn's slot; standalone manual compactions
   * use an isolated slot for their own retries so previous turns never leak into or out of them.
   */
  compactionSlot(sessionId: string, target: CapableModel, reason: "manual" | "threshold" | "overflow"): TurnStateSlot {
    if (reason === "manual") return new TurnStateSlot();
    return this.slotFor(sessionId, target) ?? new TurnStateSlot();
  }

  private slotFor(sessionId: string, target: CapableModel | undefined): TurnStateSlot | undefined {
    const current = this.active;
    return current && target && current.sessionId === sessionId &&
      sameModel(current.identity, target.model) && sameBackend(current.identity, target.identity)
      ? current.slot : undefined;
  }
}

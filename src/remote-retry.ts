// Own bounded V2 retry evidence before Pi adapters reduce errors to message strings.
import { setTimeout as delay } from "node:timers/promises";
import type { Api } from "@earendil-works/pi-ai";
import { isObject, normalizeCompactionEvent } from "./protocol.js";

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_OBSERVED_EVENT_CHARS = 1_048_576;
const TRANSIENT_HTTP = new Set([408, 409, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(["server_error", "server_is_overloaded", "rate_limit_exceeded", "slow_down"]);
const PERMANENT_CODES = new Set([
  "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "usage_limit_reached", "usage_not_included", "context_length_exceeded",
  "invalid_prompt", "invalid_api_key", "authentication_error", "permission_denied", "access_denied",
  "cyber_policy", "bio_policy", "misalignment_policy_violation", "content_filter",
]);
const TRANSIENT_NETWORK = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

export interface RetryEvidence { reason: string; retryAt?: number }

export function compactionRetryLimit(configured?: number): number {
  return Math.max(0, Math.min(MAX_RETRIES, Math.floor(Number.isFinite(configured) ? configured! : MAX_RETRIES)));
}

function retryDeadline(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  const seconds = headers.get("retry-after");
  for (const [value, scale] of [[milliseconds, 1], [seconds, 1_000]] as const) {
    if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      const ms = Number(value) * scale;
      // Numeric overflow is still server advice beyond our cap, not an absent header.
      return Date.now() + ms;
    }
  }
  if (seconds !== null && !/^[+-]?[\d.]+$/.test(seconds.trim())) {
    const date = Date.parse(seconds);
    if (Number.isFinite(date)) return Math.max(Date.now(), date);
  }
  return undefined;
}

export async function waitForCompactionRetry(
  evidence: RetryEvidence, retry: number, maxDelayMs: number | undefined, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  // Pi's zero means no configured ceiling; V2 still enforces its own bounded wait.
  const cap = maxDelayMs !== undefined && Number.isFinite(maxDelayMs) && maxDelayMs > 0
    ? Math.min(maxDelayMs, MAX_RETRY_DELAY_MS) : MAX_RETRY_DELAY_MS;
  const requested = evidence.retryAt === undefined ? undefined : Math.max(0, evidence.retryAt - Date.now());
  if (requested !== undefined && requested > cap) {
    throw new Error(`Remote compaction retry delay exceeds the allowed maximum of ${cap}ms (${evidence.reason})`);
  }
  await delay(requested ?? Math.min(500 * 2 ** retry, cap), undefined, { signal });
  signal.throwIfAborted();
}

function networkFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  for (let current = error; isObject(current) && !visited.has(current); current = current.cause) {
    visited.add(current);
    if (typeof current.code === "string" && TRANSIENT_NETWORK.has(current.code)) return true;
  }
  return false;
}

function classifyError(value: unknown): { code?: string; permanent: boolean; invalid: boolean; message?: string } {
  if (!isObject(value)) return { permanent: false, invalid: true };
  const records = [value, ...(isObject(value.error) ? [value.error] : [])];
  let invalid = value.error !== undefined && !isObject(value.error);
  const codes: string[] = [];
  for (const record of records) {
    // OpenAI error bodies carry `"code": null`; classify those by `type` like an absent code.
    if (record.code !== undefined && record.code !== null) {
      if (typeof record.code === "string" && record.code) codes.push(record.code);
      else invalid = true;
    } else if (typeof record.type === "string" && record.type !== "error" &&
        !record.type.startsWith("response.")) codes.push(record.type);
  }
  const unique = [...new Set(codes)];
  return {
    code: unique.length === 1 ? unique[0] : undefined,
    permanent: codes.some((code) => PERMANENT_CODES.has(code)),
    invalid: invalid || unique.length > 1,
    message: records.map((record) => record.message).find((message): message is string => typeof message === "string"),
  };
}

function rateLimitDeadline(code: string, message: string | undefined): number | undefined {
  // Codex interprets this advice only for explicit rate-limit codes, never arbitrary error prose.
  if (code !== "rate_limit_exceeded" && code !== "slow_down") return undefined;
  const match = message?.match(/\btry again in\s+(\d+(?:\.\d+)?)\s*(ms|seconds?|s)\b/i);
  if (!match) return undefined;
  const ms = Number(match[1]) * (match[2].toLowerCase() === "ms" ? 1 : 1_000);
  return Date.now() + ms;
}

const LF = 0x0a;
const CR = 0x0d;

/** Observe retry evidence before the SDK handles errors, and align delivery with SSE record boundaries. */
class SseEvidenceObserver {
  private readonly decoder = new TextDecoder();
  private line = "";
  private lineHasBytes = false;
  private data: string[] = [];
  private size = 0;
  private event = "";
  private skipLf = false;
  private oversized = false;
  constructor(private readonly attempt: CompactionAttempt, private readonly api: Api) {}

  recordEnd(bytes: Uint8Array, offset: number): number {
    let start = offset;
    if (start < bytes.length && this.skipLf) {
      if (bytes[start] === LF) start++;
      this.skipLf = false;
    }
    for (let i = start; i < bytes.length; i++) {
      const byte = bytes[i];
      if (byte !== CR && byte !== LF) continue;
      this.append(bytes.subarray(start, i + 1), true);
      const blank = !this.lineHasBytes && i === start;
      this.lineHasBytes = false;
      this.finishLine();
      if (byte === CR) {
        if (bytes[i + 1] === LF) i++;
        else this.skipLf = i + 1 === bytes.length;
      }
      start = i + 1;
      if (blank) return start;
    }
    if (start < bytes.length) {
      this.lineHasBytes = true;
      this.append(bytes.subarray(start), false);
    }
    return bytes.length;
  }

  private append(bytes: Uint8Array, endsLine: boolean): void {
    if (this.oversized) return;
    // Decode through the line ending so a split UTF-8 code point stays within its line.
    const decoded = this.decoder.decode(bytes, { stream: true });
    const text = endsLine ? decoded.slice(0, -1) : decoded;
    this.size += text.length;
    if (this.size > MAX_OBSERVED_EVENT_CHARS) {
      this.oversized = true;
      this.line = "";
      this.data = [];
      this.attempt.blockRetry();
      return;
    }
    this.line += text;
  }

  private finishLine(): void {
    if (this.oversized) return;
    const line = this.line;
    this.line = "";
    if (!line) {
      this.observeRecord(true);
      this.data = [];
      this.event = "";
      this.size = 0;
    } else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "data") this.data.push(value);
      if (field === "event") this.event = value;
    }
  }
  finish(): void {
    if (this.oversized) return;
    this.line += this.decoder.decode();
    if (this.line) this.finishLine();
    this.observeRecord(false);
  }

  private observeRecord(framed: boolean): void {
    if (!this.data.length) return;
    const data = this.data.join("\n");
    if (data.trim() === "[DONE]") {
      this.attempt.blockRetry();
      return;
    }
    let value: unknown;
    try { value = JSON.parse(data); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // An undelimited residual record can contain truncated JSON.
      if (framed) this.attempt.blockRetry();
      return;
    }
    this.attempt.observeEvent(normalizeCompactionEvent(this.api, value), this.event);
  }
}

export class CompactionAttempt {
  private evidence?: RetryEvidence;
  private blocked = false;
  private terminal = false;
  private progress = false;
  private eof = false;
  fatal?: { error: unknown };

  blockRetry(error?: unknown): void {
    this.blocked = true;
    if (error !== undefined && !this.fatal) this.fatal = { error };
  }
  fetchFailed(error: unknown): void {
    if (networkFailure(error)) this.evidence = { reason: "transient network failure" };
  }
  observeEvent(value: unknown, eventName?: string): Error | undefined {
    if (!isObject(value)) { this.blockRetry(); return; }
    const response = isObject(value.response) ? value.response : undefined;
    if (eventName === "error" || value.type === "error" || isObject(value.error) || value.type === "response.failed") {
      const error = classifyError(value.type === "response.failed" ? response?.error : value);
      const code = error.code;
      if (!error.invalid && !error.permanent && code && TRANSIENT_CODES.has(code)) {
        this.evidence = { reason: `server error ${code}`, retryAt: rateLimitDeadline(code, error.message) };
        return new Error(`Remote compaction failed temporarily (${code})`);
      }
      this.blockRetry();
    }
    if (typeof value.type !== "string") this.blockRetry();
    if (value.type === "response.completed" ||
        value.type === "response.incomplete" || value.type === "response.failed" || value.type === "response.cancelled") {
      this.terminal = true;
    }
    if (value.type === "response.created" || value.type === "response.in_progress" ||
        value.type === "response.output_item.added" || value.type === "response.output_item.done") this.progress = true;
    return undefined;
  }
  retryEvidence(): RetryEvidence | undefined {
    if (this.blocked || this.terminal) return undefined;
    return this.evidence ?? (this.eof && this.progress ? { reason: "Responses stream ended before its terminal event" } : undefined);
  }

  observeResponse(response: Response, signal: AbortSignal, api: Api, completed: () => boolean): Response {
    if (!response.ok) {
      if (TRANSIENT_HTTP.has(response.status) && response.headers.get("x-should-retry") !== "false") {
        this.evidence = { reason: `HTTP ${response.status}`, retryAt: retryDeadline(response.headers) };
      } else this.blockRetry();
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Pi requests a stream explicitly, so successful bodies are SSE regardless of response headers.
    const sse = response.ok ? new SseEvidenceObserver(this, api) : undefined;
    let errorBody = "";
    let errorBodyTooLarge = false;
    let chunk: Uint8Array | undefined;
    let offset = 0;
    let closed = false;
    let abort: () => void;
    const cleanup = () => {
      closed = true;
      chunk = undefined;
      signal.removeEventListener("abort", abort);
    };
    const cancelSource = (reason?: unknown) => {
      cleanup();
      // A tee peer can keep cancellation pending after this consumer has stopped.
      // The wrapper already delivered its outcome, so observe and ignore a later cancellation error.
      void reader.cancel(reason).catch(() => {});
      reader.releaseLock();
    };
    const inspectErrorBody = (text: string) => {
      if (errorBodyTooLarge) return;
      if (errorBody.length + text.length > MAX_OBSERVED_EVENT_CHARS) {
        errorBodyTooLarge = true;
        errorBody = "";
        this.blockRetry();
      } else errorBody += text;
    };
    const finishErrorBody = () => {
      inspectErrorBody(decoder.decode());
      if (errorBodyTooLarge) return;
      let value: unknown;
      try { value = JSON.parse(errorBody); }
      catch (error) {
        // Gateways can return non-JSON diagnostics, including a partial body before a reset.
        if (!(error instanceof SyntaxError)) throw error;
        return;
      }
      const error = classifyError(value);
      if (error.permanent || error.invalid || (error.code && !TRANSIENT_CODES.has(error.code))) this.blockRetry();
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          if (closed) return;
          controller.error(signal.reason);
          cancelSource(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      pull: async (controller) => {
        try {
          if (sse && completed()) {
            controller.close();
            cancelSource();
            return;
          }
          if (!chunk) {
            const result = await reader.read();
            if (closed) return;
            if (result.done) {
              if (sse) sse.finish();
              else finishErrorBody();
              this.eof = Boolean(sse);
              cleanup();
              reader.releaseLock();
              controller.close();
              return;
            }
            chunk = result.value;
            if (!sse) inspectErrorBody(decoder.decode(chunk, { stream: true }));
          }
          // Observe each record before delivery: the SDK can intercept named errors before Pi sees them.
          const end = sse?.recordEnd(chunk, offset) ?? chunk.length;
          controller.enqueue(offset === 0 && end === chunk.length ? chunk : chunk.subarray(offset, end));
          if (end === chunk.length) {
            chunk = undefined;
            offset = 0;
          } else offset = end;
        } catch (error) {
          if (closed) return;
          if (sse) this.fetchFailed(error);
          else finishErrorBody();
          cleanup();
          reader.releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        if (closed) return;
        cancelSource(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}

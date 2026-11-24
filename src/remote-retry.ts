// Own bounded V2 retry evidence before Pi adapters reduce errors to message strings.
import { setTimeout as delay } from "node:timers/promises";
import type { Api } from "@earendil-works/pi-ai";
import { CODEX_API, isObject } from "./protocol.js";

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_OBSERVED_EVENT_CHARS = 1_048_576;
const TRANSIENT_HTTP = new Set([408, 409, 429, 500, 502, 503, 504]);
const CAPACITY_CODES = new Set(["server_is_overloaded", "policy_capacity_unavailable"]);
const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "slow_down"]);
const HTTP_429_PERMANENT_TYPES = new Set(["usage_limit_reached", "usage_not_included", "insufficient_quota"]);
const HTTP_PERMANENT_CODES = new Set([
  "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "usage_limit_reached", "usage_not_included", "context_length_exceeded",
  "invalid_prompt", "invalid_api_key", "authentication_error", "permission_denied", "access_denied",
  "cyber_policy", "bio_policy", "misalignment_policy_violation", "content_filter",
]);
const TRANSIENT_NETWORK = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

const NS_PER_MS = 1_000_000n;
const NS_PER_SECOND = 1_000n * NS_PER_MS;
const MAX_U64 = (1n << 64n) - 1n;
const I64_LIMIT = 2 ** 63;
// Codex's Rust Instant uses unsigned Duration on Windows and signed seconds on Unix.
const MAX_INSTANT_NS = ((process.platform === "win32" ? MAX_U64 : MAX_U64 >> 1n) + 1n) * NS_PER_SECOND - 1n;

type RetrySchedule = number | "backoff";
interface TransientFailure { readonly retry: RetrySchedule | undefined }
const TRANSIENT_BACKOFF: TransientFailure = { retry: "backoff" };

export function compactionRetryLimit(configured?: number): number {
  return Math.max(0, Math.min(MAX_RETRIES, Math.floor(Number.isFinite(configured) ? configured! : MAX_RETRIES)));
}

function checkedDeadline(delayNs: bigint, receivedAt: bigint): number | undefined {
  const deadline = receivedAt + delayNs;
  return deadline <= MAX_INSTANT_NS ? Number(deadline) / Number(NS_PER_MS) : undefined;
}

function httpDateMs(value: string): number | undefined {
  // Canonicalize obsolete HTTP-date forms before checking the calendar and weekday with Date.
  let imf = value;
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
  const asctime = /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value);
  if (rfc850) {
    const [, weekday, day, month, year, time] = rfc850;
    imf = `${weekday.slice(0, 3)}, ${day} ${month} ${Number(year) < 70 ? "20" : "19"}${year} ${time} GMT`;
  } else if (asctime) {
    const [, weekday, month, day, time, year] = asctime;
    imf = `${weekday}, ${day.trim().padStart(2, "0")} ${month} ${year} ${time} GMT`;
  }
  const date = new Date(imf);
  const year = date.getUTCFullYear();
  return year >= 1970 && year <= 9999 && date.toUTCString() === imf ? date.getTime() : undefined;
}

function retryDeadline(headers: unknown, receivedAt: bigint, wallTime: number): number | undefined {
  let milliseconds: string | undefined;
  let seconds: string | undefined;
  if (headers instanceof Headers) {
    milliseconds = headers.get("retry-after-ms")?.trim();
    seconds = headers.get("retry-after")?.trim();
  } else if (isObject(headers)) {
    for (const name of Object.keys(headers).sort()) {
      const value = headers[name];
      if (typeof value !== "string" && typeof value !== "number") continue;
      const text = String(value);
      // Rust rejects illegal field bytes before interpreting SSE headers as retry advice.
      if (/[^\t\x20-\x7e\x80-\xff]/.test(text)) continue;
      switch (name.toLowerCase()) {
        case "retry-after-ms": milliseconds = text.trim(); break;
        case "retry-after": seconds = text.trim(); break;
      }
    }
  }
  const receivedAtMs = Number(receivedAt) / Number(NS_PER_MS);
  // Pi's millisecond extension treats numeric overflow as advice beyond the wait cap.
  if (milliseconds !== undefined && /^\d+(?:\.\d+)?$/.test(milliseconds)) return receivedAtMs + Number(milliseconds);
  if (seconds === undefined) return undefined;
  if (/^\d+$/.test(seconds)) {
    const digits = seconds.replace(/^0+/, "");
    if (digits.length > MAX_U64.toString().length) return undefined;
    const duration = BigInt(digits);
    return duration <= MAX_U64 ? checkedDeadline(duration * NS_PER_SECOND, receivedAt) : undefined;
  }
  const date = httpDateMs(seconds);
  return date === undefined ? undefined : receivedAtMs + Math.max(0, date - wallTime);
}

export async function waitForCompactionRetry(
  schedule: RetrySchedule, retry: number, maxDelayMs: number | undefined, signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  // Pi's zero means no configured ceiling; V2 still enforces its own bounded wait.
  const cap = maxDelayMs !== undefined && Number.isFinite(maxDelayMs) && maxDelayMs > 0
    ? Math.min(maxDelayMs, MAX_RETRY_DELAY_MS) : MAX_RETRY_DELAY_MS;
  const requested = schedule === "backoff" ? Math.min(500 * 2 ** retry, cap)
    : Math.max(0, schedule - Number(process.hrtime.bigint()) / Number(NS_PER_MS));
  if (requested > cap) return false;
  await delay(requested, undefined, { signal });
  signal.throwIfAborted();
  return true;
}

function networkFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  for (let current = error; isObject(current) && !visited.has(current); current = current.cause) {
    visited.add(current);
    if (typeof current.code === "string" && TRANSIENT_NETWORK.has(current.code)) return true;
  }
  return false;
}

function rateLimitDeadline(message: string | null | undefined, receivedAt: bigint): number | undefined {
  const match = message?.match(/try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (match[2].toLowerCase() === "ms") {
    // Codex truncates fractional milliseconds and saturates the unsigned conversion.
    const wholeMs = Number.isFinite(value) ? BigInt(Math.trunc(value)) : MAX_U64;
    return checkedDeadline((wholeMs > MAX_U64 ? MAX_U64 : wholeMs) * NS_PER_MS, receivedAt);
  }
  if (!Number.isFinite(value)) return undefined;
  const wholeSeconds = Math.trunc(value);
  const fractionalNs = Math.round((value - wholeSeconds) * Number(NS_PER_SECOND));
  return checkedDeadline(BigInt(wholeSeconds) * NS_PER_SECOND + BigInt(fractionalNs), receivedAt);
}

function httpFailure(response: Response, retryAt: number | undefined, value: unknown): TransientFailure | undefined {
  const error = isObject(value) && isObject(value.error) ? value.error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const { status, headers } = response;
  if (code !== undefined && HTTP_PERMANENT_CODES.has(code)) return;
  if (!TRANSIENT_HTTP.has(status) || headers.get("x-should-retry") === "false") return;
  if (status === 429) {
    if (retryAt === undefined || (typeof error?.type === "string" && HTTP_429_PERMANENT_TYPES.has(error.type))) return;
    return { retry: retryAt };
  }
  return { retry: status === 503 && code !== undefined && CAPACITY_CODES.has(code) ? retryAt : retryAt ?? "backoff" };
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
  constructor(private readonly attempt: CompactionAttempt) {}

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
    this.attempt.observeSdkError(value, this.event);
  }
}

export class CompactionAttempt {
  private failure?: TransientFailure;
  private blocked = false;
  private terminal = false;
  private progress = false;
  private eof = false;
  fatal?: { error: unknown };

  constructor(private readonly api: Api) {}

  blockRetry(error?: unknown): void {
    this.blocked = true;
    if (error !== undefined && !this.fatal) this.fatal = { error };
  }
  fetchFailed(error: unknown): void {
    if (!this.terminal && networkFailure(error)) this.failure = TRANSIENT_BACKOFF;
  }
  observeSdkError(value: unknown, name: string): void {
    // OpenAI’s SDK intercepts named errors and truthy data.error before calling Pi’s hook.
    if (this.api !== "openai-responses" || name.startsWith("thread.")) return;
    const event = isObject(value) ? value : undefined;
    if (name === "error" || event?.error) this.observeFailure(event?.error, event);
  }

  private observeFailure(value: unknown, standaloneHeaders?: { headers?: unknown }): Error | undefined {
    if (this.terminal || this.blocked) return;
    this.terminal = true;
    if (!isObject(value)) return;
    const { code, message, headers, type, plan_type: planType, resets_at: resetsAt } = value;
    if (typeof code !== "string" || (message != null && typeof message !== "string")) return;
    // Codex decodes these optional fields before classifying response.failed.
    if (!standaloneHeaders && (
      (type != null && typeof type !== "string") ||
      (planType != null && typeof planType !== "string") ||
      (resetsAt != null && (typeof resetsAt !== "number" || !Number.isInteger(resetsAt) ||
        resetsAt < -I64_LIMIT || resetsAt >= I64_LIMIT))
    )) return;
    const capacity = CAPACITY_CODES.has(code);
    const rateLimited = RATE_LIMIT_CODES.has(code);
    if (!capacity && (standaloneHeaders || (!rateLimited && code !== "server_error"))) return;
    const receivedAt = process.hrtime.bigint();
    const wallTime = Date.now();
    const retryAt = retryDeadline(headers, receivedAt, wallTime) ??
      (standaloneHeaders ? retryDeadline(standaloneHeaders.headers, receivedAt, wallTime)
        : rateLimited ? rateLimitDeadline(message, receivedAt) : undefined);
    this.failure = { retry: capacity ? retryAt : retryAt ?? "backoff" };
    return new Error(message ?? "Remote compaction failed temporarily (" + code + ")");
  }

  observeEvent(value: unknown): Error | undefined {
    if (!isObject(value) || typeof value.type !== "string") { this.blockRetry(); return; }
    if (value.type === "error") return this.observeFailure(value.error, value);
    if (value.type === "response.failed") return this.observeFailure(isObject(value.response) ? value.response.error : undefined);
    if (value.type === "response.incomplete" && !this.terminal && !this.blocked &&
        isObject(value.response) && isObject(value.response.incomplete_details) &&
        value.response.incomplete_details.reason === "content_filter") {
      this.terminal = true;
      this.failure = TRANSIENT_BACKOFF;
      return new Error("Remote compaction failed temporarily (content_filter)");
    }
    if (value.type === "response.completed" || value.type === "response.incomplete" ||
        value.type === "response.cancelled" || (this.api === CODEX_API && value.type === "response.done")) {
      this.terminal = true;
    }
    if (value.type === "response.created" || value.type === "response.in_progress" ||
        value.type === "response.output_item.added" || value.type === "response.output_item.done") this.progress = true;
  }
  outcome(): TransientFailure | undefined {
    if (this.blocked) return;
    return this.failure ?? (!this.terminal && this.eof && this.progress ? TRANSIENT_BACKOFF : undefined);
  }

  observeResponse(response: Response, signal: AbortSignal, completed: () => boolean): Response {
    const retryAt = response.ok ? undefined : retryDeadline(response.headers, process.hrtime.bigint(), Date.now());
    if (!response.body) {
      if (!response.ok) this.failure = httpFailure(response, retryAt, undefined);
      return response;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Pi requests a stream explicitly, so successful bodies are SSE regardless of response headers.
    const sse = response.ok ? new SseEvidenceObserver(this) : undefined;
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
      try { if (errorBody) value = JSON.parse(errorBody); }
      catch (error) {
        // Gateways can return non-JSON diagnostics, including a partial body before a reset.
        if (!(error instanceof SyntaxError)) throw error;
      }
      this.failure = httpFailure(response, retryAt, value);
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

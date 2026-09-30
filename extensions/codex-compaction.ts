// Own Pi lifecycle integration, active-session ownership, and checkpoint replay hooks.
import { prepareRetention, userItemOrigins } from "./retention-input.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildReplacementHistory } from "./retention.js";
import {
  capableModel,
  sameBackend,
  sameProvider,
  type CapableModel,
  type ProviderIdentity,
} from "./capability.js";
import {
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  keptMessages,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
  projectCheckpointRequest,
} from "./checkpoint.js";
import { hasCheckpointMarker, isObject, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker } from "./protocol.js";
import { CACHE_PROBE_LOG, cacheProbeEnabled, describeCachePrefix, recordCacheProbe } from "./cache-probe.js";
import { requestRemoteCompaction } from "./remote.js";

const STATUS_KEY = "codex-compaction";
const COMPLETION_ENTRY_TYPE = "pi-codex-compaction-completed";
const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";

type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

interface CompletionEntryData {
  message: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  checkpointId: string;
}


function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}


async function compatibleIdentity(
  details: CodexCheckpointDetails,
  ctx: ExtensionContext,
  model = ctx.model,
): Promise<CapableModel | undefined> {
  if (!model || !sameProvider(details, model)) return undefined;
  // Resolve only endpoint identity here; Pi still owns authorization and request dispatch.
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  const supported = capableModel(model, auth.baseUrl);
  return supported && sameBackend(details, supported.identity) ? supported : undefined;
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const enabled = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => enabled.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

// Mirror Pi's request-time image blocking, including its deduplicated placeholders.
function withoutImages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content) ||
        !message.content.some((part) => part.type === "image")) return message;
    const content = message.content
      .map((part) => part.type === "image" ? { type: "text" as const, text: BLOCKED_IMAGE_TEXT } : part)
      .filter((part, index, parts) => !(part.type === "text" && part.text === BLOCKED_IMAGE_TEXT && index > 0 &&
        parts[index - 1].type === "text" && (parts[index - 1] as { text: string }).text === BLOCKED_IMAGE_TEXT));
    return { ...message, content } as Message;
  });
}

// Pi 0.99 transcripts declare the prompt and tools through system messages, as ordinary requests do.
function requestContext(pi: ExtensionAPI, ctx: ExtensionContext, messages: AgentMessage[], settings: PiSettings): Context {
  const converted = convertToLlm(messages);
  const llmMessages = settings.images?.blockImages ? withoutImages(converted) : converted;
  if (llmMessages.some((message) => message.role === "system")) return { messages: llmMessages };
  return { systemPrompt: ctx.getSystemPrompt(), messages: llmMessages, tools: activeTools(pi) };
}

function websocketConnectTimeoutMs(value: unknown): number | undefined {
  const parsed = typeof value === "string"
    ? value.trim().toLowerCase() === "disabled" ? 0 : value.trim() ? Number(value.trim()) : undefined
    : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  identity: ProviderIdentity,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries)?.details;
  if (!prior) return { messages: session.messages };
  if (!sameProvider(prior, identity)) {
    throw new Error("The active opaque checkpoint belongs to a different provider backend");
  }
  const projected = projectCheckpointRequest(session.messages, prior);
  if (!projected) throw new Error("The previous opaque checkpoint could not be projected safely");
  return { messages: projected, prior };
}

async function replayCheckpoint(payload: unknown, ctx: ExtensionContext): Promise<JsonObject | undefined> {
  const checkpoint = activeCheckpoint(ctx);
  if (!checkpoint) return undefined;
  const marker = checkpointMarker(checkpoint.details.checkpointId);
  if (!hasCheckpointMarker(payload, marker)) return undefined;
  if (!await compatibleIdentity(checkpoint.details, ctx)) {
    throw new Error("The active opaque checkpoint no longer matches the resolved provider endpoint");
  }
  return rewriteCheckpointMarker(payload, marker, checkpoint.details.replacementHistory);
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Codex remote compaction failed; using Pi compaction. ${message}`, "warning");
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  fetch?: typeof globalThis.fetch,
  lastRequest?: JsonObject,
) {
  const supported = capableModel(ctx.model);
  if (!supported) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const reasoning = pi.getThinkingLevel();
  const settings = pi.getSettings();
  let announced = false;
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction...");
  try {
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (event.customInstructions?.trim() && ctx.hasUI) {
      ctx.ui.notify("Codex Remote Compaction V2 does not accept custom instructions; they are ignored.", "warning");
    }
    const current = projectedCurrentMessages(event, supported.identity);
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: requestContext(pi, ctx, current.messages, settings),
      userItemOrigins: userItemOrigins(current.messages),
      reasoning,
      sessionId,
      transport: settings.transport,
      thinkingBudgets: settings.thinkingBudgets,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
      websocketConnectTimeoutMs: websocketConnectTimeoutMs(settings.websocketConnectTimeoutMs),
      signal: event.signal,
      onPrepared: (payload) => {
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session ownership changed");
        // Provider retries prepare the payload again; announce the compaction once.
        if (announced) return;
        announced = true;
        if (cacheProbeEnabled()) {
          const probe = lastRequest
            ? describeCachePrefix(lastRequest, payload)
            : "Cache probe: no ordinary request was observed in this Pi process before compaction.";
          recordCacheProbe(probe);
          if (ctx.hasUI) ctx.ui.notify(`${probe}\n(${CACHE_PROBE_LOG})`, "info");
        }
        if (ctx.hasUI) ctx.ui.notify(
          `Starting Codex Remote Compaction V2 for ${supported.identity.provider}/${supported.identity.modelId}.`,
          "info",
        );
      },
      priorCheckpoint: current.prior
        ? {
            identity: current.prior,
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      fetch,
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const retention = await prepareRetention(response.promptInput, event.signal, {
      images: response.images,
      contextual: response.contextual,
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const replacementHistory = buildReplacementHistory(retention, response.item);
    const details = createCheckpointDetails({
      identity: response.identity,
      replacementHistory,
      keptMessages: keptMessages(event.branchEntries, event.preparation.firstKeptEntryId),
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    if (event.signal.aborted || ctx.sessionManager.getSessionId() !== sessionId) {
      return { cancel: true };
    }
    notifyFailure(ctx, error);
    return undefined;
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function createCodexCompactionExtension(
  options: { fetch?: typeof globalThis.fetch } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const warnings = new Set<string>();
    let lastRequest: JsonObject | undefined;

    pi.registerEntryRenderer<CompletionEntryData>(
      COMPLETION_ENTRY_TYPE,
      (entry, _options, theme) => {
        const message = entry.data?.message;
        return typeof message === "string"
          ? new Text(theme.fg("success", message), 1, 0)
          : undefined;
      },
    );

    pi.on("session_start", () => {
      warnings.clear();
      lastRequest = undefined;
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, options.fetch, lastRequest),
    );

    pi.on("session_compact", (event) => {
      if (!event.fromExtension) return;
      const details = parseCheckpointDetails(event.compactionEntry.details);
      if (!details) return;
      pi.appendEntry<CompletionEntryData>(COMPLETION_ENTRY_TYPE, {
        message: `Codex Remote Compaction V2 completed for ${details.provider}/${details.modelId}.`,
        protocol: REMOTE_COMPACTION_PROTOCOL,
        checkpointId: details.checkpointId,
      });
    });

    pi.on("context", async (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !await compatibleIdentity(checkpoint.details, ctx)) return undefined;
      const messages = projectCheckpointContext(event.messages, checkpoint.details);
      if (messages) return { messages };
      const key = `${ctx.sessionManager.getSessionId()}:${checkpoint.details.checkpointId}:projection`;
      if (!warnings.has(key)) {
        warnings.add(key);
        if (ctx.hasUI) {
          ctx.ui.notify(
            "The active Codex checkpoint no longer matches the retained messages, so its opaque history is not replayed.",
            "warning",
          );
        }
      }
      return undefined;
    });

    pi.on("before_provider_request", async (event, ctx) => {
      const payload = await replayCheckpoint(event.payload, ctx);
      // The probe keeps the payload this extension hands on; later handlers may still change it.
      if (cacheProbeEnabled() && isObject(payload ?? event.payload)) lastRequest = structuredClone(payload ?? event.payload) as JsonObject;
      return payload;
    });

    pi.on("model_select", async (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || await compatibleIdentity(checkpoint.details, ctx, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (warnings.has(key)) return;
      warnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Codex checkpoint cannot replay on this provider backend; only its fallback marker and retained recent messages remain available.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      warnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

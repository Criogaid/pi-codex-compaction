// Own Pi lifecycle integration, active-session ownership, and checkpoint replay hooks.
import { prepareRetention, userItemOrigins } from "./retention-input.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type Context, type Message, type Tool } from "@earendil-works/pi-ai";
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
  sameModel,
  type CapableModel,
  type ProviderIdentity,
} from "./capability.js";
import {
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  keptMessages,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
  projectCheckpointRequest,
} from "./checkpoint.js";
import { hasCheckpointMarker, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker } from "./protocol.js";
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

interface EffectiveSystemPrompt {
  readonly sessionId: string;
  readonly identity: ProviderIdentity;
  readonly sourceFingerprint: string;
  readonly text: string;
}

interface EffectiveRequestContext {
  readonly sessionId: string;
  readonly identity: ProviderIdentity;
  readonly sourceFingerprints: readonly string[];
  readonly messages: readonly AgentMessage[];
}

// Collapse source system state only for matching; preserve Pi's actual projected transcript for sending.
function requestSource(messages: readonly AgentMessage[]): AgentMessage[] {
  const head = getCurrentSystemMessage(convertToLlm([...messages]));
  const conversation = messages.filter((message) => message.role !== "system");
  return head ? [head, ...conversation] : conversation;
}

function reuseRequestContext(messages: AgentMessage[], snapshot: EffectiveRequestContext | undefined): AgentMessage[] {
  if (!snapshot) return messages;
  const source = requestSource(messages);
  if (source.length < snapshot.sourceFingerprints.length || snapshot.sourceFingerprints.some(
    (fingerprint, index) => fingerprintMessage(source[index]) !== fingerprint,
  )) return messages;
  return [...structuredClone(snapshot.messages), ...source.slice(snapshot.sourceFingerprints.length)];
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
function requestContext(pi: ExtensionAPI, ctx: ExtensionContext, messages: AgentMessage[], settings: PiSettings, effectivePrompt?: EffectiveSystemPrompt): Context {
  const converted = convertToLlm(messages);
  const llmMessages = settings.images?.blockImages ? withoutImages(converted) : converted;
  if (effectivePrompt) {
    const head = getCurrentSystemMessage(llmMessages);
    if (head) {
      // Pi applies per-run prompt overrides after context hooks and clears them when the run ends.
      const { sections: _sections, ...declarations } = head;
      return { messages: [{ ...declarations, content: effectivePrompt.text }, ...llmMessages.filter((message) => message.role !== "system")] };
    }
  }
  if (llmMessages.some((message) => message.role === "system")) return { messages: llmMessages };
  return { systemPrompt: ctx.getSystemPrompt(), messages: llmMessages, tools: activeTools(pi) };
}

function captureEffectiveSystemPrompt(ctx: ExtensionContext): EffectiveSystemPrompt | undefined {
  const supported = capableModel(ctx.model);
  if (!supported) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const messages = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
  const head = getCurrentSystemMessage(convertToLlm(messages));
  if (!head) return undefined;
  const text = ctx.getSystemPrompt();
  if (text === getSystemMessageText(head)) return undefined;
  return { sessionId: ctx.sessionManager.getSessionId(), identity: supported.identity, sourceFingerprint: fingerprintMessage(head), text };
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
  lastSystemPrompt?: EffectiveSystemPrompt,
  lastContext?: EffectiveRequestContext,
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
    const sourceHead = getCurrentSystemMessage(convertToLlm(current.messages));
    const effectivePrompt = lastSystemPrompt?.sessionId === sessionId && sourceHead &&
      fingerprintMessage(sourceHead) === lastSystemPrompt.sourceFingerprint &&
      sameModel(lastSystemPrompt.identity, supported.model) && sameBackend(lastSystemPrompt.identity, supported.identity)
      ? lastSystemPrompt : undefined;
    const snapshot = lastContext?.sessionId === sessionId &&
      sameModel(lastContext.identity, supported.model) && sameBackend(lastContext.identity, supported.identity)
      ? lastContext : undefined;
    const messages = reuseRequestContext(current.messages, snapshot);
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: requestContext(pi, ctx, messages, settings, effectivePrompt),
      userItemOrigins: userItemOrigins(messages),
      reasoning,
      sessionId,
      transport: settings.transport,
      thinkingBudgets: settings.thinkingBudgets,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
      websocketConnectTimeoutMs: websocketConnectTimeoutMs(settings.websocketConnectTimeoutMs),
      signal: event.signal,
      onPrepared: () => {
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session ownership changed");
        // Provider retries prepare the payload again; announce the compaction once.
        if (announced) return;
        announced = true;
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
    let lastSystemPrompt: EffectiveSystemPrompt | undefined;
    let pendingSource: { readonly sessionId: string; readonly fingerprints: readonly string[] } | undefined;
    let pendingContext: EffectiveRequestContext | undefined;
    let lastContext: EffectiveRequestContext | undefined;

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
      lastSystemPrompt = undefined;
      pendingSource = undefined;
      pendingContext = undefined;
      lastContext = undefined;
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, options.fetch, lastSystemPrompt, lastContext),
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
      pendingSource = { sessionId: ctx.sessionManager.getSessionId(), fingerprints: event.messages.map(fingerprintMessage) };
      pendingContext = undefined;
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

    pi.on("context_with_system", (event, ctx) => {
      const supported = capableModel(ctx.model);
      const sessionId = ctx.sessionManager.getSessionId();
      const branch = ctx.sessionManager.getBranch();
      const canonical = buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
      const conversation = canonical.filter((message) => message.role !== "system");
      // Request-local, unpersisted messages cannot be aligned safely with the session's future suffix.
      const matches = pendingSource?.sessionId === sessionId && pendingSource.fingerprints.length === conversation.length &&
        pendingSource.fingerprints.every((fingerprint, index) => fingerprintMessage(conversation[index]) === fingerprint);
      const prior = latestCheckpoint(branch)?.details;
      const source = prior ? projectCheckpointRequest(canonical, prior) : canonical;
      pendingContext = supported && matches && source ? {
        sessionId, identity: supported.identity, sourceFingerprints: requestSource(source).map(fingerprintMessage),
        messages: structuredClone(event.messages),
      } : undefined;
      pendingSource = undefined;
    });

    pi.on("before_provider_request", async (event, ctx) => {
      const payload = await replayCheckpoint(event.payload, ctx);
      lastSystemPrompt = captureEffectiveSystemPrompt(ctx);
      // Keep the pending snapshot for retries that prepare a payload without running context hooks again.
      lastContext = pendingContext;
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
      lastSystemPrompt = undefined;
      pendingSource = undefined;
      pendingContext = undefined;
      lastContext = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

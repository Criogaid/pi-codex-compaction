// Own Pi lifecycle integration, active-session ownership, checkpoint replay hooks, and ordinary-request snapshot state.
import { resolve } from "node:path";
import { prepareRetention, userItemOrigins } from "./retention-input.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Message, Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  getAgentDir,
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
  fingerprintMessage,
  keptMessages,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
  projectCheckpointRequest,
} from "./checkpoint.js";
import { hasCheckpointMarker, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import { requestFallbackCompaction } from "./fallback.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings, type CompactionConfiguration } from "./fallback-settings.js";
import { registerCompactionCommand } from "./fallback-command.js";
import {
  applyPromptOverride,
  captureContextSnapshot,
  capturePromptOverride,
  type ContextSnapshot,
  matchesConversation,
  promptOverrideFor,
  type PromptOverride,
  reuseContextSnapshot,
  snapshotFor,
} from "./request-snapshot.js";

const STATUS_KEY = "codex-compaction";
const COMPLETION_ENTRY_TYPE = "pi-codex-compaction-completed";
const BLOCKED_IMAGE_TEXT = "Image reading is disabled.";

type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

interface CompletionEntryData {
  message: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  checkpointId: string;
}

// Ordinary-request state that compaction reuses; it lives only as long as the Pi process.
interface RequestSnapshots {
  promptOverride?: PromptOverride;
  pendingSource?: { readonly sessionId: string; readonly fingerprints: readonly string[] };
  pendingContext?: ContextSnapshot;
  context?: ContextSnapshot;
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
function requestContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: AgentMessage[],
  settings: PiSettings,
  promptOverride?: PromptOverride,
): Context {
  const converted = convertToLlm(messages);
  const llmMessages = settings.images?.blockImages ? withoutImages(converted) : converted;
  const overridden = promptOverride && applyPromptOverride(llmMessages, promptOverride);
  if (overridden) return { messages: overridden };
  if (llmMessages.some((message) => message.role === "system")) return { messages: llmMessages };
  return { systemPrompt: ctx.getSystemPrompt(), messages: llmMessages, tools: activeTools(pi) };
}

function canonicalMessages(ctx: ExtensionContext): AgentMessage[] {
  const branch = ctx.sessionManager.getBranch();
  return buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
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

async function compactFallback(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  sessionId: string,
  configuration: CompactionConfiguration,
  remoteError?: unknown,
) {
  let announced = false;
  try {
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const result = await requestFallbackCompaction({
      configuration: configuration.fallback,
      modelRegistry: ctx.modelRegistry,
      preparation: event.preparation,
      settings: pi.getSettings(),
      customInstructions: event.customInstructions,
      signal: event.signal,
      sessionId,
      onPrepared: ({ model, thinkingLevel }) => {
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session ownership changed");
        if (announced) return;
        announced = true;
        ctx.ui.setStatus(STATUS_KEY, "Pi fallback compaction...");
        if (ctx.hasUI) {
          if (remoteError !== undefined) {
            const message = remoteError instanceof Error ? remoteError.message : String(remoteError);
            ctx.ui.notify(`Codex remote compaction failed; using the configured fallback model. ${message}`, "warning");
          }
          ctx.ui.notify(`Using Pi text compaction with ${model.provider}/${model.id} (${thinkingLevel}).`, "info");
        }
      },
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (!result && remoteError !== undefined) notifyFailure(ctx, remoteError);
    return result;
  } catch (error) {
    if (sessionStillOwned(ctx, sessionId, event.signal) && ctx.hasUI) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Configured fallback compaction failed; compaction stopped. ${message}`, "error");
    }
    // Returning undefined would make Pi send the same context to the active chat model.
    return { cancel: true };
  } finally {
    if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  compactionSettingsPath: string,
  fetch?: typeof globalThis.fetch,
  snapshots: Readonly<RequestSnapshots> = {},
) {
  const supported = capableModel(ctx.model);
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
  let configuration: CompactionConfiguration;
  try {
    configuration = (await loadCompactionSettings(compactionSettingsPath)).configuration;
  } catch (error) {
    if (sessionStillOwned(ctx, sessionId, event.signal) && ctx.hasUI) {
      ctx.ui.notify(`Could not read compaction settings; compaction stopped. ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    return { cancel: true };
  }
  if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
  if (!configuration.remoteCompactionEnabled || !supported) return compactFallback(pi, event, ctx, sessionId, configuration);
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
    const promptOverride = promptOverrideFor(snapshots.promptOverride, sessionId, supported, current.messages);
    const messages = reuseContextSnapshot(current.messages, snapshotFor(snapshots.context, sessionId, supported));
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: requestContext(pi, ctx, messages, settings, promptOverride),
      userItemOrigins: userItemOrigins(messages),
      reasoning,
      sessionId,
      thinkingBudgets: settings.thinkingBudgets,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
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
    return await compactFallback(pi, event, ctx, sessionId, configuration, error);
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
    const compactionSettingsPath = resolve(getAgentDir(), COMPACTION_SETTINGS_RELATIVE_PATH);
    registerCompactionCommand(pi, compactionSettingsPath);
    const warnings = new Set<string>();
    let snapshots: RequestSnapshots = {};

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
      snapshots = {};
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, compactionSettingsPath, options.fetch, snapshots),
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
      // Pi clones context messages per request, so fingerprints are never cached; hash only when V2 can reuse them.
      snapshots.pendingSource = capableModel(ctx.model)
        ? { sessionId: ctx.sessionManager.getSessionId(), fingerprints: event.messages.map(fingerprintMessage) }
        : undefined;
      snapshots.pendingContext = undefined;
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
      const pending = snapshots.pendingSource;
      snapshots.pendingSource = undefined;
      snapshots.pendingContext = undefined;
      if (!supported || pending?.sessionId !== sessionId) return;
      const canonical = canonicalMessages(ctx);
      // Request-local, unpersisted messages cannot be aligned safely with the session's future suffix.
      if (!matchesConversation(pending.fingerprints, canonical)) return;
      const prior = latestCheckpoint(ctx.sessionManager.getBranch())?.details;
      const source = prior ? projectCheckpointRequest(canonical, prior) : canonical;
      if (source) snapshots.pendingContext = captureContextSnapshot(sessionId, supported, source, event.messages);
    });

    pi.on("before_provider_request", async (event, ctx) => {
      const payload = await replayCheckpoint(event.payload, ctx);
      const supported = capableModel(ctx.model);
      snapshots.promptOverride = supported && capturePromptOverride(
        canonicalMessages(ctx), ctx.sessionManager.getSessionId(), supported, ctx.getSystemPrompt(),
      );
      // Keep the pending snapshot for retries that prepare a payload without running context hooks again.
      snapshots.context = snapshots.pendingContext;
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
      snapshots = {};
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

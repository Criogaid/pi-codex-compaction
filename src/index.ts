// Own Pi lifecycle integration, active-session ownership, checkpoint replay hooks, and compaction orchestration.
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { prepareRetention, userItemOrigins } from "./retention-input.js";
import { buildReplacementHistory } from "./retention.js";
import {
  capableModel,
  sameBackend,
  sameProvider,
  type CapableModel,
  type ProviderIdentity,
} from "./capability.js";
import {
  type CheckpointResolution,
  type CodexCheckpointDetails,
  checkpointMarker,
  checkpointHistory,
  createCheckpointDetails,
  createLayeredCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  keptMessages,
  parseCheckpointDetails,
  projectCheckpointRequest,
  projectCheckpointTranscript,
  prepareCheckpointLayer,
  resolveLatestCheckpoint,
} from "./checkpoint.js";
import { hasCheckpointMarker, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker, withoutInputImages } from "./protocol.js";
import { requestRemoteCompaction, RemoteCompactionTransientError } from "./remote.js";
import { requestFallbackCompaction } from "./fallback.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings, type CompactionConfiguration } from "./fallback-settings.js";
import { registerCompactionCommand } from "./fallback-command.js";
import { compactionRequest, RequestSnapshotTracker, type ProviderRequestInputs, type RequestSnapshots } from "./request-snapshot.js";

const STATUS_KEY = "codex-compaction";
const COMPLETION_ENTRY_TYPE = "pi-codex-compaction-completed";
const INCOMPATIBLE_BACKEND_WARNING =
  "The active Codex checkpoint cannot replay on this provider backend; only its fallback marker and retained recent messages remain available.";

interface CompletionEntryData {
  message: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  checkpointId: string;
}

function activeCheckpoint(ctx: ExtensionContext): CodexCheckpointDetails | undefined {
  const checkpoint = resolveLatestCheckpoint(ctx.sessionManager.getBranch());
  return checkpoint.state === "parsed" ? checkpoint.details : undefined;
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

function providerRequestInputs(pi: ExtensionAPI, ctx: ExtensionContext): ProviderRequestInputs {
  return {
    systemPrompt: ctx.getSystemPrompt(), thinkingLevel: pi.getThinkingLevel(), settings: pi.getSettings(),
    activeTools: pi.getActiveTools(), tools: pi.getAllTools(),
  };
}

function canonicalMessages(ctx: ExtensionContext): AgentMessage[] {
  const branch = ctx.sessionManager.getBranch();
  return buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  identity: ProviderIdentity,
  prior: CodexCheckpointDetails | undefined,
): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  if (!prior) return session.messages;
  if (!sameProvider(prior, identity)) {
    throw new Error("The active opaque checkpoint belongs to a different provider backend");
  }
  const projected = projectCheckpointRequest(session.messages, prior);
  if (!projected) throw new Error("The previous opaque checkpoint could not be projected safely");
  return projected;
}

async function replayCheckpoint(payload: unknown, ctx: ExtensionContext, blockImages: boolean): Promise<JsonObject | undefined> {
  const checkpoint = activeCheckpoint(ctx);
  if (!checkpoint) return undefined;
  const marker = checkpointMarker(checkpoint.checkpointId);
  if (!hasCheckpointMarker(payload, marker)) return undefined;
  if (!await compatibleIdentity(checkpoint, ctx)) {
    throw new Error("The active opaque checkpoint no longer matches the resolved provider endpoint");
  }
  const history = checkpointHistory(checkpoint);
  return rewriteCheckpointMarker(payload, marker, blockImages ? withoutInputImages(history) : history);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(`Codex remote compaction failed; using Pi compaction. ${errorMessage(error)}`, "warning");
}

/** A model switch never cancels compaction; it finishes with the model selected when it started, as Pi's does. */
function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactFallback(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  sessionId: string,
  configuration: CompactionConfiguration,
  remoteError: unknown,
  layer?: {
    prior: CodexCheckpointDetails;
    selection: NonNullable<Parameters<typeof requestFallbackCompaction>[0]["defaultModel"]>;
  },
) {
  let announced = false;
  try {
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const boundary = layer ? prepareCheckpointLayer(event.branchEntries, event.preparation.firstKeptEntryId, layer.prior) : undefined;
    if (boundary && boundary.messages.length === 0) return { cancel: true };
    const preparation = boundary ? {
      ...event.preparation,
      messagesToSummarize: boundary.messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: layer?.prior.textSummary,
      // Do not leak old file operations through Pi's appended file list.
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    } : event.preparation;
    const result = await requestFallbackCompaction({
      summaryModel: configuration.summaryModel,
      defaultModel: layer?.selection,
      modelRegistry: ctx.modelRegistry,
      preparation,
      settings: pi.getSettings(),
      customInstructions: event.customInstructions,
      signal: event.signal,
      sessionId,
      onPrepared: ({ model, thinkingLevel }) => {
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session changed");
        if (announced) return;
        announced = true;
        ctx.ui.setStatus(STATUS_KEY, "Pi fallback compaction...");
        if (ctx.hasUI) {
          if (remoteError !== undefined) {
            ctx.ui.notify(`Codex remote compaction failed; using the configured summary model. ${errorMessage(remoteError)}`, "warning");
          }
          ctx.ui.notify(`Using Pi text compaction with ${model.provider}/${model.id} (${thinkingLevel}).`, "info");
        }
      },
    });
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    if (layer && boundary) {
      if (!result) throw new Error("Layered compaction did not produce a summary");
      if (!await compatibleIdentity(layer.prior, ctx, layer.selection.model)) {
        throw new Error("The opaque checkpoint backend changed during layered compaction");
      }
      if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
      // Revalidate the source and cut after the asynchronous summary request.
      const current = prepareCheckpointLayer(ctx.sessionManager.getBranch(), preparation.firstKeptEntryId, layer.prior);
      if (current.messages.length !== boundary.messages.length ||
          current.messages.some((message, index) => fingerprintMessage(message) !== fingerprintMessage(boundary.messages[index])) ||
          current.retained.length !== boundary.retained.length ||
          current.retained.some((message, index) => fingerprintMessage(message) !== fingerprintMessage(boundary.retained[index]))) {
        throw new Error("The layered compaction source changed");
      }
      const details = createLayeredCheckpointDetails(layer.prior, boundary, result.compaction.summary);
      return { compaction: { ...result.compaction, summary: fallbackSummary(details.checkpointId), details } };
    }
    if (!result && remoteError !== undefined) notifyFailure(ctx, remoteError);
    return result;
  } catch (error) {
    if (sessionStillOwned(ctx, sessionId, event.signal) && ctx.hasUI) {
      ctx.ui.notify(`Configured summary model failed; compaction stopped. ${errorMessage(error)}`, "error");
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
  snapshots: RequestSnapshots = {},
) {
  const supported = capableModel(ctx.model);
  const sessionId = ctx.sessionManager.getSessionId();
  const owned = () => sessionStillOwned(ctx, sessionId, event.signal);
  if (!owned()) return { cancel: true };
  let configuration: CompactionConfiguration;
  try {
    configuration = (await loadCompactionSettings(compactionSettingsPath)).configuration;
  } catch (error) {
    if (owned() && ctx.hasUI) {
      ctx.ui.notify(`Could not read compaction settings; compaction stopped. ${errorMessage(error)}`, "error");
    }
    return { cancel: true };
  }
  if (!owned()) return { cancel: true };
  if (!configuration.remoteCompactionEnabled || !supported) return compactFallback(pi, event, ctx, sessionId, configuration, undefined);
  const reasoning = pi.getThinkingLevel();
  const settings = pi.getSettings();
  let checkpoint: CheckpointResolution | undefined;
  let prior: CodexCheckpointDetails | undefined;
  let announced = false;
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction...");
  try {
    if (!owned()) return { cancel: true };
    checkpoint = resolveLatestCheckpoint(event.branchEntries);
    if (checkpoint.state === "invalid") {
      throw new Error("The previous checkpoint format is invalid or unsupported");
    }
    if (event.customInstructions?.trim() && ctx.hasUI) {
      ctx.ui.notify("Codex Remote Compaction V2 does not accept custom instructions; they are ignored.", "warning");
    }
    prior = checkpoint.state === "parsed" ? checkpoint.details : undefined;
    const currentMessages = projectedCurrentMessages(event, supported.identity, prior);
    const request = compactionRequest(snapshots, sessionId, supported, currentMessages, providerRequestInputs(pi, ctx), {
      blockImages: settings.images?.blockImages ?? false,
      tools: () => activeTools(pi),
    });
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: request.context,
      userItemOrigins: userItemOrigins(request.messages),
      providerRequest: request.providerRequest,
      reasoning,
      sessionId,
      thinkingBudgets: settings.thinkingBudgets,
      blockImages: settings.images?.blockImages ?? false,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
      signal: event.signal,
      onPrepared: () => {
        if (!owned()) throw new Error("Compaction session changed");
        // Provider retries prepare the payload again; announce the compaction once.
        if (announced) return;
        announced = true;
        if (ctx.hasUI) ctx.ui.notify(
          `Starting Codex Remote Compaction V2 for ${supported.identity.provider}/${supported.identity.modelId}.`,
          "info",
        );
      },
      priorCheckpoint: prior
        ? {
            identity: prior,
            marker: checkpointMarker(prior.checkpointId),
            replacementHistory: checkpointHistory(prior),
            contextualFrom: prior.replacementHistory.length,
          }
        : undefined,
      fetch,
    });
    if (!owned()) return { cancel: true };
    const retention = prepareRetention(response.promptInput, event.signal, {
      images: response.images,
      contextual: response.contextual,
    });
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
    if (!owned()) {
      return { cancel: true };
    }
    // A failure during checkpoint resolution cannot establish that native fallback is safe.
    if (checkpoint?.state === "none") return await compactFallback(pi, event, ctx, sessionId, configuration, error);
    try {
      if (!prior || !(error instanceof RemoteCompactionTransientError) ||
          !await compatibleIdentity(prior, ctx, supported.model)) {
        throw new Error("The failed remote request is not eligible for safe layered recovery", { cause: error });
      }
      return await compactFallback(pi, event, ctx, sessionId, configuration, error, {
        prior, selection: { model: supported.model, thinkingLevel: reasoning },
      });
    } catch (failure) {
      if (owned() && ctx.hasUI) ctx.ui.notify(`Compaction stopped; previous history was preserved. ${errorMessage(failure)}`, "error");
      return { cancel: true };
    }
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
    const snapshots = new RequestSnapshotTracker();
    const warnOnce = (ctx: ExtensionContext, key: string, message: string) => {
      const scoped = `${ctx.sessionManager.getSessionId()}:${key}`;
      if (warnings.has(scoped)) return;
      warnings.add(scoped);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };

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
      snapshots.reset();
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, compactionSettingsPath, options.fetch, snapshots.current()),
    );

    pi.on("session_compact", async (event, ctx) => {
      if (!event.fromExtension) return;
      const details = parseCheckpointDetails(event.compactionEntry.details);
      if (!details) return;
      pi.appendEntry<CompletionEntryData>(COMPLETION_ENTRY_TYPE, {
        message: details.version === 2
          ? `Layered text fallback completed for ${details.provider}/${details.modelId}.`
          : `Codex Remote Compaction V2 completed for ${details.provider}/${details.modelId}.`,
        protocol: REMOTE_COMPACTION_PROTOCOL,
        checkpointId: details.checkpointId,
      });
      // The model may have switched to another backend while compaction ran.
      if (await compatibleIdentity(details, ctx)) return;
      warnOnce(ctx, `${details.checkpointId}:backend`, INCOMPATIBLE_BACKEND_WARNING);
    });

    pi.on("context", (_event, ctx) => {
      snapshots.recordContext(ctx.sessionManager.getSessionId(), capableModel(ctx.model), () => canonicalMessages(ctx));
    });

    // Pi runs every extension's `context` handlers first, so none of them sees the marker and load order cannot
    // change the projection. Later `context_with_system` handlers still see and can change it.
    pi.on("context_with_system", async (event, ctx) => {
      let messages: AgentMessage[] | undefined;
      const checkpoint = activeCheckpoint(ctx);
      if (checkpoint && await compatibleIdentity(checkpoint, ctx)) {
        messages = projectCheckpointTranscript(event.messages, canonicalMessages(ctx), checkpoint);
        if (!messages) {
          snapshots.reset();
          warnOnce(ctx, `${checkpoint.checkpointId}:projection`,
            "The active Codex checkpoint no longer matches this request's retained messages, so its opaque history is not replayed.");
        }
      }
      snapshots.recordProjectedRequest(
        ctx.sessionManager.getSessionId(),
        capableModel(ctx.model),
        () => canonicalMessages(ctx),
        () => activeCheckpoint(ctx),
        messages ?? event.messages,
      );
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", async (event, ctx) => {
      const payload = await replayCheckpoint(event.payload, ctx, pi.getSettings().images?.blockImages ?? false);
      snapshots.recordProviderRequest(
        ctx.sessionManager.getSessionId(),
        capableModel(ctx.model),
        () => canonicalMessages(ctx),
        () => ctx.getSystemPrompt(),
        // Keep the wire marker in the snapshot; ordinary requests and V2 each replay it exactly once.
        () => ({ payload: event.payload, inputs: providerRequestInputs(pi, ctx) }),
      );
      return payload;
    });

    pi.on("agent_settled", (_event, ctx) => {
      snapshots.recordSettledRun(ctx.sessionManager.getSessionId(), capableModel(ctx.model), () => providerRequestInputs(pi, ctx));
    });

    pi.on("model_select", async (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || await compatibleIdentity(checkpoint, ctx, event.model)) return;
      warnOnce(ctx, `${checkpoint.checkpointId}:${event.model.provider}:${event.model.id}`, INCOMPATIBLE_BACKEND_WARNING);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      warnings.clear();
      snapshots.reset();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

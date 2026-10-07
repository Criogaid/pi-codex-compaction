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
import { hasCheckpointMarker, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker, withoutInputImages } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";
import { requestFallbackCompaction } from "./fallback.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings, type CompactionConfiguration } from "./fallback-settings.js";
import { registerCompactionCommand } from "./fallback-command.js";
import { compactionRequest, providerRequestFor, RequestSnapshotTracker, type ProviderRequestInputs, type RequestSnapshots } from "./request-snapshot.js";

const STATUS_KEY = "codex-compaction";
const COMPLETION_ENTRY_TYPE = "pi-codex-compaction-completed";
const INCOMPATIBLE_BACKEND_WARNING =
  "The active Codex checkpoint cannot replay on this provider backend; only its fallback marker and retained recent messages remain available.";

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

async function replayCheckpoint(payload: unknown, ctx: ExtensionContext, blockImages: boolean): Promise<JsonObject | undefined> {
  const checkpoint = activeCheckpoint(ctx);
  if (!checkpoint) return undefined;
  const marker = checkpointMarker(checkpoint.details.checkpointId);
  if (!hasCheckpointMarker(payload, marker)) return undefined;
  if (!await compatibleIdentity(checkpoint.details, ctx)) {
    throw new Error("The active opaque checkpoint no longer matches the resolved provider endpoint");
  }
  const history = checkpoint.details.replacementHistory;
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
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session changed");
        if (announced) return;
        announced = true;
        ctx.ui.setStatus(STATUS_KEY, "Pi fallback compaction...");
        if (ctx.hasUI) {
          if (remoteError !== undefined) {
            ctx.ui.notify(`Codex remote compaction failed; using the configured fallback model. ${errorMessage(remoteError)}`, "warning");
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
      ctx.ui.notify(`Configured fallback compaction failed; compaction stopped. ${errorMessage(error)}`, "error");
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
  let announced = false;
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction...");
  try {
    if (!owned()) return { cancel: true };
    if (event.customInstructions?.trim() && ctx.hasUI) {
      ctx.ui.notify("Codex Remote Compaction V2 does not accept custom instructions; they are ignored.", "warning");
    }
    const current = projectedCurrentMessages(event, supported.identity);
    const inputs = providerRequestInputs(pi, ctx);
    const providerRequest = providerRequestFor(snapshots, sessionId, supported, current.messages, inputs);
    const request = compactionRequest(snapshots, sessionId, supported, current.messages, {
      blockImages: settings.images?.blockImages ?? false,
      systemPrompt: () => ctx.getSystemPrompt(),
      tools: () => activeTools(pi),
    }, providerRequest);
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: request.context,
      userItemOrigins: userItemOrigins(request.messages),
      providerRequest,
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
      priorCheckpoint: current.prior
        ? {
            identity: current.prior,
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      fetch,
    });
    if (!owned()) return { cancel: true };
    const retention = await prepareRetention(response.promptInput, event.signal, {
      images: response.images,
      contextual: response.contextual,
    });
    if (!owned()) return { cancel: true };
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
        message: `Codex Remote Compaction V2 completed for ${details.provider}/${details.modelId}.`,
        protocol: REMOTE_COMPACTION_PROTOCOL,
        checkpointId: details.checkpointId,
      });
      // The model may have switched to another backend while compaction ran.
      if (await compatibleIdentity(details, ctx)) return;
      warnOnce(ctx, `${details.checkpointId}:backend`, INCOMPATIBLE_BACKEND_WARNING);
    });

    pi.on("context", async (event, ctx) => {
      snapshots.recordContext(ctx.sessionManager.getSessionId(), capableModel(ctx.model), event.messages);
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !await compatibleIdentity(checkpoint.details, ctx)) return undefined;
      const messages = projectCheckpointContext(event.messages, checkpoint.details);
      if (messages) return { messages };
      warnOnce(ctx, `${checkpoint.details.checkpointId}:projection`,
        "The active Codex checkpoint no longer matches the retained messages, so its opaque history is not replayed.");
      return undefined;
    });

    pi.on("context_with_system", (event, ctx) => {
      snapshots.recordProjectedRequest(
        ctx.sessionManager.getSessionId(),
        capableModel(ctx.model),
        () => canonicalMessages(ctx),
        () => activeCheckpoint(ctx)?.details,
        event.messages,
      );
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
      if (!checkpoint || await compatibleIdentity(checkpoint.details, ctx, event.model)) return;
      warnOnce(ctx, `${event.model.provider}:${event.model.id}`, INCOMPATIBLE_BACKEND_WARNING);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      warnings.clear();
      snapshots.reset();
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

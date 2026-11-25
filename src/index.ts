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
  type SessionEntry,
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
import { applyCodexEffortUpdates } from "./effort-updates.js";
import { hasCheckpointMarker, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker, withoutInputImages } from "./protocol.js";
import { requestRemoteCompaction, RemoteCompactionTransientError } from "./remote.js";
import { requestFallbackCompaction, type FallbackCompactionRequest } from "./fallback.js";
import {
  COMPACTION_SETTINGS_RELATIVE_PATH,
  DEFAULT_REASONING_EFFORT_UPDATES_ENABLED,
  loadCompactionSettings,
  type CompactionConfiguration,
} from "./fallback-settings.js";
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

function canonicalMessages(branch: SessionEntry[]): AgentMessage[] {
  return buildSessionContext(branch, branch.at(-1)?.id ?? null).messages;
}

function projectCompactionMessages(
  messages: AgentMessage[],
  identity: ProviderIdentity,
  prior: CodexCheckpointDetails | undefined,
): AgentMessage[] {
  if (!prior) return messages;
  if (!sameProvider(prior, identity)) {
    throw new Error("The active opaque checkpoint belongs to a different provider backend");
  }
  const projected = projectCheckpointRequest(messages, prior);
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

class ConfiguredSummaryModelError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}

interface CompactionRun {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /** Send V2 with Codex's sparse reasoning-effort updates, as ordinary requests are sent. */
  readonly reasoningEffortUpdates: boolean;
  owned(): boolean;
  setStatus(message: string): void;
  summarize(
    input: Pick<FallbackCompactionRequest, "preparation" | "defaultModel">,
    remoteError: unknown,
  ): ReturnType<typeof requestFallbackCompaction>;
}

function stopTextCompaction(ctx: ExtensionContext, run: CompactionRun, error: unknown) {
  if (run.owned() && ctx.hasUI) {
    ctx.ui.notify(`Configured summary model failed; compaction stopped. ${errorMessage(error)}`, "error");
  }
  // Returning undefined would make Pi send the same context to the active chat model.
  return { cancel: true };
}

async function compactFallback(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  run: CompactionRun,
  remoteError: unknown,
) {
  try {
    if (!run.owned()) return { cancel: true };
    const result = await run.summarize({ preparation: event.preparation }, remoteError);
    if (!run.owned()) return { cancel: true };
    if (!result && remoteError !== undefined && ctx.hasUI) {
      ctx.ui.notify(`Codex remote compaction failed; using Pi compaction. ${errorMessage(remoteError)}`, "warning");
    }
    return result;
  } catch (error) {
    return stopTextCompaction(ctx, run, error);
  }
}

async function recoverLayeredCheckpoint(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  run: CompactionRun,
  remoteError: RemoteCompactionTransientError,
  prior: CodexCheckpointDetails,
  selection: NonNullable<FallbackCompactionRequest["defaultModel"]>,
) {
  if (!run.owned()) return { cancel: true };
  const { firstKeptEntryId } = event.preparation;
  const boundary = prepareCheckpointLayer(event.branchEntries, firstKeptEntryId, prior);
  if (boundary.messages.length === 0) {
    throw new Error(`No messages after the active checkpoint need summarization (${errorMessage(remoteError)})`, {
      cause: remoteError,
    });
  }
  const result = await run.summarize({
    defaultModel: selection,
    preparation: {
      ...event.preparation,
      messagesToSummarize: boundary.messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: prior.textSummary,
      // Do not leak old file operations through Pi's appended file list.
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    },
  }, remoteError);
  if (!run.owned()) return { cancel: true };
  if (!result) throw new Error("Layered compaction did not produce a summary");
  if (!await compatibleIdentity(prior, ctx, selection.model)) {
    throw new Error("The opaque checkpoint backend changed during layered compaction");
  }
  if (!run.owned()) return { cancel: true };
  // Revalidate the source and cut after the asynchronous summary request.
  const current = prepareCheckpointLayer(ctx.sessionManager.getBranch(), firstKeptEntryId, prior);
  if (current.messages.length !== boundary.messages.length ||
      current.messages.some((message, index) => fingerprintMessage(message) !== fingerprintMessage(boundary.messages[index])) ||
      current.retained.length !== boundary.retained.length ||
      current.retained.some((message, index) => fingerprintMessage(message) !== fingerprintMessage(boundary.retained[index]))) {
    throw new Error("The layered compaction source changed");
  }
  const details = createLayeredCheckpointDetails(prior, boundary, result.compaction.summary);
  return { compaction: { ...result.compaction, summary: fallbackSummary(details.checkpointId), details } };
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  run: CompactionRun,
  supported: CapableModel,
  snapshots: RequestSnapshots,
) {
  const { sessionId, signal } = run;
  const reasoning = pi.getThinkingLevel();
  const settings = pi.getSettings();
  let checkpoint: CheckpointResolution | undefined;
  let announced = false;
  run.setStatus("Codex remote compaction...");
  try {
    if (!run.owned()) return { cancel: true };
    checkpoint = resolveLatestCheckpoint(event.branchEntries);
    if (checkpoint.state === "invalid") {
      throw new Error("The previous checkpoint format is invalid or unsupported");
    }
    if (event.customInstructions?.trim() && ctx.hasUI) {
      ctx.ui.notify("Codex Remote Compaction V2 does not accept custom instructions; they are ignored.", "warning");
    }
    const prior = checkpoint.state === "parsed" ? checkpoint.details : undefined;
    const sourceLength = event.branchEntries.length;
    const sourceLeafId = event.branchEntries.at(-1)?.id;
    const sourceMessages = canonicalMessages(event.branchEntries);
    const sourceFingerprints = sourceMessages.map(fingerprintMessage);
    const currentMessages = projectCompactionMessages(sourceMessages, supported.identity, prior);
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
      reasoningEffortUpdates: run.reasoningEffortUpdates,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
      signal,
      onPrepared: () => {
        if (!run.owned()) throw new Error("Compaction session changed");
        // Each V2 attempt prepares the payload again; announce the compaction once.
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
    });
    if (!run.owned()) return { cancel: true };
    const branch = ctx.sessionManager.getBranch();
    // Append-only branch IDs establish ancestry. A new compaction may have the same summary but different details.
    const sameBranch = branch[sourceLength - 1]?.id === sourceLeafId &&
      !branch.slice(sourceLength).some((entry) => entry.type === "compaction");
    const messages = sameBranch ? canonicalMessages(branch) : undefined;
    if (!messages || messages.length !== sourceFingerprints.length ||
        messages.some((message, index) => fingerprintMessage(message) !== sourceFingerprints[index])) {
      if (ctx.hasUI) ctx.ui.notify("会话历史在 V2 压缩期间发生变化，已取消压缩并保留当前历史。", "warning");
      return { cancel: true };
    }
    const retention = prepareRetention(response.promptInput, signal, {
      images: response.images,
      contextual: response.contextual,
    });
    const replacementHistory = buildReplacementHistory(retention, response.item);
    const details = createCheckpointDetails({
      identity: response.identity,
      replacementHistory,
      keptMessages: keptMessages(branch, event.preparation.firstKeptEntryId),
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
    if (!run.owned()) return { cancel: true };
    // A failure during checkpoint resolution cannot establish that native fallback is safe.
    if (checkpoint?.state === "none") return compactFallback(event, ctx, run, error);
    try {
      if (checkpoint?.state !== "parsed" || !(error instanceof RemoteCompactionTransientError) ||
          !await compatibleIdentity(checkpoint.details, ctx, supported.model)) {
        throw new Error("The failed remote request is not eligible for safe layered recovery", { cause: error });
      }
      return await recoverLayeredCheckpoint(event, ctx, run, error, checkpoint.details, {
        model: supported.model,
        thinkingLevel: reasoning,
      });
    } catch (failure) {
      if (failure instanceof ConfiguredSummaryModelError) return stopTextCompaction(ctx, run, failure);
      if (run.owned() && ctx.hasUI) {
        ctx.ui.notify(`Compaction stopped; previous history was preserved. ${errorMessage(failure)}`, "error");
      }
      return { cancel: true };
    }
  }
}

export default function codexCompaction(pi: ExtensionAPI): void {
  const compactionSettingsPath = resolve(getAgentDir(), COMPACTION_SETTINGS_RELATIVE_PATH);
  let reasoningEffortUpdates: Promise<boolean> | undefined;
  const readReasoningEffortUpdates = async (ctx: ExtensionContext): Promise<boolean> => {
    try {
      return (await loadCompactionSettings(compactionSettingsPath)).configuration.reasoningEffortUpdatesEnabled;
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not read compaction settings; Codex reasoning effort updates are Off. ${errorMessage(error)}`, "warning");
      return DEFAULT_REASONING_EFFORT_UPDATES_ENABLED;
    }
  };
  // Publish reads before awaiting them so a later menu save cannot be overwritten by an older read.
  registerCompactionCommand(pi, compactionSettingsPath, (enabled) => { reasoningEffortUpdates = Promise.resolve(enabled); });
  const warnings = new Set<string>();
  const snapshots = new RequestSnapshotTracker();
  let latestRun = 0;
  let live = true;
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

  pi.on("session_start", async (_event, ctx) => {
    warnings.clear();
    snapshots.reset();
    await (reasoningEffortUpdates = readReasoningEffortUpdates(ctx));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!live) return { cancel: true };
    const runNumber = ++latestRun;
    const sessionId = ctx.sessionManager.getSessionId();
    const { signal } = event;
    const sameSession = () => live && ctx.sessionManager.getSessionId() === sessionId;
    const ownsStatus = () => runNumber === latestRun && sameSession();
    // A model switch leaves the run on its starting model, as in Pi's compaction.
    const owned = () => !signal.aborted && sameSession();
    try {
      const requestSnapshots = snapshots.current();
      const supported = capableModel(ctx.model);
      if (!owned()) return { cancel: true };
      const effort = reasoningEffortUpdates ??= readReasoningEffortUpdates(ctx);
      let configuration: CompactionConfiguration;
      try {
        configuration = (await loadCompactionSettings(compactionSettingsPath)).configuration;
      } catch (error) {
        if (owned() && ctx.hasUI) {
          ctx.ui.notify(`Could not read compaction settings; compaction stopped. ${errorMessage(error)}`, "error");
        }
        return { cancel: true };
      }
      const effortEnabled = await effort;
      if (!owned()) return { cancel: true };

      const run: CompactionRun = {
        sessionId,
        signal,
        reasoningEffortUpdates: effortEnabled,
        owned,
        setStatus(message) {
          if (ownsStatus()) ctx.ui.setStatus(STATUS_KEY, message);
        },
        async summarize(input, remoteError) {
          // Validate lazily so unused malformed fallback settings never fail a remote compaction run.
          let summaryModel: CompactionConfiguration["summaryModel"];
          try {
            summaryModel = configuration.summaryModel;
          } catch (error) {
            throw new ConfiguredSummaryModelError(error);
          }
          let announced = false;
          try {
            return await requestFallbackCompaction({
              ...input,
              summaryModel,
              modelRegistry: ctx.modelRegistry,
              settings: pi.getSettings(),
              customInstructions: event.customInstructions,
              signal,
              sessionId,
              onPrepared: ({ model, thinkingLevel }) => {
                if (!run.owned()) throw new Error("Compaction session changed");
                if (announced) return;
                announced = true;
                run.setStatus("Pi fallback compaction...");
                if (!ctx.hasUI) return;
                if (remoteError !== undefined) {
                  const target = summaryModel ? "the configured summary model" : "Pi compaction";
                  ctx.ui.notify(`Codex remote compaction failed; using ${target}. ${errorMessage(remoteError)}`, "warning");
                }
                ctx.ui.notify(`Using Pi text compaction with ${model.provider}/${model.id} (${thinkingLevel}).`, "info");
              },
            });
          } catch (error) {
            throw summaryModel ? new ConfiguredSummaryModelError(error) : error;
          }
        },
      };

      const result = configuration.remoteCompactionEnabled && supported
        ? await compactRemotely(pi, event, ctx, run, supported, requestSnapshots)
        : await compactFallback(event, ctx, run, undefined);
      return owned() ? result : { cancel: true };
    } finally {
      if (ownsStatus()) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

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

  pi.on("before_agent_start", (event, ctx) => {
    snapshots.recordRunStart(ctx.sessionManager.getSessionId(), event.systemPromptOptions);
  });

  pi.on("context", (_event, ctx) => {
    snapshots.recordContext(ctx.sessionManager.getSessionId(), capableModel(ctx.model), () => canonicalMessages(ctx.sessionManager.getBranch()));
  });

  // Pi runs every extension's `context` handlers first, so none of them sees the marker and load order cannot
  // change the projection. Later `context_with_system` handlers still see and can change it.
  pi.on("context_with_system", async (event, ctx) => {
    let messages: AgentMessage[] | undefined;
    const checkpoint = activeCheckpoint(ctx);
    if (checkpoint && await compatibleIdentity(checkpoint, ctx)) {
      messages = projectCheckpointTranscript(event.messages, canonicalMessages(ctx.sessionManager.getBranch()), checkpoint);
      if (!messages) {
        snapshots.discardSnapshots();
        warnOnce(ctx, `${checkpoint.checkpointId}:projection`,
          "The active Codex checkpoint no longer matches this request's retained messages, so its opaque history is not replayed.");
      }
    }
    snapshots.recordProjectedRequest(
      ctx.sessionManager.getSessionId(),
      capableModel(ctx.model),
      () => canonicalMessages(ctx.sessionManager.getBranch()),
      () => activeCheckpoint(ctx),
      messages ?? event.messages,
      messages !== undefined,
    );
    return messages ? { messages } : undefined;
  });

  pi.on("before_provider_request", async (event, ctx) => {
    let replay: "applied" | "skipped" | "failed" = "failed";
    try {
      const effort = reasoningEffortUpdates ??= readReasoningEffortUpdates(ctx);
      const payload = await replayCheckpoint(event.payload, ctx, pi.getSettings().images?.blockImages ?? false);
      replay = payload === undefined ? "skipped" : "applied";
      if (!await effort) return payload;
      // Replay first: the rewrite recognizes a compacted window by the replayed compaction item.
      const rewritten = applyCodexEffortUpdates(payload ?? event.payload);
      return rewritten === event.payload ? undefined : rewritten;
    } finally {
      // Pi continues the ordinary request after a hook throws, so publish this turn even on replay failure.
      try {
        snapshots.recordProviderRequest(
          ctx.sessionManager.getSessionId(),
          capableModel(ctx.model),
          () => canonicalMessages(ctx.sessionManager.getBranch()),
          () => ctx.getSystemPrompt(),
          () => ({ payload: event.payload, inputs: providerRequestInputs(pi, ctx), replay }),
        );
      } catch (error) {
        warnOnce(ctx, "request-snapshot", `Could not record the provider request snapshot. ${errorMessage(error)}`);
      }
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") snapshots.endRequest();
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
    live = false;
    warnings.clear();
    snapshots.reset();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

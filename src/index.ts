// Own Pi lifecycle integration, active-session ownership, checkpoint replay hooks, and compaction orchestration.
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { prepareRetention, userItemOrigins } from "./retention-input.js";
import { buildReplacementHistory, RETAINED_MESSAGE_TOKEN_BUDGET } from "./retention.js";
import {
  capableModel,
  compactionModelMetadata,
  sameBackend,
  sameModel,
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
import { hasCheckpointMarker, isObject, type JsonObject, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker, withoutInputImages } from "./protocol.js";
import { estimateImages } from "./image-budget.js";
import { estimateModelInput, modelInputBudget } from "./model-budget.js";
import { assessModelTransition } from "./model-transition.js";
import { requestRemoteCompaction } from "./remote.js";
import { requestFallbackCompaction } from "./fallback.js";
import { COMPACTION_SETTINGS_RELATIVE_PATH, loadCompactionSettings, type CompactionConfiguration } from "./fallback-settings.js";
import { registerCompactionCommand } from "./fallback-command.js";
import { compactionRequest, providerRequestFor, RequestSnapshotTracker, type ProviderRequestInputs, type RequestSnapshots } from "./request-snapshot.js";

const STATUS_KEY = "codex-compaction";
const COMPLETION_ENTRY_TYPE = "pi-codex-compaction-completed";

interface CompletionEntryData {
  message: string;
  protocol: typeof REMOTE_COMPACTION_PROTOCOL;
  checkpointId: string;
}

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

async function resolvedModel(ctx: ExtensionContext, model = ctx.model): Promise<CapableModel | undefined> {
  if (!model || !capableModel(model)) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok ? capableModel(model, auth.baseUrl) : undefined;
}

async function compatibleIdentity(
  details: CodexCheckpointDetails,
  ctx: ExtensionContext,
  model = ctx.model,
): Promise<CapableModel | undefined> {
  if (!model || !sameProvider(details, model)) return undefined;
  const supported = await resolvedModel(ctx, model);
  if (!supported) return undefined;
  const compatibility = assessModelTransition(details, supported).compatibility;
  return compatibility !== "different-backend" && compatibility !== "mismatched-hash" ? supported : undefined;
}

function selectedModelKey(model: Model<Api> | undefined): string {
  return JSON.stringify(model ? { provider: model.provider, api: model.api, id: model.id,
    baseUrl: model.baseUrl, endpoint: capableModel(model)?.identity.endpoint,
    maxTokens: model.maxTokens, ...compactionModelMetadata(model) } : null);
}

interface ModelPreparation {
  readonly sessionId: string;
  readonly targetKey: string;
  readonly source: Model<Api>;
}

function sourceWindow(details: CodexCheckpointDetails, ctx: ExtensionContext): number | undefined {
  // A catalog lookup can recover a legacy checkpoint's window, never its creation-time hash.
  const source = ctx.modelRegistry.find(details.provider, details.modelId);
  return details.modelContextWindow ?? (source && sameProvider(details, source)
    ? compactionModelMetadata(source).modelContextWindow : undefined);
}

function smallerTarget(details: CodexCheckpointDetails, ctx: ExtensionContext, target: Model<Api>): boolean {
  const source = sourceWindow(details, ctx);
  return source !== undefined && target.contextWindow < source;
}

/** Include the current prompt and all active schemas, even ones Pi may hide later in the ordinary request. */
function modelBudgetFrame(pi: ExtensionAPI, ctx: ExtensionContext): JsonObject {
  const head = getCurrentSystemMessage(convertToLlm(canonicalMessages(ctx)));
  const prompt = ctx.getSystemPrompt();
  const persistedPrompt = head && getSystemMessageText(head);
  return { instructions: prompt, tools: activeTools(pi), input: [],
    ...(head?.toolsAdded ? { persisted_tool_state: head.toolsAdded } : {}),
    ...(persistedPrompt && persistedPrompt !== prompt ? { additional_instructions: persistedPrompt } : {}) };
}

function stopCheckpointRequest(ctx: ExtensionContext, message: string): never {
  // Pi catches hook exceptions and otherwise continues dispatch; cancellation must happen first.
  ctx.abort();
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  throw new Error(message);
}

async function compactionModels(ctx: ExtensionContext, preparation?: ModelPreparation) {
  const target = await resolvedModel(ctx);
  if (!target) throw new Error("The selected model has no authenticated Remote Compaction V2 endpoint");
  const prior = activeCheckpoint(ctx)?.details;
  if (prior && !await compatibleIdentity(prior, ctx, target.model)) {
    throw new Error("The selected model's backend or compaction hash is incompatible with the active checkpoint");
  }
  const source = preparation?.sessionId === ctx.sessionManager.getSessionId() &&
    preparation.targetKey === selectedModelKey(ctx.model) ? preparation.source
    : prior && smallerTarget(prior, ctx, target.model) ? ctx.modelRegistry.find(prior.provider, prior.modelId) : undefined;
  if (!source || source.contextWindow <= target.model.contextWindow) {
    if (!source && prior && smallerTarget(prior, ctx, target.model)) {
      throw new Error("The checkpoint's original model is unavailable for smaller-window preparation; restore it before compacting");
    }
    return { supported: target };
  }
  const supported = await resolvedModel(ctx, source);
  if (!supported || !sameBackend(supported.identity, target.identity) ||
    assessModelTransition({ ...supported.identity, ...compactionModelMetadata(supported.model) }, target).compatibility === "mismatched-hash" ||
    (prior && !await compatibleIdentity(prior, ctx, supported.model))) {
    throw new Error("The original model cannot safely prepare this checkpoint for the selected model");
  }
  return { supported, target };
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
  if (!hasCheckpointMarker(payload, marker)) throw new Error("The active Codex checkpoint marker is missing from the prepared request");
  if (!isObject(payload) || payload.model !== ctx.model?.id) {
    throw new Error("The prepared request routes to a different model than the checkpoint compatibility check; opaque replay stopped");
  }
  if (!await compatibleIdentity(checkpoint.details, ctx)) {
    throw new Error("The active opaque checkpoint is incompatible with the resolved provider backend or compaction hash; restore its original model or start a new session");
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

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal, modelKey?: string): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId &&
    (modelKey === undefined || selectedModelKey(ctx.model) === modelKey);
}

async function compactFallback(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  sessionId: string,
  configuration: CompactionConfiguration,
  remoteError?: unknown,
  modelKey = selectedModelKey(ctx.model),
) {
  let announced = false;
  try {
    if (!sessionStillOwned(ctx, sessionId, event.signal, modelKey)) return { cancel: true };
    // Pi's text preparation contains only the checkpoint's recovery notice, not its opaque history.
    // A native result would supersede the checkpoint and make that history unavailable to later turns.
    if (latestCheckpoint(event.branchEntries)) {
      if (ctx.hasUI) ctx.ui.notify(
        "Compaction stopped: Pi text compaction cannot preserve the active Codex checkpoint's older history. " +
        "Keep Remote Compaction V2 enabled and retry with the original provider backend." +
        (remoteError === undefined ? "" : ` ${errorMessage(remoteError)}`),
        "warning",
      );
      return { cancel: true };
    }
    const result = await requestFallbackCompaction({
      configuration: configuration.fallback,
      modelRegistry: ctx.modelRegistry,
      preparation: event.preparation,
      settings: pi.getSettings(),
      customInstructions: event.customInstructions,
      signal: event.signal,
      sessionId,
      onPrepared: ({ model, thinkingLevel }) => {
        if (!sessionStillOwned(ctx, sessionId, event.signal, modelKey)) throw new Error("Compaction session or selected model changed");
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
    if (!sessionStillOwned(ctx, sessionId, event.signal, modelKey)) return { cancel: true };
    if (!result && remoteError !== undefined) notifyFailure(ctx, remoteError);
    return result;
  } catch (error) {
    if (sessionStillOwned(ctx, sessionId, event.signal, modelKey) && ctx.hasUI) {
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
  preparation?: ModelPreparation,
) {
  const eligible = capableModel(ctx.model);
  const modelKey = selectedModelKey(ctx.model);
  const sessionId = ctx.sessionManager.getSessionId();
  const owned = () => sessionStillOwned(ctx, sessionId, event.signal, modelKey);
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
  if (!configuration.remoteCompactionEnabled || !eligible) return compactFallback(pi, event, ctx, sessionId, configuration, undefined, modelKey);
  const reasoning = pi.getThinkingLevel();
  const settings = pi.getSettings();
  let announced = false;
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction...");
  try {
    const { supported, target } = await compactionModels(ctx, preparation);
    if (!owned()) return { cancel: true };
    if (event.customInstructions?.trim() && ctx.hasUI) {
      ctx.ui.notify("Codex Remote Compaction V2 does not accept custom instructions; they are ignored.", "warning");
    }
    const current = projectedCurrentMessages(event, supported.identity);
    const inputs = providerRequestInputs(pi, ctx);
    const request = compactionRequest(snapshots, sessionId, supported, current.messages, {
      blockImages: settings.images?.blockImages ?? false,
      systemPrompt: () => ctx.getSystemPrompt(),
      tools: () => activeTools(pi),
    });
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context: request.context,
      userItemOrigins: userItemOrigins(request.messages),
      providerRequest: providerRequestFor(snapshots, sessionId, supported, current.messages, inputs),
      reasoning,
      sessionId,
      thinkingBudgets: settings.thinkingBudgets,
      blockImages: settings.images?.blockImages ?? false,
      maxRetries: settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs,
      signal: event.signal,
      onPrepared: () => {
        if (!owned()) throw new Error("Compaction session or selected model changed");
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
    let replacementHistory = buildReplacementHistory(retention, response.item);
    if (target) {
      const frame = modelBudgetFrame(pi, ctx);
      // Leave room for the next user turn as well as output and transport-specific framing.
      const budget = Math.max(0, modelInputBudget(target.model, settings.compaction?.reserveTokens) -
        Math.min(4_096, Math.ceil(target.model.contextWindow * 0.05)));
      const estimate = (input: JsonObject[]) => estimateModelInput({ ...frame, input }, response.images);
      let retained = Math.min(RETAINED_MESSAGE_TOKEN_BUDGET, Math.max(0, budget - estimate([response.item])));
      // JSON framing is outside Codex's plaintext budget. Recheck the actual selected history after each reduction.
      for (let attempt = 0; attempt < 4 && estimate(replacementHistory) > budget; attempt++) {
        replacementHistory = buildReplacementHistory(retention, response.item, retained);
        retained = Math.max(0, retained - Math.max(1, estimate(replacementHistory) - budget));
      }
      if (estimate(replacementHistory) > budget) replacementHistory = [structuredClone(response.item)];
      if (estimate(replacementHistory) > budget) {
        throw new Error("The new opaque checkpoint and current prompt/tools still exceed the smaller model's estimated input budget; the old checkpoint was kept");
      }
    }
    if (!owned()) return { cancel: true };
    const details = createCheckpointDetails({
      identity: response.identity,
      modelMetadata: response.modelMetadata,
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
    // Preparation must not silently replace a failed old-model V2 request with a small-model text summary.
    if (preparation?.targetKey === modelKey) {
      if (ctx.hasUI) ctx.ui.notify(`Smaller-model preparation stopped; existing history was kept. ${errorMessage(error)}`, "warning");
      return { cancel: true };
    }
    return await compactFallback(pi, event, ctx, sessionId, configuration, error, modelKey);
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
    let modelPreparation: ModelPreparation | undefined;
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
      modelPreparation = undefined;
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, compactionSettingsPath, options.fetch, snapshots.current(), modelPreparation),
    );

    pi.on("session_compact", (event) => {
      if (!event.fromExtension) return;
      const details = parseCheckpointDetails(event.compactionEntry.details);
      if (!details) return;
      modelPreparation = undefined;
      pi.appendEntry<CompletionEntryData>(COMPLETION_ENTRY_TYPE, {
        message: `Codex Remote Compaction V2 completed for ${details.provider}/${details.modelId}.`,
        protocol: REMOTE_COMPACTION_PROTOCOL,
        checkpointId: details.checkpointId,
      });
    });

    pi.on("context", async (event, ctx) => {
      snapshots.recordContext(ctx.sessionManager.getSessionId(), capableModel(ctx.model), event.messages);
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || ctx.signal?.aborted) return undefined;
      const target = await compatibleIdentity(checkpoint.details, ctx);
      if (!target) stopCheckpointRequest(ctx,
        "The active Codex checkpoint is incompatible with this backend or compaction hash. Restore its original model or start a new session; existing history was kept.");
      if (assessModelTransition(checkpoint.details, target).compatibility === "unknown") {
        warnOnce(ctx, `${checkpoint.details.checkpointId}:${target.identity.modelId}:unknown`,
          "The selected model uses the same backend, but its opaque-checkpoint compatibility is unknown because matching compaction hashes are unavailable.");
      }
      const messages = projectCheckpointContext(event.messages, checkpoint.details);
      if (messages) return { messages };
      stopCheckpointRequest(ctx,
        "The active Codex checkpoint no longer matches the retained messages. Request stopped to preserve its older history; restore the original context or start a new session.");
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
      if (ctx.signal?.aborted) return undefined;
      let payload: JsonObject | undefined;
      try {
        payload = await replayCheckpoint(event.payload, ctx, pi.getSettings().images?.blockImages ?? false);
        const prior = activeCheckpoint(ctx)?.details;
        if (payload && prior && ctx.model && smallerTarget(prior, ctx, ctx.model)) {
          const images = await estimateImages(Array.isArray(payload.input) ? payload.input.filter(isObject) : [],
            ctx.signal ?? new AbortController().signal);
          if (estimateModelInput(payload, images) > modelInputBudget(ctx.model, pi.getSettings().compaction?.reserveTokens)) {
            stopCheckpointRequest(ctx,
              "The expanded Codex checkpoint request exceeds the smaller model's estimated input budget. Run /compact to prepare it with the original model, or select a larger model; existing history was kept.");
          }
        }
      } catch (error) {
        if (!ctx.signal?.aborted) stopCheckpointRequest(ctx, errorMessage(error));
        throw error;
      }
      snapshots.recordProviderRequest(
        ctx.sessionManager.getSessionId(),
        capableModel(ctx.model),
        () => canonicalMessages(ctx),
        () => ctx.getSystemPrompt(),
        () => ({ payload: payload ?? event.payload, inputs: providerRequestInputs(pi, ctx) }),
      );
      return payload;
    });

    pi.on("model_select", async (event, ctx) => {
      modelPreparation = undefined;
      const sessionId = ctx.sessionManager.getSessionId();
      const targetKey = selectedModelKey(event.model);
      const checkpoint = activeCheckpoint(ctx);
      const target = await resolvedModel(ctx, event.model);
      if (ctx.sessionManager.getSessionId() !== sessionId || selectedModelKey(ctx.model) !== targetKey) return;
      const transition = checkpoint && target && assessModelTransition(checkpoint.details, target);
      if (checkpoint && (!transition || transition.compatibility === "different-backend" || transition.compatibility === "mismatched-hash")) {
        if (!ctx.isIdle()) ctx.abort();
        warnOnce(ctx, `${checkpoint.details.checkpointId}:${targetKey}:incompatible`,
          "This model's backend or compaction hash is incompatible with the active Codex checkpoint. Requests will stop until you restore a compatible model or start a new session; the checkpoint is unchanged.");
        return;
      }
      if (!target) return;
      if (transition?.compatibility === "unknown") warnOnce(ctx, `${checkpoint!.details.checkpointId}:${target.identity.modelId}:unknown`,
        "The selected model uses the same backend, but matching compaction hashes are unavailable; opaque-checkpoint compatibility remains unknown.");
      const previous = checkpoint
        ? (event.previousModel && sameModel(checkpoint.details, event.previousModel) ? event.previousModel
          : ctx.modelRegistry.find(checkpoint.details.provider, checkpoint.details.modelId))
        : event.previousModel;
      if (!previous || previous.contextWindow <= event.model.contextWindow) return;
      const source = await resolvedModel(ctx, previous);
      if (!source || !sameBackend(source.identity, target.identity) ||
        assessModelTransition({ ...source.identity, ...compactionModelMetadata(source.model) }, target).compatibility === "mismatched-hash") return;
      const pending = { sessionId, targetKey, source: structuredClone(previous) };
      if (ctx.sessionManager.getSessionId() !== sessionId || selectedModelKey(ctx.model) !== targetKey) return;
      modelPreparation = pending;
      try {
        const history = checkpoint?.details.replacementHistory ?? [];
        const input = pi.getSettings().images?.blockImages ? withoutInputImages(history) : history;
        const images = await estimateImages(input, new AbortController().signal);
        if (modelPreparation !== pending || ctx.sessionManager.getSessionId() !== sessionId || selectedModelKey(ctx.model) !== targetKey) return;
        const canonical = canonicalMessages(ctx);
        const tail = checkpoint ? projectCheckpointRequest(canonical, checkpoint.details) : canonical;
        const estimate = estimateModelInput({ ...modelBudgetFrame(pi, ctx), input,
          pending_context: tail?.filter((message) => message.role !== "system") ?? canonical }, images);
        const budget = modelInputBudget(target.model, pi.getSettings().compaction?.reserveTokens);
        if (estimate <= budget && (ctx.getContextUsage()?.tokens ?? 0) <= budget) return;
        if (!ctx.isIdle()) {
          warnOnce(ctx, `${targetKey}:prepare-later`, "The smaller model needs context preparation. Run /compact when the current turn is idle; the original model will be used when available.");
          return;
        }
        const configuration = (await loadCompactionSettings(compactionSettingsPath)).configuration;
        if (!configuration.remoteCompactionEnabled || modelPreparation !== pending || !ctx.isIdle() ||
          ctx.sessionManager.getSessionId() !== sessionId || selectedModelKey(ctx.model) !== targetKey) return;
        if (ctx.hasUI) ctx.ui.notify(`Preparing context for ${target.identity.modelId} with the original model ${source.identity.modelId}.`, "info");
        // Manual compaction aborts and waits for the current run. Invoke it only from an idle selection hook.
        await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
      } catch (error) {
        if (ctx.sessionManager.getSessionId() === sessionId && selectedModelKey(ctx.model) === targetKey && ctx.hasUI) {
          ctx.ui.notify(`Smaller-model preparation did not complete; existing history was kept. ${errorMessage(error)}`, "warning");
        }
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      warnings.clear();
      snapshots.reset();
      modelPreparation = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createCodexCompactionExtension();

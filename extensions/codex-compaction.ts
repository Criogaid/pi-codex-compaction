// Own Pi lifecycle integration, active-session ownership, and checkpoint replay hooks.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Tool } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildReplacementHistory } from "./retention.js";
import {
  capableModel,
  sameIdentity,
  type CapableModel,
  type ProviderIdentity,
} from "./capability.js";
import {
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { hasCheckpointMarker, REMOTE_COMPACTION_PROTOCOL, rewriteCheckpointMarker } from "./protocol.js";
import { requestRemoteCompaction } from "./remote.js";

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


async function compatibleIdentity(
  details: CodexCheckpointDetails,
  ctx: ExtensionContext,
  model = ctx.model,
): Promise<CapableModel | undefined> {
  if (!model || model.provider !== details.provider || model.api !== details.api || model.id !== details.modelId) return undefined;
  // Resolve only endpoint identity here; Pi still owns authorization and request dispatch.
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  const supported = capableModel(model, auth.baseUrl);
  return supported && sameIdentity(details, supported.identity) ? supported : undefined;
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex(
    (entry) => entry.id === event.preparation.firstKeptEntryId,
  );
  if (keptIndex < 0) {
    throw new Error("Pi compaction cut point is not present in the active context");
  }
  return contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
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

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  identity: ProviderIdentity,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries)?.details;
  if (!prior) return { messages: session.messages };
  if (prior.provider !== identity.provider || prior.api !== identity.api || prior.modelId !== identity.modelId) {
    throw new Error("The active opaque checkpoint belongs to a different provider identity");
  }
  const projected = projectCheckpointContext(session.messages, prior);
  if (!projected) throw new Error("The previous opaque checkpoint could not be projected safely");
  return { messages: projected, prior };
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
) {
  const supported = capableModel(ctx.model);
  if (!supported) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const reasoning = pi.getThinkingLevel();
  ctx.ui.setStatus(STATUS_KEY, "Codex remote compaction...");
  try {
    if (!sessionStillOwned(ctx, sessionId, event.signal)) return { cancel: true };
    const current = projectedCurrentMessages(event, supported.identity);
    const context: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: activeTools(pi),
    };
    const response = await requestRemoteCompaction({
      modelRegistry: ctx.modelRegistry,
      model: supported.model,
      context,
      reasoning,
      sessionId,
      transport: pi.getSettings().transport,
      signal: event.signal,
      onPrepared: () => {
        if (!sessionStillOwned(ctx, sessionId, event.signal)) throw new Error("Compaction session ownership changed");
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
    const replacementHistory = buildReplacementHistory(response.promptInput, response.item);
    const details = createCheckpointDetails({
      identity: response.identity,
      replacementHistory,
      keptMessages: keptMessages(event),
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
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactRemotely(pi, event, ctx, options.fetch),
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
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", async (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      if (!await compatibleIdentity(checkpoint.details, ctx)) {
        throw new Error("The active opaque checkpoint no longer matches the resolved provider endpoint");
      }
      return rewriteCheckpointMarker(
        event.payload,
        marker,
        checkpoint.details.replacementHistory,
      );
    });

    pi.on("model_select", async (event, ctx) => {
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || await compatibleIdentity(checkpoint.details, ctx, event.model)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (warnings.has(key)) return;
      warnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Codex checkpoint cannot replay on this provider identity; only its fallback marker and retained recent messages remain available.",
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

// Own the interactive fallback settings command; configuration and compaction remain in their existing owners.
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_FALLBACK_ENABLED, loadFallbackSettings, type FallbackConfiguration } from "./fallback-settings.js";

const COMMAND_NAME = "codex-compaction";
const CHANGE_MODEL = "Choose fallback model and thinking level";
const FALLBACK_ON = "On";
const FALLBACK_OFF = "Off";

function notifyFallback(ctx: ExtensionCommandContext, selection: FallbackConfiguration | undefined): void {
  if (selection?.enabled) {
    ctx.ui.notify(`Fallback text compaction will use ${selection.provider}/${selection.model} (${selection.thinkingLevel}). The chat model is unchanged.`, "info");
  } else {
    ctx.ui.notify(`Fallback model is Off. Pi will use the chat model for text compaction.${selection ? ` Saved model: ${selection.provider}/${selection.model} (${selection.thinkingLevel}).` : ""}`, "info");
  }
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id} (${model.name})`;
}

async function configureFallback(path: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`/${COMMAND_NAME} requires interactive or RPC mode; edit ${path} directly.`, "warning");
    return;
  }
  const settings = await loadFallbackSettings(path);
  const current = settings.fallback;
  const isEnabled = current?.enabled ?? false;
  const switchLabel = `Fallback model: ${isEnabled ? FALLBACK_ON : FALLBACK_OFF}`;
  const label = current ? `${current.provider}/${current.model} (${current.thinkingLevel})` : "No fallback model configured";
  const action = await ctx.ui.select(`Codex compaction fallback: ${label}`, [CHANGE_MODEL, switchLabel]);
  if (action === undefined) return;
  if (action === switchLabel) {
    const chosenState = await ctx.ui.select("Use the configured model for fallback text compaction",
      isEnabled ? [FALLBACK_ON, FALLBACK_OFF] : [FALLBACK_OFF, FALLBACK_ON]);
    if (chosenState === undefined) return;
    if (chosenState !== FALLBACK_ON && chosenState !== FALLBACK_OFF) throw new Error("Select On or Off for fallback compaction");
    const enabled = chosenState === FALLBACK_ON;
    if (enabled === isEnabled) {
      notifyFallback(ctx, current);
      return;
    }
    if (current) {
      const selection = { ...current, enabled };
      await settings.save(selection);
      notifyFallback(ctx, selection);
      return;
    }
    // First enable needs a model; commit only after both selectors complete.
  } else if (action !== CHANGE_MODEL) {
    throw new Error("Select a listed compaction setting");
  }
  const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
    const a = modelLabel(left);
    const b = modelLabel(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  if (models.length === 0) {
    ctx.ui.notify("No authenticated models are available. Configure a model in Pi first.", "warning");
    return;
  }
  const chosen = await ctx.ui.select("Choose the model for fallback text compaction", models.map(modelLabel));
  if (chosen === undefined) return;
  const model = models.find((candidate) => modelLabel(candidate) === chosen);
  if (!model) throw new Error("Select a listed fallback model");
  const levels = getSupportedThinkingLevels(model);
  const chosenLevel = await ctx.ui.select(`Thinking level for ${model.provider}/${model.id}`, [...levels]);
  if (chosenLevel === undefined) return;
  const thinkingLevel = levels.find((level) => level === chosenLevel);
  if (thinkingLevel === undefined) throw new Error("Select a supported fallback thinking level");
  const selection = { enabled: current?.enabled ?? DEFAULT_FALLBACK_ENABLED, provider: model.provider, model: model.id, thinkingLevel };
  await settings.save(selection);
  notifyFallback(ctx, selection);
}

export function registerFallbackCommand(pi: ExtensionAPI, path: string): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure the fallback compaction model and thinking level",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error(`Usage: /${COMMAND_NAME}`);
        await configureFallback(path, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not configure fallback compaction", "error");
      }
    },
  });
}

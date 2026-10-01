// Own the interactive fallback settings command; configuration and compaction remain in their existing owners.
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadFallbackSettings } from "./fallback-settings.js";

const COMMAND_NAME = "codex-compaction";
const CHANGE_MODEL = "Choose fallback model and thinking level";
const DISABLE_FALLBACK = "Disable fallback (Pi uses the chat model)";

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
  const label = current ? `${current.provider}/${current.model} (${current.thinkingLevel})` : "Pi default (chat model)";
  const action = await ctx.ui.select(`Codex compaction fallback: ${label}`, [CHANGE_MODEL, DISABLE_FALLBACK]);
  if (action === undefined) return;
  if (action === DISABLE_FALLBACK) {
    if (current) await settings.save(undefined);
    ctx.ui.notify("Fallback model disabled. Pi will use the chat model for text compaction.", "info");
    return;
  }
  if (action !== CHANGE_MODEL) throw new Error("Select a listed compaction setting");
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
  await settings.save({ provider: model.provider, model: model.id, thinkingLevel });
  ctx.ui.notify(`Fallback text compaction will use ${model.provider}/${model.id} (${thinkingLevel}). The chat model is unchanged.`, "info");
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

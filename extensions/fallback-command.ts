// Own compaction settings interaction; use Pi widgets without changing the session's model or thinking level.
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getSelectListTheme, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, SettingsList, Text } from "@earendil-works/pi-tui";
import { loadCompactionSettings, type CompactionConfiguration, type FallbackConfiguration } from "./fallback-settings.js";

const COMMAND_NAME = "codex-compaction";
const CHANGE_MODEL = "Choose fallback model and thinking level";
const MAX_VISIBLE_MODELS = 10;
type SettingsAction = "model" | "toggle" | "remote";

function describeFallback(selection: FallbackConfiguration | undefined): string {
  if (selection?.model === undefined) return "No fallback model configured; inactive. Pi uses the chat model.";
  const model = `${selection.provider}/${selection.model} (${selection.thinkingLevel})`;
  return selection.enabled ? `Fallback text compaction will use ${model}. The chat model is unchanged.`
    : `Fallback model is Off. Pi will use the chat model for text compaction. Saved model: ${model}.`;
}

async function chooseAction(ctx: ExtensionCommandContext, configuration: CompactionConfiguration, selected: SettingsAction): Promise<SettingsAction | undefined> {
  const current = configuration.fallback;
  const remoteValue = configuration.remoteCompactionEnabled ? "On" : "Off";
  const switchValue = current?.enabled ? "On" : "Off";
  if (ctx.mode !== "tui") {
    const switchLabel = `Fallback model: ${switchValue}`;
    const remoteLabel = `Remote Compaction V2: ${remoteValue}`;
    const action = await ctx.ui.select(describeFallback(current), [CHANGE_MODEL, switchLabel, remoteLabel]);
    if (action === undefined) return undefined;
    if (action === CHANGE_MODEL) return "model";
    if (action === switchLabel) return "toggle";
    if (action === remoteLabel) return "remote";
    throw new Error("Select a listed compaction setting");
  }
  return ctx.ui.custom<SettingsAction | undefined>((tui, _theme, _keys, done) => {
    const list = new SettingsList([
      { id: "toggle", label: "Fallback model", currentValue: switchValue, values: ["Off", "On"], description: describeFallback(current) },
      { id: "model", label: "Model and thinking level", currentValue: current?.model === undefined ? "Not configured" : `${current.provider}/${current.model} (${current.thinkingLevel})`, values: ["Choose"], description: "Choose a model; this does not change the switch." },
      { id: "remote", label: "Remote Compaction V2", currentValue: remoteValue, values: ["Off", "On"], description: "When Off, use the configured fallback or Pi's chat-model text compaction. Existing checkpoints still replay." },
    ], 3, getSettingsListTheme(), (id) => done(id === "toggle" ? "toggle" : id === "remote" ? "remote" : "model"), () => done(undefined));
    list.selectItem(selected);
    return {
      render: (width) => list.render(width),
      invalidate: () => list.invalidate(),
      handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
    };
  });
}

function modelLabel(model: Model<Api>): string {
  return `${model.provider}/${model.id} (${model.name})`;
}

async function chooseModel(ctx: ExtensionCommandContext, models: readonly Model<Api>[]): Promise<Model<Api> | undefined> {
  if (ctx.mode !== "tui") {
    const query = await ctx.ui.input("Search fallback models (provider, ID, or name)", "Leave empty to show all models");
    if (query === undefined) return undefined;
    const matches = fuzzyFilter([...models], query, modelLabel);
    const chosen = await ctx.ui.select("Choose the model for fallback text compaction", matches.map(modelLabel));
    if (chosen === undefined) return undefined;
    const model = matches.find((candidate) => modelLabel(candidate) === chosen);
    if (!model) throw new Error("Select a listed fallback model");
    return model;
  }
  return ctx.ui.custom<Model<Api> | undefined>((tui, _theme, keys, done) => {
    const input = new Input();
    const container = new Container();
    let list: SelectList;
    const update = () => {
      const matches = fuzzyFilter([...models], input.getValue(), modelLabel);
      list = new SelectList(matches.map((model, index) => ({ value: String(index), label: model.id, description: `${model.provider} · ${model.name}` })), MAX_VISIBLE_MODELS, getSelectListTheme());
      list.onSelect = (item) => done(matches[Number(item.value)]);
      list.onCancel = () => done(undefined);
      container.clear();
      container.addChild(new Text("Fallback model — type to search by provider, ID, or name", 0, 0));
      container.addChild(input);
      container.addChild(list);
    };
    update();
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data) {
        if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((action) => keys.matches(data, action))) {
          list.handleInput(data);
        } else {
          input.handleInput(data);
          update();
        }
        tui.requestRender();
      },
    };
  });
}

async function configureCompaction(path: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`/${COMMAND_NAME} requires interactive or RPC mode; edit ${path} directly.`, "warning");
    return;
  }
  let selected: SettingsAction = "toggle";
  while (true) {
    const settings = await loadCompactionSettings(path);
    const configuration = settings.configuration;
    const current = configuration.fallback;
    const action = await chooseAction(ctx, configuration, selected);
    if (action === undefined) return;
    selected = action;
    if (action === "remote") {
      const selection = { remoteCompactionEnabled: !configuration.remoteCompactionEnabled, fallback: current };
      await settings.save(selection);
      ctx.ui.notify(selection.remoteCompactionEnabled
        ? "Remote Compaction V2 is On. Supported models try V2 before text fallback."
        : "Remote Compaction V2 is Off. Text compaction uses the configured fallback when enabled; otherwise Pi uses the chat model.", "info");
    } else if (action === "toggle") {
      const selection = { ...current, enabled: !current?.enabled };
      await settings.save({ remoteCompactionEnabled: configuration.remoteCompactionEnabled, fallback: selection });
      ctx.ui.notify(describeFallback(selection), "info");
    } else {
      const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
        const a = modelLabel(left);
        const b = modelLabel(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
      if (models.length === 0) {
        ctx.ui.notify("No authenticated models are available. Configure a model in Pi first.", "warning");
      } else {
        const model = await chooseModel(ctx, models);
        if (model !== undefined) {
          const levels = getSupportedThinkingLevels(model);
          const chosenLevel = await ctx.ui.select(`Thinking level for ${model.provider}/${model.id}`, [...levels]);
          if (chosenLevel !== undefined) {
            const thinkingLevel = levels.find((level) => level === chosenLevel);
            if (thinkingLevel === undefined) throw new Error("Select a supported fallback thinking level");
            const selection = { enabled: current?.enabled ?? false, provider: model.provider, model: model.id, thinkingLevel };
            await settings.save({ remoteCompactionEnabled: configuration.remoteCompactionEnabled, fallback: selection });
            ctx.ui.notify(describeFallback(selection), "info");
          }
        }
      }
    }
    // TUI keeps the same row selected so repeated Enter presses toggle in place.
    if (ctx.mode !== "tui") return;
  }
}

export function registerCompactionCommand(pi: ExtensionAPI, path: string): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure V2 and fallback compaction settings",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error(`Usage: /${COMMAND_NAME}`);
        await configureCompaction(path, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not configure compaction settings", "error");
      }
    },
  });
}

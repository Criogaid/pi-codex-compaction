// Own compaction settings interaction; use Pi widgets without changing the session's model or thinking level.
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getSelectListTheme, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, SettingsList, Text } from "@earendil-works/pi-tui";
import { loadCompactionSettings, type FallbackConfiguration } from "./fallback-settings.js";

const COMMAND_NAME = "codex-compaction";
const SUMMARY_SWITCH_LABEL = "Use separate summary model";
const SUMMARY_MODEL_LABEL = "Summary model and thinking level";
const TEXT_SUMMARY_DESCRIPTION = "Text summaries are used when V2 is off, unsupported, or fails.";
const MAX_VISIBLE_MODELS = 10;
type SettingsAction = "model" | "toggle" | "remote";

/** A fallback that failed validation stays editable: V2 can still be toggled and a new model replaces it. */
type FallbackState =
  | { readonly value: FallbackConfiguration | undefined; readonly error?: never }
  | { readonly value?: never; readonly error: string };

function readFallback(read: () => FallbackConfiguration | undefined): FallbackState {
  try {
    return { value: read() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function fallbackModelLabel(selection: FallbackConfiguration | undefined): string | undefined {
  return selection?.model === undefined ? undefined : `${selection.provider}/${selection.model} (${selection.thinkingLevel})`;
}

function describeFallback(selection: FallbackConfiguration | undefined): string {
  const model = fallbackModelLabel(selection);
  if (model === undefined) return "No separate summary model configured; inactive. Pi uses the chat model.";
  return selection?.enabled ? `Text summaries will use ${model}. The chat model is unchanged.`
    : `Separate summary model is Off. Pi will use the chat model for text compaction. Saved model: ${model}.`;
}

async function chooseAction(
  ctx: ExtensionCommandContext,
  remoteCompactionEnabled: boolean,
  fallback: FallbackState,
  selected: SettingsAction,
): Promise<SettingsAction | undefined> {
  const current = fallback.value;
  const invalid = fallback.error !== undefined;
  const description = fallback.error ?? `${TEXT_SUMMARY_DESCRIPTION} ${describeFallback(current)}`;
  const remoteValue = remoteCompactionEnabled ? "On" : "Off";
  const switchValue = invalid ? "Invalid" : current?.enabled ? "On" : "Off";
  if (ctx.mode !== "tui") {
    const switchLabel = `${SUMMARY_SWITCH_LABEL}: ${switchValue}`;
    const remoteLabel = `Remote Compaction V2: ${remoteValue}`;
    const action = await ctx.ui.select(description, [remoteLabel, switchLabel, SUMMARY_MODEL_LABEL]);
    if (action === undefined) return undefined;
    if (action === SUMMARY_MODEL_LABEL) return "model";
    if (action === switchLabel) return "toggle";
    if (action === remoteLabel) return "remote";
    throw new Error("Select a listed compaction setting");
  }
  return ctx.ui.custom<SettingsAction | undefined>((tui, _theme, _keys, done) => {
    const list = new SettingsList([
      { id: "remote", label: "Remote Compaction V2", currentValue: remoteValue, values: ["Off", "On"], description: "When On, try V2 with the chat model. When Off, unsupported, or failed, use text summaries. The settings below choose their model. Existing checkpoints still replay." },
      { id: "toggle", label: SUMMARY_SWITCH_LABEL, currentValue: switchValue, values: invalid ? ["Invalid"] : ["Off", "On"], description },
      { id: "model", label: SUMMARY_MODEL_LABEL, currentValue: invalid ? "Invalid" : fallbackModelLabel(current) ?? "Not configured", values: ["Choose"], description: invalid ? "Choose a model to replace the invalid fallback settings." : `Choose the model and thinking level used when "${SUMMARY_SWITCH_LABEL}" is On. Choosing a model does not enable the switch or change the chat model. ${TEXT_SUMMARY_DESCRIPTION}` },
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
    const query = await ctx.ui.input("Search summary models (provider, ID, or name)", "Leave empty to show all models");
    if (query === undefined) return undefined;
    const matches = fuzzyFilter([...models], query, modelLabel);
    const chosen = await ctx.ui.select("Choose the model for text summaries", matches.map(modelLabel));
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
      container.addChild(new Text("Summary model: type to search by provider, ID, or name", 0, 0));
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
  let selected: SettingsAction = "remote";
  while (true) {
    const settings = await loadCompactionSettings(path);
    const configuration = settings.configuration;
    const fallback = readFallback(() => configuration.fallback);
    const current = fallback.value;
    const action = await chooseAction(ctx, configuration.remoteCompactionEnabled, fallback, selected);
    if (action === undefined) return;
    selected = action;
    if (action === "remote") {
      const remoteCompactionEnabled = !configuration.remoteCompactionEnabled;
      // Save a valid fallback in normalized form; omit an invalid one so the file keeps it as written.
      await settings.save(fallback.error === undefined ? { remoteCompactionEnabled, fallback: current } : { remoteCompactionEnabled });
      ctx.ui.notify(remoteCompactionEnabled
        ? "Remote Compaction V2 is On. Supported models try V2 before text fallback."
        : "Remote Compaction V2 is Off. Text compaction uses the configured fallback when enabled; otherwise Pi uses the chat model.", "info");
    } else if (action === "toggle" && fallback.error !== undefined) {
      ctx.ui.notify(`${fallback.error}. Choose a model to replace it, or edit the file directly.`, "error");
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

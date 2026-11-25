// Own compaction settings interaction; use Pi widgets without changing the session's model or thinking level.
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { getSelectListTheme, getSettingsListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { type CompactionConfiguration, loadCompactionSettings, type SummaryModel } from "./fallback-settings.js";

const COMMAND_NAME = "codex-compaction";
const REMOTE_LABEL = "Remote Compaction V2";
const EFFORT_LABEL = "Codex reasoning effort updates";
const SUMMARY_MODEL_LABEL = "Summary model";
const CHAT_MODEL_LABEL = "Chat model";
const USE_CHAT_MODEL = "Use the chat model";
const TEXT_SUMMARY_DESCRIPTION = "Text summaries are used when V2 is off, unsupported, or fails.";
const MAX_VISIBLE_MODELS = 10;
const SELECT_LIST_ACTIONS = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;
type SettingsAction = "remote" | "effort" | "model";
/** The On/Off settings, each a configuration field the menu toggles. */
const SWITCHES = {
  remote: {
    field: "remoteCompactionEnabled",
    on: "Remote Compaction V2 is On. Supported models try V2 before text summaries.",
    off: "Remote Compaction V2 is Off. Compaction writes text summaries.",
  },
  effort: {
    field: "reasoningEffortUpdatesEnabled",
    on: "Codex reasoning effort updates are On for chat requests and V2.",
    off: "Codex reasoning effort updates are Off in this extension.",
  },
} as const satisfies Record<Exclude<SettingsAction, "model">, {
  readonly field: Exclude<keyof CompactionConfiguration, "summaryModel">;
  readonly on: string;
  readonly off: string;
}>;
/** The chat model is the absence of a summary model, offered as the first choice. */
type ModelChoice = Model<Api> | typeof USE_CHAT_MODEL;

/** A summary model that failed validation stays editable: V2 can still be toggled and a new choice replaces it. */
type SummaryState =
  | { readonly value: SummaryModel | undefined; readonly error?: never }
  | { readonly value?: never; readonly error: string };

function readSummaryModel(read: () => SummaryModel | undefined): SummaryState {
  try {
    return { value: read() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function describeSummaryModel(summary: SummaryModel | undefined): string {
  return summary === undefined ? "Text summaries use the chat model."
    : `Text summaries use ${summary.provider}/${summary.model} (${summary.thinkingLevel}). The chat model is unchanged.`;
}

async function chooseAction(
  ctx: ExtensionCommandContext,
  configuration: CompactionConfiguration,
  summary: SummaryState,
  selected: SettingsAction,
): Promise<SettingsAction | undefined> {
  const description = summary.error ?? `${TEXT_SUMMARY_DESCRIPTION} ${describeSummaryModel(summary.value)}`;
  const switchValue = (action: keyof typeof SWITCHES) => configuration[SWITCHES[action].field] ? "On" : "Off";
  const modelValue = summary.error !== undefined ? "Invalid"
    : summary.value === undefined ? CHAT_MODEL_LABEL : `${summary.value.provider}/${summary.value.model} (${summary.value.thinkingLevel})`;
  const items: (SettingItem & { readonly id: SettingsAction })[] = [
    { id: "remote", label: REMOTE_LABEL, currentValue: switchValue("remote"), values: ["Off", "On"], description: "When On, try V2 with the chat model. When Off, unsupported, or failed, use text summaries. Turning V2 off does not affect previously compressed chat history." },
    { id: "effort", label: EFFORT_LABEL, currentValue: switchValue("effort"), values: ["Off", "On"], description: "When On, send reasoning-effort changes the way Codex does, for chat requests and V2 alike. Replaces the separate pi-codex-reasoning-effort extension; do not enable both." },
    { id: "model", label: SUMMARY_MODEL_LABEL, currentValue: modelValue, values: ["Choose"], description },
  ];
  if (ctx.mode !== "tui") {
    const labels = items.map((item) => `${item.label}: ${item.currentValue}`);
    const action = await ctx.ui.select(description, labels);
    if (action === undefined) return undefined;
    const index = labels.indexOf(action);
    if (index < 0) throw new Error("Select a listed compaction setting");
    return items[index].id;
  }
  return ctx.ui.custom<SettingsAction | undefined>((tui, _theme, _keys, done) => {
    const list = new SettingsList(items, items.length, getSettingsListTheme(),
      (id) => done(items.find((item) => item.id === id)?.id), () => done(undefined));
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

async function chooseModel(ctx: ExtensionCommandContext, models: readonly Model<Api>[]): Promise<ModelChoice | undefined> {
  if (ctx.mode !== "tui") {
    const query = await ctx.ui.input("Search summary models (provider, ID, or name)", "Leave empty to show all models");
    if (query === undefined) return undefined;
    const matches = fuzzyFilter([...models], query, modelLabel);
    const chosen = await ctx.ui.select("Choose the model for text summaries", [USE_CHAT_MODEL, ...matches.map(modelLabel)]);
    if (chosen === undefined) return undefined;
    if (chosen === USE_CHAT_MODEL) return USE_CHAT_MODEL;
    const model = matches.find((candidate) => modelLabel(candidate) === chosen);
    if (!model) throw new Error("Select a listed summary model");
    return model;
  }
  return ctx.ui.custom<ModelChoice | undefined>((tui, _theme, keys, done) => {
    const input = new Input();
    const container = new Container();
    let list: SelectList;
    const update = () => {
      const matches = fuzzyFilter([...models], input.getValue(), modelLabel);
      list = new SelectList([
        { value: USE_CHAT_MODEL, label: USE_CHAT_MODEL, description: "No separate summary model" },
        ...matches.map((model, index) => ({ value: String(index), label: model.id, description: `${model.provider} · ${model.name}` })),
      ], MAX_VISIBLE_MODELS, getSelectListTheme());
      list.onSelect = (item) => done(item.value === USE_CHAT_MODEL ? USE_CHAT_MODEL : matches[Number(item.value)]);
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
        if (SELECT_LIST_ACTIONS.some((action) => keys.matches(data, action))) {
          list.handleInput(data);
        } else {
          const previousQuery = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== previousQuery) update();
        }
        tui.requestRender();
      },
    };
  });
}

/** Undefined means the dialog was cancelled; `{ value: undefined }` selects the chat model. */
async function chooseSummaryModel(ctx: ExtensionCommandContext): Promise<{ readonly value: SummaryModel | undefined } | undefined> {
  const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) => {
    const a = modelLabel(left);
    const b = modelLabel(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const model = await chooseModel(ctx, models);
  if (model === undefined) return undefined;
  if (model === USE_CHAT_MODEL) return { value: undefined };
  const levels = getSupportedThinkingLevels(model);
  const chosenLevel = await ctx.ui.select(`Thinking level for ${model.provider}/${model.id}`, [...levels]);
  if (chosenLevel === undefined) return undefined;
  const thinkingLevel = levels.find((level) => level === chosenLevel);
  if (thinkingLevel === undefined) throw new Error("Select a supported summary thinking level");
  return { value: { provider: model.provider, model: model.id, thinkingLevel } };
}

async function configureCompaction(
  path: string,
  ctx: ExtensionCommandContext,
  onReasoningEffortUpdatesSaved: (enabled: boolean) => void,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`/${COMMAND_NAME} requires interactive or RPC mode; edit ${path} directly.`, "warning");
    return;
  }
  let selected: SettingsAction = "remote";
  while (true) {
    const settings = await loadCompactionSettings(path);
    const configuration = settings.configuration;
    const summary = readSummaryModel(() => configuration.summaryModel);
    const action = await chooseAction(ctx, configuration, summary, selected);
    if (action === undefined) return;
    selected = action;
    if (action === "model") {
      const choice = await chooseSummaryModel(ctx);
      if (choice !== undefined) {
        await settings.save({ summaryModel: choice.value });
        onReasoningEffortUpdatesSaved(configuration.reasoningEffortUpdatesEnabled);
        ctx.ui.notify(describeSummaryModel(choice.value), "info");
      }
    } else {
      const { field, on, off } = SWITCHES[action];
      const enabled = !configuration[field];
      await settings.save({ [field]: enabled });
      onReasoningEffortUpdatesSaved(action === "effort" ? enabled : configuration.reasoningEffortUpdatesEnabled);
      ctx.ui.notify(enabled ? on : off, "info");
    }
    // TUI keeps the same row selected so repeated Enter presses toggle in place.
    if (ctx.mode !== "tui") return;
  }
}

export function registerCompactionCommand(
  pi: ExtensionAPI,
  path: string,
  onReasoningEffortUpdatesSaved: (enabled: boolean) => void,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure V2, reasoning effort updates, and summary model settings",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error(`Usage: /${COMMAND_NAME}`);
        await configureCompaction(path, ctx, onReasoningEffortUpdatesSaved);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not configure compaction settings", "error");
      }
    },
  });
}

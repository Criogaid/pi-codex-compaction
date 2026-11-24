// Own compaction settings, lazy summary-model validation, and revision-bound file updates.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { isObject, type JsonObject } from "./protocol.js";

export const COMPACTION_SETTINGS_RELATIVE_PATH = "extensions/pi-codex-compaction/config.json";
export const DEFAULT_REMOTE_COMPACTION_ENABLED = true;
export const DEFAULT_REASONING_EFFORT_UPDATES_ENABLED = false;
const SETTINGS_VERSION = 2;
const LEGACY_SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;
const DEFAULT_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;

/** The model that writes text summaries. Absent means Pi summarizes with the chat model. */
export interface SummaryModel {
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: string;
}

export interface CompactionConfiguration {
  readonly remoteCompactionEnabled: boolean;
  /** Rewrite ordinary and V2 requests with Codex's sparse reasoning-effort updates. */
  readonly reasoningEffortUpdatesEnabled: boolean;
  readonly summaryModel: SummaryModel | undefined;
}

interface SettingsFile {
  readonly bytes: Buffer | undefined;
  readonly mode: number;
}

async function withSettingsLock(path: string, save: (assertOwned: () => void) => Promise<void>): Promise<void> {
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    // The target can be absent on its first save; the adjacent lock still serializes its creation.
    realpath: false,
    retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 100 },
    onCompromised: (error) => { compromised = error; },
  }).catch((error: unknown) => {
    throw new Error(isObject(error) && error.code === "ELOCKED"
      ? `Compaction settings at ${path} are being edited by another Pi process; reopen /codex-compaction and try again`
      : `Could not lock compaction settings at ${path}`, { cause: error });
  });
  const assertOwned = () => {
    if (compromised) throw new Error(`Compaction settings lock was lost at ${path}; reopen /codex-compaction and try again`, { cause: compromised });
  };
  try {
    assertOwned();
    await save(assertOwned);
  } finally {
    try {
      await release();
    } catch (error) {
      // A compromised lock is already released by proper-lockfile; surface that cause below.
      if (!compromised) throw new Error(`Could not release compaction settings lock at ${path}`, { cause: error });
    }
    assertOwned();
  }
}

async function readSettingsFile(path: string): Promise<SettingsFile> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { bytes: undefined, mode: DEFAULT_FILE_MODE };
    throw new Error(`Could not open compaction settings at ${path}`, { cause: error });
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Compaction settings must be a regular file");
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error(`Compaction settings must not exceed ${MAX_SETTINGS_BYTES} bytes`);
    return { bytes: bytes.subarray(0, length), mode: stat.mode & FILE_PERMISSION_MASK };
  } catch (error) {
    throw new Error(`Could not read compaction settings at ${path}; use a UTF-8 JSON object within ${MAX_SETTINGS_BYTES} bytes`, { cause: error });
  } finally {
    await file.close();
  }
}

function settingsError(path: string, error: unknown): Error {
  const reason = error instanceof SyntaxError || error instanceof TypeError ? "use a UTF-8 JSON object"
    : error instanceof Error ? error.message : "invalid configuration";
  return new Error(`Could not read compaction settings at ${path}; ${reason}`, { cause: error });
}

interface ParsedSettings {
  readonly configuration: CompactionConfiguration;
  /** The unvalidated summary model, kept so saves that do not replace it preserve it as written. */
  readonly rawSummaryModel: { readonly value: unknown } | undefined;
}

function parseSettings(bytes: Buffer | undefined, path: string): ParsedSettings {
  if (bytes === undefined) {
    return {
      configuration: {
        remoteCompactionEnabled: DEFAULT_REMOTE_COMPACTION_ENABLED,
        reasoningEffortUpdatesEnabled: DEFAULT_REASONING_EFFORT_UPDATES_ENABLED,
        summaryModel: undefined,
      },
      rawSummaryModel: undefined,
    };
  }
  // Accept a UTF-8 BOM, reject invalid bytes, and never echo file contents in errors.
  const settings: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isObject(settings)) throw new Error("Compaction settings must be an object");
  const legacy = settings.version === LEGACY_SETTINGS_VERSION;
  const modelKey = legacy ? "fallback" : "summaryModel";
  const keys = legacy ? ["version", "remoteCompaction", modelKey] : ["version", "remoteCompaction", "reasoningEffortUpdates", modelKey];
  if (Object.keys(settings).some((key) => !keys.includes(key))) {
    throw new Error(legacy
      ? "Version 1 compaction settings must be an object with version and optional remoteCompaction and fallback fields"
      : "Compaction settings must be an object with version and optional remoteCompaction, reasoningEffortUpdates, and summaryModel fields");
  }
  if (keys.slice(1).some((key) => key in settings) && !legacy && settings.version !== SETTINGS_VERSION) {
    throw new Error(`version must be ${SETTINGS_VERSION} when compaction settings are configured`);
  }
  const remoteCompactionEnabled = parseSwitch(settings, "remoteCompaction", DEFAULT_REMOTE_COMPACTION_ENABLED);
  const reasoningEffortUpdatesEnabled = parseSwitch(settings, "reasoningEffortUpdates", DEFAULT_REASONING_EFFORT_UPDATES_ENABLED);
  const raw = legacy ? fromLegacyFallback(settings.fallback) : settings.summaryModel;
  let resolved: { readonly value: SummaryModel | undefined } | undefined;
  return {
    configuration: {
      remoteCompactionEnabled,
      reasoningEffortUpdatesEnabled,
      // Successful V2 requests do not need to resolve or validate the summary model.
      get summaryModel() {
        try {
          resolved ??= { value: raw === undefined ? undefined : parseSummaryModel(raw) };
        } catch (error) {
          throw settingsError(path, error);
        }
        return resolved.value;
      },
    },
    rawSummaryModel: raw === undefined ? undefined : { value: raw },
  };
}

function parseSwitch(settings: JsonObject, key: string, defaultValue: boolean): boolean {
  if (!(key in settings)) return defaultValue;
  const value = settings[key];
  if (!isObject(value) || Object.keys(value).some((field) => field !== "enabled") || typeof value.enabled !== "boolean") {
    throw new Error(`${key} must be an object with a boolean enabled field`);
  }
  return value.enabled;
}

/**
 * Version 1 paired the model with an on/off switch. An enabled entry becomes the summary model and a
 * disabled or model-less one becomes none; anything else is passed on so validation reports it.
 */
function fromLegacyFallback(fallback: unknown): unknown {
  if (!isObject(fallback) || ("enabled" in fallback && typeof fallback.enabled !== "boolean")) return fallback;
  const { enabled, ...model } = fallback;
  return enabled === false || Object.keys(model).length === 0 ? undefined : model;
}

function parseSummaryModel(summary: unknown): SummaryModel {
  if (!isObject(summary) || Object.keys(summary).some((key) => !["provider", "model", "thinkingLevel"].includes(key))) {
    throw new Error("summaryModel must be an object with only provider, model, and thinkingLevel fields");
  }
  if (typeof summary.provider !== "string" || !summary.provider.trim() || summary.provider !== summary.provider.trim()) {
    throw new Error("summaryModel.provider must be a non-empty provider ID without surrounding whitespace");
  }
  if (typeof summary.model !== "string" || !summary.model.trim() || summary.model !== summary.model.trim()) {
    throw new Error("summaryModel.model must be a non-empty model ID without surrounding whitespace");
  }
  if (typeof summary.thinkingLevel !== "string" || !summary.thinkingLevel.trim()) {
    throw new Error("summaryModel.thinkingLevel must be a non-empty thinking level");
  }
  return { provider: summary.provider, model: summary.model, thinkingLevel: summary.thinkingLevel };
}

/**
 * Capture one revision; reading configuration.summaryModel validates it on demand and can throw.
 * Saving locks across Pi processes before checking the revision and atomically replacing the file.
 * Omitted fields keep the values from that revision; an omitted summaryModel survives without validation.
 */
export async function loadCompactionSettings(path: string) {
  const original = await readSettingsFile(path);
  let parsed: ParsedSettings;
  try {
    parsed = parseSettings(original.bytes, path);
  } catch (error) {
    throw settingsError(path, error);
  }
  const { configuration, rawSummaryModel } = parsed;
  return {
    configuration,
    async save(selection: Partial<CompactionConfiguration>): Promise<void> {
      const summaryModel = "summaryModel" in selection ? selection.summaryModel : rawSummaryModel?.value;
      await withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await withSettingsLock(path, async (assertOwned) => {
          const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
          const bytes = Buffer.from(`${JSON.stringify({
            version: SETTINGS_VERSION,
            remoteCompaction: { enabled: selection.remoteCompactionEnabled ?? configuration.remoteCompactionEnabled },
            reasoningEffortUpdates: { enabled: selection.reasoningEffortUpdatesEnabled ?? configuration.reasoningEffortUpdatesEnabled },
            ...(summaryModel === undefined ? {} : { summaryModel }),
          }, null, 2)}\n`);
          if (bytes.length > MAX_SETTINGS_BYTES) throw new Error(`Compaction settings must not exceed ${MAX_SETTINGS_BYTES} bytes`);
          try {
            await writeFile(temporary, bytes, { flag: "wx", mode: original.mode });
            const current = await readSettingsFile(path);
            if (original.bytes === undefined ? current.bytes !== undefined : !current.bytes?.equals(original.bytes)) {
              throw new Error("Compaction settings changed while the menu was open; reopen /codex-compaction and try again");
            }
            // Reading follows existing symlinks; an atomic replacement would remove the link itself.
            const entry = await lstat(path).catch((error: unknown) => {
              if (isObject(error) && error.code === "ENOENT") return undefined;
              throw error;
            });
            if (entry?.isSymbolicLink()) {
              throw new Error(`Compaction settings are a symbolic link; edit its target directly at ${path}`);
            }
            assertOwned();
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
        });
      });
    },
  };
}

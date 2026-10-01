// Own the fallback configuration format and revision-bound file updates used by compaction and its command.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isObject } from "./protocol.js";

export const FALLBACK_SETTINGS_RELATIVE_PATH = "extensions/pi-codex-compaction/config.json";
const LEGACY_FALLBACK_ENABLED = true;
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;
const DEFAULT_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;

export type FallbackConfiguration = { readonly enabled: boolean } & (
  | { readonly provider: string; readonly model: string; readonly thinkingLevel: string }
  | { readonly provider?: never; readonly model?: never; readonly thinkingLevel?: never }
);

interface SettingsFile {
  readonly bytes: Buffer | undefined;
  readonly mode: number;
}

async function readSettingsFile(path: string): Promise<SettingsFile> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { bytes: undefined, mode: DEFAULT_FILE_MODE };
    throw new Error(`Could not open fallback settings at ${path}`, { cause: error });
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Fallback settings must be a regular file");
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error(`Fallback settings must not exceed ${MAX_SETTINGS_BYTES} bytes`);
    return { bytes: bytes.subarray(0, length), mode: stat.mode & FILE_PERMISSION_MASK };
  } catch (error) {
    throw new Error(`Could not read fallback settings at ${path}; use a UTF-8 JSON object within ${MAX_SETTINGS_BYTES} bytes`, { cause: error });
  } finally {
    await file.close();
  }
}

function parseSettings(bytes: Buffer | undefined): FallbackConfiguration | undefined {
  if (bytes === undefined) return undefined;
  // Accept a UTF-8 BOM, reject invalid bytes, and never echo file contents in errors.
  const settings: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isObject(settings) || Object.keys(settings).some((key) => !["version", "fallback"].includes(key))) {
    throw new Error("Fallback settings must be an object with version and the optional fallback field");
  }
  if (!("fallback" in settings)) return undefined;
  if (settings.version !== SETTINGS_VERSION) throw new Error(`version must be ${SETTINGS_VERSION} when fallback is configured`);
  const fallback = settings.fallback;
  if (!isObject(fallback) || Object.keys(fallback).some((key) => !["enabled", "provider", "model", "thinkingLevel"].includes(key))) {
    throw new Error("fallback must be an object with only enabled, provider, model, and thinkingLevel fields");
  }
  if ("enabled" in fallback && typeof fallback.enabled !== "boolean") {
    throw new Error("fallback.enabled must be a boolean");
  }
  const enabled = typeof fallback.enabled === "boolean" ? fallback.enabled : LEGACY_FALLBACK_ENABLED;
  if (!("provider" in fallback) && !("model" in fallback) && !("thinkingLevel" in fallback)) {
    return { enabled };
  }
  if (typeof fallback.provider !== "string" || !fallback.provider.trim() || fallback.provider !== fallback.provider.trim()) {
    throw new Error("fallback.provider must be a non-empty provider ID without surrounding whitespace");
  }
  if (typeof fallback.model !== "string" || !fallback.model.trim() || fallback.model !== fallback.model.trim()) {
    throw new Error("fallback.model must be a non-empty model ID without surrounding whitespace");
  }
  if (typeof fallback.thinkingLevel !== "string" || !fallback.thinkingLevel.trim()) {
    throw new Error("fallback.thinkingLevel must be a non-empty thinking level");
  }
  return {
    enabled,
    provider: fallback.provider, model: fallback.model, thinkingLevel: fallback.thinkingLevel,
  };
}

/** Capture settings for display or execution. Saving detects intervening edits and replaces the file atomically. */
export async function loadFallbackSettings(path: string) {
  const original = await readSettingsFile(path);
  let fallback: FallbackConfiguration | undefined;
  try {
    fallback = parseSettings(original.bytes);
  } catch (error) {
    throw new Error(`Could not read fallback settings at ${path}; ${error instanceof SyntaxError || error instanceof TypeError ? "use a UTF-8 JSON object" : error instanceof Error ? error.message : "invalid configuration"}`, { cause: error });
  }
  return {
    fallback,
    async save(selection: FallbackConfiguration): Promise<void> {
      await withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
        const bytes = Buffer.from(`${JSON.stringify({ version: SETTINGS_VERSION, fallback: selection }, null, 2)}\n`);
        if (bytes.length > MAX_SETTINGS_BYTES) throw new Error(`Fallback settings must not exceed ${MAX_SETTINGS_BYTES} bytes`);
        try {
          await writeFile(temporary, bytes, { flag: "wx", mode: original.mode });
          const current = await readSettingsFile(path);
          if (original.bytes === undefined ? current.bytes !== undefined : !current.bytes?.equals(original.bytes)) {
            throw new Error("Fallback settings changed while the menu was open; reopen /codex-compaction and try again");
          }
          // Reading follows existing symlinks; an atomic replacement would remove the link itself.
          const entry = await lstat(path).catch((error: unknown) => {
            if (isObject(error) && error.code === "ENOENT") return undefined;
            throw error;
          });
          if (entry?.isSymbolicLink()) {
            throw new Error(`Fallback settings are a symbolic link; edit its target directly at ${path}`);
          }
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
  };
}

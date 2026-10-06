// Own compaction settings, lazy fallback validation, and revision-bound file updates.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { isObject } from "./protocol.js";

export const COMPACTION_SETTINGS_RELATIVE_PATH = "extensions/pi-codex-compaction/config.json";
const LEGACY_FALLBACK_ENABLED = true;
export const DEFAULT_REMOTE_COMPACTION_ENABLED = true;
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 16 * 1024;
const DEFAULT_FILE_MODE = 0o600;
const FILE_PERMISSION_MASK = 0o777;

export type FallbackConfiguration = { readonly enabled: boolean } & (
  | { readonly provider: string; readonly model: string; readonly thinkingLevel: string }
  | { readonly provider?: never; readonly model?: never; readonly thinkingLevel?: never }
);

export interface CompactionConfiguration {
  readonly remoteCompactionEnabled: boolean;
  readonly fallback: FallbackConfiguration | undefined;
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
  /** The unvalidated fallback field, kept so saves that do not replace it preserve it as written. */
  readonly rawFallback: { readonly value: unknown } | undefined;
}

function parseSettings(bytes: Buffer | undefined, path: string): ParsedSettings {
  if (bytes === undefined) {
    return { configuration: { remoteCompactionEnabled: DEFAULT_REMOTE_COMPACTION_ENABLED, fallback: undefined }, rawFallback: undefined };
  }
  // Accept a UTF-8 BOM, reject invalid bytes, and never echo file contents in errors.
  const settings: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isObject(settings) || Object.keys(settings).some((key) => !["version", "remoteCompaction", "fallback"].includes(key))) {
    throw new Error("Compaction settings must be an object with version and optional remoteCompaction and fallback fields");
  }
  if (("fallback" in settings || "remoteCompaction" in settings) && settings.version !== SETTINGS_VERSION) {
    throw new Error(`version must be ${SETTINGS_VERSION} when compaction settings are configured`);
  }
  let remoteCompactionEnabled = DEFAULT_REMOTE_COMPACTION_ENABLED;
  if ("remoteCompaction" in settings) {
    const remote = settings.remoteCompaction;
    if (!isObject(remote) || Object.keys(remote).some((key) => key !== "enabled") || typeof remote.enabled !== "boolean") {
      throw new Error("remoteCompaction must be an object with a boolean enabled field");
    }
    remoteCompactionEnabled = remote.enabled;
  }
  let resolvedFallback: { readonly value: FallbackConfiguration | undefined } | undefined;
  return {
    configuration: {
      remoteCompactionEnabled,
      // Successful V2 requests do not need to resolve or validate fallback settings.
      get fallback() {
        try {
          resolvedFallback ??= { value: "fallback" in settings ? parseFallback(settings.fallback) : undefined };
        } catch (error) {
          throw settingsError(path, error);
        }
        return resolvedFallback.value;
      },
    },
    rawFallback: "fallback" in settings ? { value: settings.fallback } : undefined,
  };
}

function parseFallback(fallback: unknown): FallbackConfiguration {
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

/**
 * Capture one revision; reading configuration.fallback validates it on demand and can throw.
 * Saving locks across Pi processes before checking the revision and atomically replacing the file.
 * A selection without a fallback field keeps the file's fallback as written.
 */
export async function loadCompactionSettings(path: string) {
  const original = await readSettingsFile(path);
  let parsed: ParsedSettings;
  try {
    parsed = parseSettings(original.bytes, path);
  } catch (error) {
    throw settingsError(path, error);
  }
  const { configuration, rawFallback } = parsed;
  return {
    configuration,
    async save(selection: { readonly remoteCompactionEnabled: boolean; readonly fallback?: FallbackConfiguration | undefined }): Promise<void> {
      const fallback = "fallback" in selection ? selection.fallback : rawFallback?.value;
      await withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await withSettingsLock(path, async (assertOwned) => {
          const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
          const bytes = Buffer.from(`${JSON.stringify({
            version: SETTINGS_VERSION,
            remoteCompaction: { enabled: selection.remoteCompactionEnabled },
            ...(fallback === undefined ? {} : { fallback }),
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

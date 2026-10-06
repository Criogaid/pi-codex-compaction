// Own model eligibility and endpoint identity; authentication supplies the effective base URL.
import type { Api, Model } from "@earendil-works/pi-ai";
import { isObject } from "./protocol.js";

export const CODEX_API = "openai-codex-responses" as const;
// Name-matched models need a Responses payload with an input array and a query-free request URL.
const NAME_MATCH_APIS: readonly Api[] = ["openai-responses", CODEX_API];

export interface ProviderIdentity {
  readonly provider: string;
  readonly api: Api;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly endpoint: string;
}
export interface CapableModel {
  readonly model: Model<Api>;
  readonly identity: ProviderIdentity;
}
export interface CompactionModelMetadata {
  /** The producing model's physical window, when its catalogue exposes a valid value. */
  readonly modelContextWindow?: number;
  /** An explicitly configured opaque compatibility identifier, never inferred from model identity. */
  readonly compactionModelHash?: string;
}

/** Ignore malformed optional metadata without rejecting an otherwise valid v1 checkpoint. */
export function normalizeCompactionModelMetadata(value: unknown): CompactionModelMetadata {
  if (!isObject(value)) return {};
  const modelContextWindow = value.modelContextWindow;
  const compactionModelHash = value.compactionModelHash;
  return {
    ...(typeof modelContextWindow === "number" && Number.isSafeInteger(modelContextWindow) && modelContextWindow > 0
      ? { modelContextWindow } : {}),
    ...(typeof compactionModelHash === "string" && compactionModelHash.length > 0 &&
      compactionModelHash.length <= 1024 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(compactionModelHash)
      ? { compactionModelHash } : {}),
  };
}

/** Pi exposes no server comp_hash; operators may supply an explicit V2 compatibility identifier. */
export function compactionModelMetadata(model: Model<Api>): CompactionModelMetadata {
  const compat: unknown = model.compat;
  const configured = isObject(compat) ? compat.remoteCompaction : undefined;
  return normalizeCompactionModelMetadata({
    modelContextWindow: model.contextWindow,
    compactionModelHash: isObject(configured) && configured.protocol === "v2"
      ? configured.compactionModelHash : undefined,
  });
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("URL must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("URL must not contain credentials, a query, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}
/** Use Pi's Codex route for that adapter and the Responses route for other APIs. */
export function deriveEndpoint(baseUrl: string, api: Api): string {
  if (api !== CODEX_API) return `${baseUrl}/responses`;
  if (baseUrl.endsWith("/codex/responses")) return baseUrl;
  if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

function configuredEndpoint(value: unknown, model: Model<Api>, baseUrl: string): string | undefined {
  if (!isObject(value) || value.protocol !== "v2" ||
      (value.endpoint !== undefined && typeof value.endpoint !== "string")) return undefined;
  try {
    const endpoint = typeof value.endpoint === "string"
      ? normalizeUrl(value.endpoint) : deriveEndpoint(baseUrl, model.api);
    return new URL(baseUrl).origin === new URL(endpoint).origin ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

export function capableModel(model: Model<Api> | undefined, effectiveBaseUrl?: string): CapableModel | undefined {
  if (!model) return undefined;
  // Pi preserves extension metadata but its built-in compatibility type does not declare it.
  const compat: unknown = model.compat;
  const configured = isObject(compat) ? compat.remoteCompaction : undefined;
  if (configured === undefined &&
      (!NAME_MATCH_APIS.includes(model.api) || !model.id.toLowerCase().includes("gpt"))) return undefined;
  let configuredBaseUrl: string;
  let baseUrl: string;
  try {
    configuredBaseUrl = normalizeUrl(model.baseUrl);
    baseUrl = effectiveBaseUrl === undefined ? configuredBaseUrl : normalizeUrl(effectiveBaseUrl);
  } catch {
    return undefined;
  }
  const endpoint = configured === undefined
    ? deriveEndpoint(baseUrl, model.api) : configuredEndpoint(configured, model, baseUrl);
  return endpoint ? {
    model,
    identity: { provider: model.provider, api: model.api, modelId: model.id, baseUrl, endpoint },
  } : undefined;
}

/** Compare provider and API before authentication resolves the endpoint. */
export function sameProvider(
  left: Pick<ProviderIdentity, "provider" | "api">,
  right: { readonly provider: string; readonly api: string },
): boolean {
  return left.provider === right.provider && left.api === right.api;
}

export function sameModel(
  left: Pick<ProviderIdentity, "provider" | "api" | "modelId">,
  right: Pick<Model<Api>, "provider" | "api" | "id">,
): boolean {
  return sameProvider(left, right) && left.modelId === right.id;
}

/** Compare endpoint identity only; matching backends do not prove opaque model compatibility. */
export function sameBackend(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return sameProvider(left, right) && left.baseUrl === right.baseUrl && left.endpoint === right.endpoint;
}

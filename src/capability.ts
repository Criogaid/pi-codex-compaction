// Own model eligibility and endpoint identity; authentication supplies the effective base URL.
import type { Api, Model } from "@earendil-works/pi-ai";
import { isObject } from "./protocol.js";

export const CODEX_API = "openai-codex-responses" as const;

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
  if (configured === undefined && !model.id.toLowerCase().includes("gpt")) return undefined;
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

/**
 * Codex keeps compaction items across model switches on one backend and narrows that only by
 * the server's comp_hash, which Pi does not expose. Checkpoints therefore bind to the backend.
 */
export function sameBackend(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return sameProvider(left, right) && left.baseUrl === right.baseUrl && left.endpoint === right.endpoint;
}

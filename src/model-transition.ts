// Keep model compatibility evidence separate from endpoint identity and context-window sizing.
import {
  compactionModelMetadata,
  normalizeCompactionModelMetadata,
  sameBackend,
  sameModel,
  type CapableModel,
  type CompactionModelMetadata,
  type ProviderIdentity,
} from "./capability.js";

export type ModelCompatibility =
  | "different-backend"
  | "mismatched-hash"
  | "matching-hash"
  | "same-model"
  | "unknown";

export interface ModelTransitionAssessment {
  /** same-model preserves the producing identity but does not assert a verified hash match. */
  readonly compatibility: ModelCompatibility;
  readonly modelChanged: boolean;
  readonly sourceContextWindow?: number;
  readonly targetContextWindow?: number;
  /** Undefined when either window is unknown; size alone never proves hash compatibility. */
  readonly downsizing: boolean | undefined;
}

export function assessModelTransition(
  checkpoint: ProviderIdentity & CompactionModelMetadata,
  target: CapableModel,
): ModelTransitionAssessment {
  const sourceMetadata = normalizeCompactionModelMetadata(checkpoint);
  const targetMetadata = compactionModelMetadata(target.model);
  const modelChanged = !sameModel(checkpoint, target.model);
  let compatibility: ModelCompatibility;
  if (!sameBackend(checkpoint, target.identity)) {
    compatibility = "different-backend";
  } else if (sourceMetadata.compactionModelHash !== undefined && targetMetadata.compactionModelHash !== undefined) {
    // Check revisions before identity: even the same model ID may acquire an incompatible hash.
    compatibility = sourceMetadata.compactionModelHash === targetMetadata.compactionModelHash
      ? "matching-hash" : "mismatched-hash";
  } else {
    compatibility = modelChanged ? "unknown" : "same-model";
  }
  const sourceContextWindow = sourceMetadata.modelContextWindow;
  const targetContextWindow = targetMetadata.modelContextWindow;
  return {
    compatibility,
    modelChanged,
    ...(sourceContextWindow !== undefined ? { sourceContextWindow } : {}),
    ...(targetContextWindow !== undefined ? { targetContextWindow } : {}),
    downsizing: sourceContextWindow === undefined || targetContextWindow === undefined
      ? undefined : targetContextWindow < sourceContextWindow,
  };
}

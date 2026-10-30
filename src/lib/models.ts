import type { ModelInfo, ModelRef } from "../../shared/protocol";

export const modelKey = (model: ModelRef) => `${model.provider}/${model.id}`;

export function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models)
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups];
}

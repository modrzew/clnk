import type { ModelInfo, ModelRef } from "../../shared/protocol";
import { groupByProvider, modelKey } from "../lib/models";

interface ModelSelectProps {
  models: ModelInfo[];
  value: ModelRef | undefined;
  onChange: (model: ModelRef) => void;
}

export function ModelSelect({ models, value, onChange }: ModelSelectProps) {
  const selected = value ? modelKey(value) : "";
  const known = models.some((model) => modelKey(model) === selected);
  return (
    <select
      className="model-select"
      aria-label="Model"
      title={value ? modelKey(value) : undefined}
      value={selected}
      onChange={(event) => {
        const model = models.find((m) => modelKey(m) === event.target.value);
        if (model) onChange({ provider: model.provider, id: model.id });
      }}
    >
      {value && !known && (
        <option value={selected}>{value.id} (unavailable)</option>
      )}
      {groupByProvider(models).map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>
              {model.name || model.id}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

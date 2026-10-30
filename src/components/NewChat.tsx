import { useEffect, useState } from "react";
import type {
  ModelInfo,
  ModelRef,
  ModelsResponse,
} from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { navigate } from "../lib/hooks";
import { Composer } from "./Composer";
import { Header } from "./Header";

const LAST_MODEL_KEY = "clnk.lastModel";

const modelKey = (model: ModelRef) => `${model.provider}/${model.id}`;

export function NewChat({
  client,
  onMenu,
}: {
  client: BackendClient;
  onMenu: () => void;
}) {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    client
      .getModels()
      .then((response) => {
        if (cancelled) return;
        setModels(response);
        const keys = response.models.map(modelKey);
        const last = localStorage.getItem(LAST_MODEL_KEY);
        if (last && keys.includes(last)) setSelected(last);
        else if (response.defaultModel)
          setSelected(modelKey(response.defaultModel));
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const model = models?.models.find((m) => modelKey(m) === selected);

  async function start(message: string) {
    if (!model) throw new Error("Pick a model first");
    const { chat } = await client.createChat({
      model: { provider: model.provider, id: model.id },
      message,
    });
    localStorage.setItem(LAST_MODEL_KEY, selected);
    navigate({ name: "chat", chatId: chat.id });
  }

  return (
    <>
      <Header title="New chat" onMenu={onMenu} />
      <div className="new-chat">
        <h2>What should Pi do?</h2>
        {error && (
          <div className="run-error">Couldn't load models: {error}</div>
        )}
        {models && models.models.length === 0 && (
          <div className="run-error">
            No models are available. Configure a provider for Pi on the backend
            machine.
          </div>
        )}
        {models && models.models.length > 0 && (
          <label className="model-picker">
            <span>Model</span>
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {groupByProvider(models.models).map(([provider, list]) => (
                <optgroup key={provider} label={provider}>
                  {list.map((m) => (
                    <option key={modelKey(m)} value={modelKey(m)}>
                      {m.name || m.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </div>
      <Composer
        blockedReason={model ? undefined : "Pick a model to start"}
        autoFocus
        onSend={start}
      />
    </>
  );
}

function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models)
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups];
}

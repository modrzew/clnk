import { useState } from "react";
import type { ModelRef, ModelsResponse } from "../../shared/protocol";
import type { BackendClient } from "../lib/client";
import { type Models, navigate } from "../lib/hooks";
import { modelKey } from "../lib/models";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { ModelSelect } from "./ModelSelect";
import styles from "./NewChat.module.css";
import ui from "./ui.module.css";

const LAST_MODEL_KEY = "clnk.lastModel";

export function NewChat({
  client,
  models,
  onMenu,
}: {
  client: BackendClient;
  models: Models;
  onMenu: () => void;
}) {
  return (
    <>
      <Header title="New chat" onMenu={onMenu} />
      <div className={styles.newChat}>
        <h2>What should Pi do?</h2>
      </div>
      <NewChatComposer client={client} models={models} />
    </>
  );
}

/** Starts a chat, in a project if given, and opens it. */
export function NewChatComposer({
  client,
  models,
  projectId,
  placeholder,
}: {
  client: BackendClient;
  models: Models;
  projectId?: string;
  placeholder?: string;
}) {
  const [picked, setPicked] = useState<ModelRef | null>(null);
  const available = models.models?.models ?? [];
  const model = picked ?? initialModel(models.models);

  async function start(message: string, files: File[]) {
    if (!model) throw new Error("Pick a model first");
    const { chat } = await client.createChat(
      { model, message, projectId },
      files,
    );
    localStorage.setItem(LAST_MODEL_KEY, modelKey(model));
    navigate({ name: "chat", chatId: chat.id });
  }

  return (
    <>
      {models.error && !models.models && (
        <div className={ui.errorBanner}>
          Couldn't load models: {models.error}
        </div>
      )}
      {models.models && available.length === 0 && (
        <div className={ui.errorBanner}>
          No models are available. Configure a provider for Pi on the backend
          machine.
        </div>
      )}
      <Composer
        blockedReason={model ? undefined : "Pick a model to start"}
        placeholder={placeholder}
        autoFocus
        seesImages={
          model
            ? available.find((m) => modelKey(m) === modelKey(model))?.images
            : undefined
        }
        onSend={start}
      >
        {available.length > 0 && (
          <ModelSelect
            models={available}
            value={model ?? undefined}
            onChange={setPicked}
          />
        )}
      </Composer>
    </>
  );
}

/** The model last used for a new chat, if it's still available, or else the backend's default. */
function initialModel(response: ModelsResponse | null): ModelRef | null {
  if (!response) return null;
  const last = localStorage.getItem(LAST_MODEL_KEY);
  const model =
    response.models.find((m) => modelKey(m) === last) ?? response.defaultModel;
  return model ? { provider: model.provider, id: model.id } : null;
}

import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { NewChat } from "./components/NewChat";
import { ProjectDialog } from "./components/ProjectDialog";
import { ProjectView } from "./components/ProjectView";
import { Settings } from "./components/Settings";
import { Login, Setup } from "./components/Setup";
import { Sidebar } from "./components/Sidebar";
import { BackendClient } from "./lib/client";
import {
  navigate,
  useChats,
  useConnectionStatus,
  useModels,
  useProjects,
  useRoute,
  useUser,
} from "./lib/hooks";
import { useChatNotifications } from "./lib/notifications";
import styles from "./App.module.css";

const BACKEND_URL_KEY = "clnk.backendUrl";
/** Session token for the backend at BACKEND_URL_KEY. */
const TOKEN_KEY = "clnk.token";

/**
 * Served over http(s), the page most likely came from the backend itself (or the dev proxy). The apps
 * serve their own, over http on Android.
 */
function suggestedBackendUrl() {
  return window.location.protocol.startsWith("http") && !isTauri()
    ? window.location.origin
    : "";
}

function App() {
  const [backendUrl, setBackendUrl] = useState(() =>
    localStorage.getItem(BACKEND_URL_KEY),
  );
  const [changingBackend, setChangingBackend] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const forgetToken = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }, []);

  if (!backendUrl || changingBackend) {
    return (
      <Setup
        initialUrl={backendUrl ?? suggestedBackendUrl()}
        onCancel={backendUrl ? () => setChangingBackend(false) : undefined}
        onConnect={(url) => {
          if (url !== backendUrl) forgetToken();
          localStorage.setItem(BACKEND_URL_KEY, url);
          setBackendUrl(url);
          setChangingBackend(false);
        }}
      />
    );
  }
  if (!token) {
    return (
      <Login
        backendUrl={backendUrl}
        onChangeBackend={() => setChangingBackend(true)}
        onLogin={(token) => {
          localStorage.setItem(TOKEN_KEY, token);
          setToken(token);
        }}
      />
    );
  }
  return (
    <Shell
      key={`${backendUrl} ${token}`}
      backendUrl={backendUrl}
      token={token}
      onLoggedOut={forgetToken}
      onChangeBackend={() => setChangingBackend(true)}
    />
  );
}

function Shell({
  backendUrl,
  token,
  onLoggedOut,
  onChangeBackend,
}: {
  backendUrl: string;
  token: string;
  onLoggedOut: () => void;
  onChangeBackend: () => void;
}) {
  const client = useMemo(
    () => new BackendClient(backendUrl, token, onLoggedOut),
    [backendUrl, token, onLoggedOut],
  );
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  const connection = useConnectionStatus(client);
  const user = useUser(client);
  const chats = useChats(client);
  const projects = useProjects(client);
  const models = useModels(client);
  const route = useRoute();
  useChatNotifications(client, route.name === "chat" ? route.chatId : null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openSidebar = () => setSidebarOpen(true);
  const findProject = (projectId: string | null | undefined) =>
    projects?.find((project) => project.id === projectId);

  let page;
  if (route.name === "chat") {
    const chat = chats?.find((chat) => chat.id === route.chatId);
    page = (
      <ChatView
        key={route.chatId}
        client={client}
        chatId={route.chatId}
        chat={chat}
        project={findProject(chat?.projectId)}
        chatsLoaded={chats !== null}
        models={models.models?.models ?? []}
        onMenu={openSidebar}
      />
    );
  } else if (route.name === "project") {
    page = (
      <ProjectView
        key={route.projectId}
        client={client}
        project={findProject(route.projectId)}
        projectsLoaded={projects !== null}
        chats={
          chats?.filter((chat) => chat.projectId === route.projectId) ?? []
        }
        models={models}
        onMenu={openSidebar}
      />
    );
  } else {
    page = <NewChat client={client} models={models} onMenu={openSidebar} />;
  }

  return (
    <div className={styles.app}>
      <Sidebar
        chats={chats}
        projects={projects}
        route={route}
        connection={connection}
        backendUrl={backendUrl}
        user={user}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onChangeBackend={onChangeBackend}
        onOpenSettings={() => {
          setSidebarOpen(false);
          setSettingsOpen(true);
        }}
        onNewProject={() => {
          setSidebarOpen(false);
          setCreatingProject(true);
        }}
        onArchive={(chatId, archived) => {
          setError(null);
          client
            .updateChat(chatId, { archived })
            .catch((err: Error) => setError(err.message));
        }}
      />
      <Settings
        open={settingsOpen}
        client={client}
        user={user}
        onClose={() => setSettingsOpen(false)}
        onLogOut={() => {
          // Logged out here whether or not the backend can be reached.
          client.logout().catch(() => {});
          onLoggedOut();
        }}
      />
      {creatingProject && (
        <ProjectDialog
          onClose={() => setCreatingProject(false)}
          onSave={async (fields) => {
            const { project } = await client.createProject(fields);
            navigate({ name: "project", projectId: project.id });
          }}
        />
      )}
      <main className={styles.main}>
        {connection === "offline" && (
          <div className={styles.offlineBanner}>
            Connection lost. Reconnecting…
          </div>
        )}
        {error && (
          <div className={styles.offlineBanner} onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {page}
      </main>
    </div>
  );
}

export default App;

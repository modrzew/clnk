import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { NewChat } from "./components/NewChat";
import { Setup } from "./components/Setup";
import { Sidebar } from "./components/Sidebar";
import { BackendClient } from "./lib/client";
import { useChats, useConnectionStatus, useRoute } from "./lib/hooks";
import "./App.css";

const BACKEND_URL_KEY = "clnk.backendUrl";

/** Served over http(s), the page most likely came from the backend itself (or the dev proxy). */
function suggestedBackendUrl() {
  return window.location.protocol.startsWith("http")
    ? window.location.origin
    : "";
}

function App() {
  const [backendUrl, setBackendUrl] = useState(() =>
    localStorage.getItem(BACKEND_URL_KEY),
  );
  const [changingBackend, setChangingBackend] = useState(false);

  if (!backendUrl || changingBackend) {
    return (
      <Setup
        initialUrl={backendUrl ?? suggestedBackendUrl()}
        onCancel={backendUrl ? () => setChangingBackend(false) : undefined}
        onConnect={(url) => {
          localStorage.setItem(BACKEND_URL_KEY, url);
          setBackendUrl(url);
          setChangingBackend(false);
        }}
      />
    );
  }
  return (
    <Shell
      key={backendUrl}
      backendUrl={backendUrl}
      onChangeBackend={() => setChangingBackend(true)}
    />
  );
}

function Shell({
  backendUrl,
  onChangeBackend,
}: {
  backendUrl: string;
  onChangeBackend: () => void;
}) {
  const client = useMemo(() => new BackendClient(backendUrl), [backendUrl]);
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  const connection = useConnectionStatus(client);
  const chats = useChats(client);
  const route = useRoute();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openSidebar = () => setSidebarOpen(true);

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        route={route}
        connection={connection}
        backendUrl={backendUrl}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onChangeBackend={onChangeBackend}
      />
      <main className="main">
        {connection === "offline" && (
          <div className="offline-banner">Connection lost. Reconnecting…</div>
        )}
        {route.name === "chat" ? (
          <ChatView
            key={route.chatId}
            client={client}
            chatId={route.chatId}
            chat={chats?.find((chat) => chat.id === route.chatId)}
            chatsLoaded={chats !== null}
            onMenu={openSidebar}
          />
        ) : (
          <NewChat client={client} onMenu={openSidebar} />
        )}
      </main>
    </div>
  );
}

export default App;

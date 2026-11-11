// First, so its cascade layer order applies to all CSS.
import "./global.css";
// Next, so the colours are on the page before anything renders.
import "./lib/theme";
// So the app has the icon that was chosen from the start.
import "./lib/appIcon";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

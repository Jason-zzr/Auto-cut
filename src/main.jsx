import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { registerModelCacheServiceWorker } from "./lib/serviceWorker.js";
import { connectHostSession } from "./lib/hostSession.js";
import "./styles.css";

registerModelCacheServiceWorker();

const rootElement = document.getElementById("root");
void connectHostSession().then((hostSession) => {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App hostSession={hostSession} />
    </React.StrictMode>,
  );
}).catch((error) => {
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = error instanceof Error ? error.message : "Auto-cut page session could not be opened.";
  rootElement.replaceChildren(message);
});

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
// One partial per area, after the base sheet so each can override it (tokens and primitives stay in styles.css).
import "./styles/nav.css";
import "./styles/channel.css";
import "./styles/thread.css";
import "./styles/overlays.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

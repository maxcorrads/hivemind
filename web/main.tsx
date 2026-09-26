import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { trackVisualViewport } from "./visual-viewport.ts";
import "./styles.css";
// One partial per area, after the base sheet so each can override it (tokens and primitives stay in styles.css).
import "./styles/nav.css";
import "./styles/channel.css";
import "./styles/thread.css";
import "./styles/overlays.css";
import "./styles/terminal.css";

// Modals follow the on-screen keyboard (iOS shrinks only the visual viewport).
trackVisualViewport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

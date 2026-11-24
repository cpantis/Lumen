import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled (no request to Google Fonts): latin + latin-ext covers Romanian ă â î ș ț
import "@fontsource/poppins/latin-200.css";
import "@fontsource/poppins/latin-ext-200.css";
import "@fontsource/poppins/latin-300.css";
import "@fontsource/poppins/latin-ext-300.css";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-ext-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-ext-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-ext-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-ext-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-ext-500.css";
import "./styles/app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

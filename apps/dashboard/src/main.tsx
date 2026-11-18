import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui/tokens.css";
import "./styles.css";
import "./ui/ui.css";
import "./review/review.css";
import "./facts/facts.css";
import "./home/home.css";
import "./tokens/tokens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

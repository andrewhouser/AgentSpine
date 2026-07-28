import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./components/AppShell/AppShell.tsx";
import { TokenGate } from "./components/TokenGate/TokenGate.tsx";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TokenGate>
      <AppShell />
    </TokenGate>
  </StrictMode>,
);

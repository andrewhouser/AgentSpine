import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./components/AppShell/AppShell.tsx";
import { TokenGate } from "./components/TokenGate/TokenGate.tsx";
import { readPreferences, watchSystemTheme } from "./lib/preferences.ts";
import "./styles/global.css";

// The stored preferences were already applied by the inline script in index.html, before
// paint. What is left is following the OS *while the page is open* — the switch that matters
// is light-to-dark at sunset with the dashboard sitting there, which no one is going to
// reload for. Registered here rather than in a component because it outlives every view and
// reads storage directly, so it needs no React state to stay correct.
watchSystemTheme(() => readPreferences().theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TokenGate>
      <AppShell />
    </TokenGate>
  </StrictMode>,
);

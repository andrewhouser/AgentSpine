import type { ReactNode } from "react";

import { useEffect, useState } from "react";

import { api, setToken, UnauthorizedError } from "../../lib/api.ts";
import styles from "./TokenGate.module.css";

interface TokenGateProps {
  children: ReactNode;
}

/**
 * Ask for the dashboard token, but only if the server actually wants one.
 *
 * On localhost it doesn't, and the old dashboard's `prompt()`-on-401 was a poor fit for a
 * long-lived app: any request could raise it, at any moment, mid-conversation. So the
 * check happens once, up front, against a cheap endpoint.
 */
export const TokenGate = ({ children }: TokenGateProps) => {
  const [state, setState] = useState<"checking" | "needsToken" | "ready" | "unreachable">("checking");
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState("");
  const [tried, setTried] = useState(false);

  // The check runs on mount and on every retry; `attempt` is what a retry bumps, so the
  // request itself only ever happens here rather than from three call sites.
  useEffect(() => {
    let cancelled = false;
    api
      .status()
      .then(() => !cancelled && setState("ready"))
      .catch((err) => !cancelled && setState(err instanceof UnauthorizedError ? "needsToken" : "unreachable"));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = (): void => {
    setState("checking");
    setAttempt((a) => a + 1);
  };

  const submit = (): void => {
    if (!value.trim()) return;
    setToken(value.trim());
    setTried(true);
    retry();
  };

  if (state === "ready") return <>{children}</>;

  if (state === "checking") return <div className={styles.center}>Connecting…</div>;

  if (state === "unreachable") {
    return (
      <div className={styles.center}>
        <div className={styles.card}>
          <h1 className={styles.title}>Backend unreachable</h1>
          <p className={styles.body}>
            Start it with <code>npm run dashboard</code>, then try again.
          </p>
          <button className={styles.button} onClick={retry} type="button">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.center}>
      <div className={styles.card}>
        <h1 className={styles.title}>Dashboard token</h1>
        <p className={styles.body}>
          This server is bound beyond localhost, so it requires the <code>DASHBOARD_TOKEN</code> from your{" "}
          <code>.env</code>.
        </p>
        <input
          autoFocus
          className={styles.input}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Paste the token"
          type="password"
          value={value}
        />
        {tried && <p className={styles.error}>That token was not accepted.</p>}
        <button className={styles.button} disabled={!value.trim()} onClick={submit} type="button">
          Connect
        </button>
      </div>
    </div>
  );
};

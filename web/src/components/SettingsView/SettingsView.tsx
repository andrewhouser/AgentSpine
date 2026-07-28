import { useEffect, useState } from "react";

import type { Memory } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./SettingsView.module.css";

export const SettingsView = () => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [policy, setPolicy] = useState<null | Record<string, unknown>>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void api.policy().then(setPolicy);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void api.listMemories(query || undefined).then(setMemories), 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className={styles.page}>
      <PageHeader title="Settings" />

      <section>
        <h2 className={styles.subhead}>Memory</h2>
        <p className={styles.note}>
          What it has learned about you. <code>reflection</code> memories are written automatically after
          each run; <code>preference</code> memories come from rejections you explained. Standing facts you
          want it to always know belong in <code>profile.md</code>, which nothing automated writes to.
        </p>
        <input
          className={styles.search}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          value={query}
        />
        {memories.length === 0 && <div className={styles.empty}>No memories{query ? " match" : " yet"}.</div>}
        {memories.map((m) => (
          <div className={styles.memory} key={m.id}>
            <span className={styles.kind}>{m.kind}</span>
            <span className={styles.text}>{m.text}</span>
            <span className={styles.when}>{new Date(m.ts).toLocaleDateString()}</span>
          </div>
        ))}
      </section>

      <section>
        <h2 className={styles.subhead}>Policy</h2>
        <p className={styles.note}>
          The security boundary — deny by default. Read-only here on purpose: this is the file that decides
          what the assistant may touch, so it is edited in <code>policy.json</code> on disk, not through a
          web form the agent's own API could reach. Changes take effect on the next run, no restart.
        </p>
        <pre className={styles.policy}>{policy ? JSON.stringify(policy, null, 2) : "Loading…"}</pre>
      </section>
    </div>
  );
};

import { useEffect, useState } from "react";

import type { ThemeChoice } from "../../lib/preferences.ts";
import type { Memory } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import {
  readPreferences,
  savePreferences,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
} from "../../lib/preferences.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./SettingsView.module.css";

const THEMES: { label: string; value: ThemeChoice }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export const SettingsView = () => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [policy, setPolicy] = useState<null | Record<string, unknown>>(null);
  const [query, setQuery] = useState("");
  // Read once, on mount. These live in localStorage rather than on the server because they
  // describe the screen you are reading on, not the assistant — see lib/preferences.ts.
  const [prefs, setPrefs] = useState(readPreferences);

  // Applied on every change rather than behind a Save button. There is nothing to validate
  // and nothing to fail, and seeing the result *is* the feedback — a preview that needed
  // confirming would just be a slower way to find out you had gone one step too far.
  const update = (next: Partial<typeof prefs>): void => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    savePreferences(merged);
  };

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
        <h2 className={styles.subhead}>Appearance</h2>
        <p className={styles.note}>
          Kept in this browser rather than on the server, because these describe the screen
          you are reading on and not the assistant — the laptop and the monitor across the
          room are allowed different answers.
        </p>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Theme</span>
          <div aria-label="Theme" className={styles.segmented} role="group">
            {THEMES.map((option) => (
              <button
                aria-pressed={prefs.theme === option.value}
                className={`${styles.segment} ${prefs.theme === option.value ? styles.segmentOn : ""}`}
                key={option.value}
                onClick={() => update({ theme: option.value })}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className={styles.fieldHint}>
            {prefs.theme === "system"
              ? "Follows macOS, and switches with it while this page is open."
              : `Pinned to ${prefs.theme}, ignoring the system setting.`}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="ui-scale">
            Text size
          </label>
          <div className={styles.sliderRow}>
            <span className={styles.scaleMark}>A</span>
            <input
              className={styles.slider}
              id="ui-scale"
              max={SCALE_MAX}
              min={SCALE_MIN}
              onChange={(e) => update({ scale: Number(e.target.value) })}
              step={SCALE_STEP}
              type="range"
              value={prefs.scale}
            />
            <span className={styles.scaleMarkLarge}>A</span>
            <span className={styles.scaleValue}>{Math.round(prefs.scale * 100)}%</span>
            {prefs.scale !== SCALE_DEFAULT && (
              <button className={styles.reset} onClick={() => update({ scale: SCALE_DEFAULT })} type="button">
                Reset
              </button>
            )}
          </div>
          <span className={styles.fieldHint}>
            Scales text only — spacing and controls stay put, so the layout gets denser rather
            than merely larger. Starts from your browser's own font setting.
          </span>
        </div>
      </section>

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

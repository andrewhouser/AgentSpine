import { useState } from "react";

import type { HeadsupPrefs } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "./HeadsupPrefsPanel.module.css";

const KIND_LABELS: [string, string][] = [
  ["birthday", "Birthdays"],
  ["anniversary", "Anniversaries"],
  ["bill", "Bills"],
  ["appointment", "Appointments"],
  ["flight", "Flights"],
  ["recurring", "Recurring events"],
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const hourLabel = (h: number): string => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

const NONE: HeadsupPrefs | null = null;

/**
 * Settings → Heads-up: which kinds you want, how many per morning, and when it must stay quiet.
 * The 30 minute floor on watches is shown but not editable: it exists to stop a mistake becoming a
 * polling storm against a free API, and a setting you can lower defeats it.
 */
export const HeadsupPrefsPanel = () => {
  const [prefs, refresh] = useResource(api.headsupPrefs, NONE);
  const [error, setError] = useState("");

  if (!prefs) return null;

  const change = async (patch: Record<string, unknown>): Promise<void> => {
    setError("");
    try {
      await api.setHeadsupPrefs(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    refresh();
  };

  return (
    <section>
      <h2 className={styles.subhead}>Heads-up</h2>
      <p className={styles.note}>
        What it may bring up each morning. Turning a kind off stops new offers of that kind; anything you are already
        tracking keeps going.
      </p>

      <div className={styles.kinds}>
        {KIND_LABELS.map(([kind, label]) => (
          <label key={kind}>
            <input checked={prefs.kinds[kind] !== false} onChange={(e) => void change({ kinds: { [kind]: e.target.checked } })} type="checkbox" /> {label}
          </label>
        ))}
      </div>

      {(prefs.learning ?? []).length > 0 && (
        <>
          <div className={styles.note}>
            What happened to them over the last 90 days. A kind you pass on most of the time gets only its first mention,
            and past that it asks whether to turn the kind off. It never turns one off on its own.
          </div>
          <ul className={styles.learning}>
            {KIND_LABELS.filter(([kind]) => prefs.learning?.some((l) => l.kind === kind)).map(([kind, label]) => {
              const l = prefs.learning!.find((x) => x.kind === kind)!;
              const on = prefs.kinds[kind] !== false;
              return (
                <li key={kind}>
                  {label}: offered {l.offered}, you acted on {l.yes}
                  {on && l.tier === "quiet" && ". Reminders are off for this kind."}
                  {on && l.tier === "off" && ". Reminders are off, and it has asked whether to turn the kind off."}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className={styles.row}>
        <span className={styles.label}>At most per morning</span>
        <input
          aria-label="Heads-ups per morning"
          className={styles.input}
          max={10}
          min={1}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 1 && n <= 10) void change({ dailyCap: n });
          }}
          type="number"
          value={prefs.dailyCap}
        />
      </div>

      <div className={styles.row}>
        <span className={styles.label}>Quiet hours</span>
        <select aria-label="Quiet from" className={styles.input} onChange={(e) => void change({ quietStartHour: Number(e.target.value) })} value={prefs.quietStartHour}>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
        <span>to</span>
        <select aria-label="Quiet until" className={styles.input} onChange={(e) => void change({ quietEndHour: Number(e.target.value) })} value={prefs.quietEndHour}>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.note}>
        Only a cancellation, or a long delay on a flight leaving within hours, may break through. Pick the same hour twice for no quiet hours.
      </div>

      <div className={styles.fixed}>Watched flights and drives are checked at most every {prefs.floorMinutes} minutes. That is not adjustable.</div>
      {prefs.unavailable.flights && <div className={styles.warn}>Flight tracking is not set up: {prefs.unavailable.flights}</div>}
      {prefs.unavailable.drive && <div className={styles.warn}>Drive watching is not set up: {prefs.unavailable.drive}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </section>
  );
};

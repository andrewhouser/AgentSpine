import { useState } from "react";

import type { Dial, DialLevel, WouldHave } from "../../lib/dials.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { agreementLine, envLine, levelLabel, lockedHint, lockedLevels } from "../../lib/dials.ts";
import styles from "./DialsPanel.module.css";

const NONE: Dial[] = [];

/**
 * Settings → What it may do: Off, Watch or On per feature (PLAN-open-work section 15, R3).
 *
 * The server decides what each dial may be set to (`.env` is a feature's ceiling and a guard's
 * floor, src/modes.ts); a level it would refuse is shown but disabled, so nothing here looks set
 * when it is not. In Watch, the list is what the feature would have done, from the log it keeps,
 * with a thumbs-down per row. Subjects in that list are other people's text, shown as text only.
 */
export const DialsPanel = () => {
  const [dials, reload] = useResource(api.dials, NONE);
  const [error, setError] = useState<null | string>(null);
  const [open, setOpen] = useState<null | string>(null);
  const [rows, setRows] = useState<WouldHave[]>([]);

  const move = (d: Dial, mode: DialLevel): void => {
    setError(null);
    void api
      .setDial(d.feature, mode)
      .then(reload)
      .catch((err: Error) => setError(err.message));
  };

  const show = (feature: string): void => {
    if (open === feature) {
      setOpen(null);
      return;
    }
    setOpen(feature);
    setRows([]);
    void api.wouldHave(feature).then(setRows);
  };

  const mark = (r: WouldHave): void => {
    void api.thumbsDown(r.feature, r.key, !r.thumbsDown).then(() => {
      setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, thumbsDown: !r.thumbsDown } : x)));
      reload();
    });
  };

  return (
    <section>
      <h2 className={styles.subhead}>What it may do</h2>
      <p className={styles.note}>
        Off does nothing. Watch runs and records what it would have done, and does not do it. On does it. A feature can go
        as high as <code>.env</code> allows; a guard can only be tightened here.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <ul className={styles.list}>
        {dials.map((d) => (
          <li className={styles.row} key={d.feature}>
            <div className={styles.head}>
              <div>
                <span className={styles.label}>{d.label}</span>
                {d.guard && <span className={styles.guard}>guard</span>}
                <div className={styles.hint}>{d.hint}</div>
                <div className={lockedLevels(d).length > 0 ? styles.envLocked : styles.env}>{envLine(d)}</div>
              </div>
              <div aria-label={`${d.label} mode`} className={styles.dial} role="radiogroup">
                {d.levels.map((l) => {
                  const locked = !d.allowed.includes(l);
                  return (
                    <button
                      aria-checked={d.mode === l}
                      aria-description={locked ? lockedHint(d, l) : undefined}
                      className={`${styles.level} ${d.mode === l ? styles.levelOn : ""}`}
                      disabled={locked}
                      key={l}
                      onClick={() => d.mode !== l && move(d, l)}
                      role="radio"
                      title={locked ? lockedHint(d, l) : undefined}
                      type="button"
                    >
                      {locked && (
                        <span aria-hidden="true" className={styles.lock}>
                          🔒︎
                        </span>
                      )}
                      {levelLabel(l)}
                    </button>
                  );
                })}
              </div>
            </div>
            {d.agreement && (
              <button className={styles.watch} onClick={() => show(d.feature)} type="button">
                {agreementLine(d.agreement)} {open === d.feature ? "Hide" : "What it would have done"}
              </button>
            )}
            {open === d.feature && (
              <ul className={styles.would}>
                {rows.length === 0 && <li className={styles.hint}>Nothing recorded yet.</li>}
                {rows.map((r) => (
                  <li key={r.key}>
                    <span>
                      <b>{r.action}</b>: {r.subject}
                      {r.detail && <span className={styles.hint}> ({r.detail})</span>}
                    </span>
                    <span className={styles.when}>{new Date(r.at).toLocaleString()}</span>
                    <button
                      aria-pressed={r.thumbsDown}
                      className={`${styles.thumb} ${r.thumbsDown ? styles.thumbOn : ""}`}
                      onClick={() => mark(r)}
                      title={r.thumbsDown ? "Take back: this was right" : "This was wrong"}
                      type="button"
                    >
                      👎
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};

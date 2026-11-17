import type { Overview } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./OverviewView.module.css";

const day = (iso: null | string): string => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "never");

/**
 * Overview: everything installed, on one page, so you can see what to prune.
 *
 * Read-only and deliberately plain. No live agent view, nothing animating, nothing that
 * refreshes by itself: a dashboard you watch is a way of feeling productive. The useful part
 * is the "Worth a look" list at the top, the stale and broken things, each linked to where you'd
 * fix or delete it. The rest is reference.
 */
export const OverviewView = () => {
  const [o, refresh] = useResource<null | Overview>(api.overview, null);

  if (!o) return <div className={styles.page}>Loading…</div>;

  const used = o.tools.filter((t) => t.uses30d > 0);
  const unused = o.tools.filter((t) => t.uses30d === 0);

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Everything that's set up, and what's gone stale. Read-only: every change happens on the page each item links to."
        title="Overview"
      />

      <section className={styles.flags}>
        <div className={styles.flagsHead}>
          <h2 className={styles.subhead}>Worth a look</h2>
          <button className={styles.refresh} onClick={refresh} type="button">
            Refresh
          </button>
        </div>
        {o.flags.length === 0 ? (
          <p className={styles.clear}>Nothing stale or broken.</p>
        ) : (
          <ul className={styles.flagList}>
            {o.flags.map((f) => (
              <li className={f.severity === "warn" ? styles.warn : styles.info} key={f.text}>
                <a href={f.href}>{f.text}</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.grid}>
        <section className={styles.card}>
          <h2 className={styles.subhead}>Connections</h2>
          <ul className={styles.rows}>
            {o.connectors.map((c) => (
              <li key={c.name}>
                <span className={c.configured ? styles.dotOn : styles.dotOff} />
                <span className={styles.name}>{c.name}</span>
                <span className={styles.detail}>{c.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Memory</h2>
          {o.memory.length === 0 && <p className={styles.empty}>Nothing remembered yet.</p>}
          <ul className={styles.rows}>
            {o.memory.map((m) => (
              <li key={m.kind}>
                <span className={styles.name}>{m.kind}</span>
                <span className={styles.num}>
                  {m.count}
                  {m.cap ? ` / ${m.cap}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <a className={styles.more} href="/settings">
            Read or forget in Settings →
          </a>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Schedules</h2>
          {o.schedules.length === 0 && <p className={styles.empty}>None.</p>}
          <ul className={styles.rows}>
            {o.schedules.map((s) => (
              <li key={s.id}>
                <span className={s.enabled ? styles.dotOn : styles.dotOff} />
                <span className={styles.name}>{s.name}</span>
                <span className={styles.detail}>
                  {s.spec ?? "—"} · last {day(s.last_run)}
                  {s.recent.length > 0 && (
                    <span className={styles.runs}>
                      {s.recent.map((r, i) => (
                        <span className={r === "ok" ? styles.runOk : styles.runBad} key={i} title={r} />
                      ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <a className={styles.more} href="/schedules">
            Schedules →
          </a>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Recipes</h2>
          {o.recipes.length === 0 && <p className={styles.empty}>None saved. Say “save this as a recipe” in a chat.</p>}
          <ul className={styles.rows}>
            {o.recipes.map((r) => (
              <li key={r.name}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.detail}>
                  used {r.uses}× · last {day(r.last_used)}
                </span>
              </li>
            ))}
          </ul>
          <a className={styles.more} href="/settings">
            Edit in Settings →
          </a>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Projects</h2>
          {o.projects.length === 0 && <p className={styles.empty}>None.</p>}
          <ul className={styles.rows}>
            {o.projects.map((p) => (
              <li key={p.id}>
                <span className={p.badSources.length ? styles.dotBad : styles.dotOn} />
                <a className={styles.name} href={`/p/${p.id}`}>
                  {p.name}
                </a>
                <span className={styles.detail}>
                  {p.sources} source{p.sources === 1 ? "" : "s"} · {p.chunks.toLocaleString()} chunks
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Study</h2>
          {o.study.length === 0 && <p className={styles.empty}>No topics.</p>}
          <ul className={styles.rows}>
            {o.study.map((s) => (
              <li key={s.name}>
                <span className={styles.name}>{s.name}</span>
                <span className={styles.detail}>
                  {s.cards} cards · {s.due} due · last {day(s.lastActivity)}
                </span>
              </li>
            ))}
          </ul>
          <a className={styles.more} href="/study">
            Study →
          </a>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Policy</h2>
          <ul className={styles.rows}>
            <li>
              <span className={styles.name}>Irreversible actions</span>
              <span className={styles.detail}>{o.policy.irreversibleAlwaysConfirm ? "always ask" : "may run unasked"}</span>
            </li>
            <li>
              <span className={styles.name}>Dry run</span>
              <span className={styles.detail}>{o.policy.dryRun ? "on (nothing happens)" : "off"}</span>
            </li>
            <li>
              <span className={styles.name}>Web search</span>
              <span className={styles.detail}>{o.policy.webSearch ? "on" : "off"}</span>
            </li>
            <li>
              <span className={styles.name}>Scheduler</span>
              <span className={styles.detail}>{o.policy.schedulesEnabled ? "on" : "off"}</span>
            </li>
            <li>
              <span className={styles.name}>Readable folders</span>
              <span className={styles.detail}>{o.policy.readableDirs.join(", ") || "none"}</span>
            </li>
            <li>
              <span className={styles.name}>Writable folders</span>
              <span className={styles.detail}>{o.policy.writableDirs.join(", ") || "none"}</span>
            </li>
            <li>
              <span className={styles.name}>Pre-approved</span>
              <span className={styles.detail}>
                {o.policy.autoApprove.length ? o.policy.autoApprove.map((a) => `${a.tool} → ${a.target}`).join(", ") : "nothing"}
              </span>
            </li>
            <li>
              <span className={styles.name}>Trusted in chat</span>
              <span className={styles.detail}>
                {[...o.policy.chatAutoTools, ...o.policy.userDirected].join(", ") || "nothing"}
              </span>
            </li>
          </ul>
          <a className={styles.more} href="/settings">
            policy.json in Settings →
          </a>
        </section>

        <section className={styles.card}>
          <h2 className={styles.subhead}>Tools · last 30 days</h2>
          <ul className={styles.rows}>
            {used.map((t) => (
              <li key={t.name}>
                <span className={styles.mono}>{t.name}</span>
                <span className={styles.num}>
                  {t.uses30d}
                  {t.errors7d > 0 && <span className={styles.errors}> · {t.errors7d} errors this week</span>}
                </span>
              </li>
            ))}
          </ul>
          {unused.length > 0 && (
            <details className={styles.unused}>
              <summary>{unused.length} not used</summary>
              <p className={styles.mono}>{unused.map((t) => t.name).join(", ")}</p>
            </details>
          )}
        </section>
      </div>

      <p className={styles.stamp}>As of {new Date(o.generated).toLocaleString()}</p>
    </div>
  );
};

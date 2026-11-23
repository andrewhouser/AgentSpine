import { useEffect, useState } from "react";

import type { BrokerStatus, Thread } from "../../lib/types.ts";

import { api } from "../../lib/api.ts";
import styles from "./ThreadInspector.module.css";

interface ThreadInspectorProps {
  thread: Thread;
}

type Tone = "accent" | "attention" | "faint" | "ok";

const TIER_LABEL: Record<string, string> = { deep: "Cloud", fast: "Fast", standard: "Local" };
const TIER_TONE: Record<string, Tone> = { deep: "attention", fast: "ok", standard: "accent" };
const label = (tier: string): string => TIER_LABEL[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
const tone = (tier: null | string): Tone => (tier ? (TIER_TONE[tier] ?? "faint") : "faint");
const shortModel = (m: string): string => m.replace("mlx-community/", "");
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const num = (n: number): string => n.toLocaleString("en-US");

/** The worst decision among a tool's calls, for the one word beside it. */
const RANK: Record<BrokerStatus, number> = { denied: 3, "dry-run": 1, error: 4, executed: 0, queued: 2 };
const STATUS_LABEL: Record<BrokerStatus, string> = {
  denied: "Denied",
  "dry-run": "Dry run",
  error: "Error",
  executed: "Done",
  queued: "Waiting",
};
const STATUS_TONE: Record<BrokerStatus, Tone> = { denied: "attention", "dry-run": "faint", error: "attention", executed: "ok", queued: "accent" };

/** The server's context lines read "memory: …", "earlier conversation: …", or plain words. Group by prefix. */
const contextGroups = (used: string[]): { items: string[]; title: string }[] => {
  const take = (prefix: string): string[] => used.filter((u) => u.startsWith(prefix)).map((u) => u.slice(prefix.length));
  const rest = used.filter((u) => !u.startsWith("memory: ") && !u.startsWith("earlier conversation: "));
  return [
    { items: take("memory: "), title: "Memories" },
    { items: take("earlier conversation: "), title: "Earlier conversations" },
    { items: rest, title: "Also in view" },
  ].filter((g) => g.items.length > 0);
};

const Card = ({ children, title, trailing }: { children: React.ReactNode; title: string; trailing?: string }) => (
  <section className={styles.card}>
    <div className={styles.cardHead}>
      <h3 className={styles.cardTitle}>{title}</h3>
      {trailing !== undefined && <span className={styles.count}>{trailing}</span>}
    </div>
    {children}
  </section>
);

/**
 * The panel beside a thread: what ran, what it ran on, and what it cost. The same four cards as the Mac app's
 * inspector (MacThreadInspector.swift) plus a Tokens card, drawn from the thread the view already holds, so it makes
 * no request of its own beyond the one-line Cloud status. It describes finished turns; a run in flight appears when
 * it ends and the thread reloads.
 */
export const ThreadInspector = ({ thread }: ThreadInspectorProps) => {
  const [cloud, setCloud] = useState<{ configured: boolean; host: null | string } | null>(null);
  useEffect(() => {
    void api.status().then((s) => setCloud(s.cloud ?? null)).catch(() => undefined);
  }, []);

  const turns = thread.turns;
  const actions = turns.flatMap((t) => t.actions);
  const children = turns.flatMap((t) => t.children);
  const contextTurn = [...turns].reverse().find((t) => (t.contextUsed ?? []).length > 0);
  const pinned = thread.conversation.tier;

  // Turns grouped by the model that answered. A turn recorded before the server kept that falls back to the tier it
  // asked for, and says the model was not recorded.
  const groups: { count: number; key: string; subtitle: string; title: string; tone: Tone }[] = [];
  for (const t of turns) {
    let g: (typeof groups)[number];
    if (t.served) {
      const cloudTurn = t.served.via === "cloud";
      g = {
        count: 1,
        key: `${t.served.via}|${t.served.model}`,
        subtitle: cloudTurn ? ["Cloud", cloud?.host].filter(Boolean).join(" · ") : t.served.tier === "fast" ? "Local · fast tier" : "Local",
        title: shortModel(t.served.model),
        tone: cloudTurn ? "attention" : t.served.tier === "fast" ? "ok" : "accent",
      };
    } else if (t.tier) {
      g = { count: 1, key: `tier|${t.tier}`, subtitle: "model not recorded", title: label(t.tier), tone: tone(t.tier) };
    } else continue;
    const existing = groups.find((x) => x.key === g.key);
    if (existing) existing.count += 1;
    else groups.push(g);
  }

  // A thread pinned to Cloud on a server with no Cloud tier runs locally, and nothing in the thread said so.
  const missed = [...turns].reverse().find((t) => t.tier === "deep" && t.served && !t.served.cloud);
  const notice =
    pinned === "deep" && cloud?.configured === false
      ? "Pinned to Cloud, but this server has no Cloud model configured, so these turns run on the local model."
      : missed?.served
        ? `Cloud was asked for, but the latest such turn ran on ${shortModel(missed.served.model)}.`
        : null;

  // Tokens: the turns' own sums, grouped by model across the thread.
  let tokensIn = 0;
  let tokensOut = 0;
  let calls = 0;
  let unreported = 0;
  let modelMs = 0;
  const byModel = new Map<string, { calls: number; completion: number; model: string; prompt: number; tier: null | string }>();
  for (const t of turns) {
    const u = t.usage;
    if (!u) continue;
    tokensIn += u.promptTokens;
    tokensOut += u.completionTokens;
    calls += u.calls;
    unreported += u.unreported;
    for (const m of u.byModel) {
      modelMs += m.ms;
      const key = `${m.tier ?? ""}|${m.model}`;
      const row = byModel.get(key) ?? { calls: 0, completion: 0, model: m.model, prompt: 0, tier: m.tier };
      row.calls += m.calls;
      row.prompt += m.promptTokens;
      row.completion += m.completionTokens;
      byModel.set(key, row);
    }
  }
  const lastUsage = [...turns].reverse().find((t) => (t.usage?.calls ?? 0) > 0)?.usage;
  // "Effective" because no first-token time is recorded: `ms` is the whole request, prefill included,
  // so on a 22k-token prompt this reads far below the model's 28 tok/s decode speed.
  const modelSeconds = Math.round(modelMs / 1000);
  const modelTime =
    modelSeconds < 60
      ? `${modelSeconds}s`
      : modelSeconds < 3600
        ? `${Math.floor(modelSeconds / 60)}m ${modelSeconds % 60}s`
        : `${Math.floor(modelSeconds / 3600)}h ${Math.floor((modelSeconds % 3600) / 60)}m`;
  const effectiveSpeed = modelMs > 0 ? (tokensOut / (modelMs / 1000)).toFixed(1) : null;

  const byTool = new Map<string, BrokerStatus[]>();
  for (const a of actions) byTool.set(a.tool, [...(byTool.get(a.tool) ?? []), a.decision]);
  const toolSummaries = [...byTool.entries()]
    .map(([tool, decisions]) => ({
      count: decisions.length,
      tool,
      worst: decisions.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "executed" as BrokerStatus),
    }))
    .sort((a, b) => (a.count === b.count ? a.tool.localeCompare(b.tool) : b.count - a.count));
  const most = Math.max(1, ...toolSummaries.map((s) => s.count));

  return (
    <aside aria-label="Thread inspector" className={styles.panel}>
      <Card title="Model">
        <div className={styles.row}>
          <span className={styles.dim}>Pinned to</span>
          <span className={`${styles.chip} ${styles[`tone${cap(pinned ? tone(pinned) : "accent")}`]}`}>{pinned ? label(pinned) : "Auto"}</span>
        </div>
        {notice && <p className={styles.warn}>{notice}</p>}
        {groups.length === 0 ? (
          <p className={styles.empty}>No turns yet</p>
        ) : (
          <>
            <div className={styles.bar}>
              {groups.map((g) => (
                <span className={`${styles.seg} ${styles[`fill${cap(g.tone)}`]}`} key={g.key} style={{ flexGrow: g.count }} />
              ))}
            </div>
            {groups.map((g) => (
              <div className={styles.item} key={g.key}>
                <span className={`${styles.dot} ${styles[`fill${cap(g.tone)}`]}`} />
                <div className={styles.grow}>
                  <div className={styles.mono} title={g.title}>
                    {g.title}
                  </div>
                  <div className={styles.faint}>{g.subtitle}</div>
                </div>
                <span className={styles.dim}>
                  {g.count} turn{g.count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </>
        )}
      </Card>

      <Card title="Tokens" trailing={calls ? `${num(calls)} call${calls === 1 ? "" : "s"}` : undefined}>
        {calls === 0 ? (
          <p className={styles.empty}>Not recorded for these turns</p>
        ) : (
          <>
            <div className={styles.totals}>
              <div>
                <div className={styles.big}>{num(tokensIn)}</div>
                <div className={styles.faint}>in</div>
              </div>
              <div>
                <div className={styles.big}>{num(tokensOut)}</div>
                <div className={styles.faint}>out</div>
              </div>
            </div>
            {lastUsage && (
              <p className={styles.faint}>
                Latest turn: {num(lastUsage.promptTokens)} in, {num(lastUsage.completionTokens)} out
              </p>
            )}
            {effectiveSpeed && (
              <p className={styles.faint} title="Output tokens divided by total model time, including prompt processing">
                Effective: {effectiveSpeed} tok/s · {modelTime} model time
              </p>
            )}
            {[...byModel.values()].map((m) => (
              <div className={styles.item} key={`${m.tier}|${m.model}`}>
                <div className={styles.grow}>
                  <div className={styles.mono} title={m.model}>
                    {shortModel(m.model)}
                  </div>
                  <div className={styles.faint}>
                    {m.tier ? label(m.tier) : "tier not recorded"} · {m.calls} call{m.calls === 1 ? "" : "s"}
                  </div>
                </div>
                <span className={styles.dim}>
                  {num(m.prompt)} / {num(m.completion)}
                </span>
              </div>
            ))}
            {unreported > 0 && (
              <p className={styles.faint}>
                {unreported} call{unreported === 1 ? "" : "s"} reported no usage, so the totals are a floor.
              </p>
            )}
          </>
        )}
      </Card>

      {contextTurn?.contextUsed && (
        <Card title="Context" trailing={String(contextTurn.contextUsed.length)}>
          <p className={styles.faint}>What the latest turn had in front of it</p>
          {contextGroups(contextTurn.contextUsed).map((g) => (
            <details key={g.title}>
              <summary className={styles.summary}>
                <span>{g.title}</span>
                <span className={styles.faint}>{g.items.length}</span>
              </summary>
              <ul className={styles.list}>
                {g.items.map((item, i) => (
                  <li key={`${i}-${item}`} title={item}>
                    {item}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </Card>
      )}

      <Card title="Tool calls" trailing={String(actions.length)}>
        {toolSummaries.length === 0 && <p className={styles.empty}>None yet</p>}
        {toolSummaries.map((s) => (
          <div className={styles.tool} key={s.tool}>
            <div className={styles.row}>
              <span className={styles.mono}>{s.tool}</span>
              <span className={`${styles.small} ${styles[`text${cap(STATUS_TONE[s.worst])}`]}`}>{STATUS_LABEL[s.worst]}</span>
              <span className={styles.dim}>{s.count}</span>
            </div>
            <div className={`${styles.toolBar} ${styles[`fill${cap(STATUS_TONE[s.worst])}`]}`} style={{ width: `${Math.max(3, (100 * s.count) / most)}%` }} />
          </div>
        ))}
      </Card>

      <Card title="Child runs" trailing={String(children.length)}>
        {children.length === 0 && <p className={styles.empty}>This thread has not handed anything to another agent.</p>}
        {children.map((c) => (
          <div className={styles.item} key={c.id}>
            <div className={styles.grow}>
              <div className={styles.row}>
                <strong>{c.agent ?? "agent"}</strong>
                {c.tier && <span className={`${styles.chip} ${styles[`tone${cap(tone(c.tier))}`]}`}>{label(c.tier)}</span>}
              </div>
              {c.task && <div className={styles.dim}>{c.task}</div>}
              <div className={styles.faint}>
                {c.status} · {c.actions.length} tool call{c.actions.length === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        ))}
      </Card>
    </aside>
  );
};

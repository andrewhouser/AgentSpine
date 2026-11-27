import { useState } from "react";

import type { CheckinPreview, CheckinSource, CheckinStatus } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import {
  checkinBucketLine,
  checkinGroups,
  checkinMailOrder,
  checkinMessageId,
  checkinModeLine,
  checkinOffKinds,
  checkinOffLine,
  checkinRunLabel,
  checkinRunNote,
  checkinSendLine,
  checkinSortLine,
} from "../../lib/checkin.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import own from "./CheckinView.module.css";

const NO_STATUS: CheckinStatus | null = null;
const NO_PREVIEW: CheckinPreview | null = null;

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * What needs you right now, and what the check-in has said about it.
 *
 * The list is the preview: it reads mail, calendar, tasks, approvals and Heads-up and writes
 * nothing, so opening this page never marks anything as seen and works with the check-in
 * switched off. "Check now" is the real thing: it records, and in push mode it sends.
 *
 * Subjects are shown here whatever the push is set to say. That setting is about what leaves
 * the machine in a notification; this page is yours.
 */
/** The sources in the order the screen lists them, with the words it uses. */
const SOURCE_LABELS: [CheckinSource, string][] = [
  ["mail", "Mail from people"],
  ["calendar", "Calendar"],
  ["task", "Tasks"],
  ["approval", "Approvals"],
  ["headsup", "Heads-up"],
];

export const CheckinView = ({ embedded = false }: { embedded?: boolean }) => {
  const [status, refreshStatus] = useResource(() => api.checkinStatus().catch(() => NO_STATUS), NO_STATUS);
  const [error, setError] = useState("");
  const [preview, refreshPreview] = useResource(
    () =>
      api.previewCheckin().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        return NO_PREVIEW;
      }),
    NO_PREVIEW,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const checkNow = async (): Promise<void> => {
    setBusy(true);
    setNote("");
    setError("");
    try {
      setNote(checkinRunNote(await api.runCheckin()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refreshStatus();
      refreshPreview();
    }
  };

  // Each source on or off (D1). Off means it is not read at all, by the check-in or by this preview.
  const toggleSource = async (kind: CheckinSource, on: boolean): Promise<void> => {
    setError("");
    try {
      await api.setCheckinSources({ [kind]: on });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      refreshStatus();
      refreshPreview();
    }
  };

  /**
   * "Draft a reply" on one mail. The server writes it with the local model from the sender,
   * subject and Gmail's preview, and queues it like any draft: it is read and approved in the
   * AgentSpine thread, and nothing is sent from here.
   */
  const [drafting, setDrafting] = useState("");
  const draftReply = async (key: string): Promise<void> => {
    setDrafting(key);
    setNote("");
    setError("");
    try {
      setNote((await api.draftCheckinReply(checkinMessageId(key))).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDrafting("");
      refreshPreview();
    }
  };

  const sorting = status?.sortMode === "on";
  const sortLine = checkinSortLine(status?.sortMode);
  const groups = checkinGroups(preview?.items ?? []).map((g) => (g.kind === "mail" ? { ...g, items: checkinMailOrder(g.items, preview?.buckets) } : g));
  const off = status?.mode === "off";
  const offLine = checkinOffLine(checkinOffKinds(status?.sources));

  return (
    <div className={embedded ? undefined : styles.page}>
      <PageHeader
        compact={embedded}
        subtitle="New mail from people, and what else is waiting: approvals, the next few hours, tasks due, open heads-ups. You get one notification when there is new mail; the rest rides along."
        title="Check-in"
      />

      <div className={styles.toolbar}>
        <button
          className={`${styles.button} ${styles.primary}`}
          disabled={busy || off}
          onClick={() => void checkNow()}
          title={off ? "Switched off: there is nothing to run. The list below still reads." : "Runs a real check now. It records, and sends if the check-in is on."}
          type="button"
        >
          {busy ? "Checking…" : "Check now"}
        </button>
        <button
          className={styles.button}
          onClick={() => {
            setError("");
            refreshPreview();
          }}
          title="Reads again. Nothing is recorded or sent."
          type="button"
        >
          Refresh
        </button>
        {status && <span>{status.lastRun ? `Last check ${when(status.lastRun)}` : "No check has run yet"}</span>}
      </div>

      {status && <div className={styles.snippet}>{checkinModeLine(status.mode, status.intervalHours)}</div>}
      {offLine && <div className={styles.snippet}>{offLine}</div>}
      {sortLine && <div className={styles.snippet}>{sortLine}</div>}
      {note && <div className={styles.snippet}>{note}</div>}
      {error && <div className={styles.error}>{error}</div>}
      {preview && preview.errors.length > 0 && <div className={styles.error}>Couldn&apos;t read everything: {preview.errors.join("; ")}</div>}

      {preview && (
        <>
          <div className={own.section}>If it checked now</div>
          <div className={styles.snippet}>{checkinSendLine({ ...preview, off: checkinOffKinds(status?.sources) })}</div>
          {preview.wouldSend && (
            <div className={own.push}>
              <div className={own.pushTitle}>{preview.title}</div>
              <div className={own.pushBody}>{preview.body}</div>
            </div>
          )}
        </>
      )}

      {preview && groups.length === 0 && <div className={styles.empty}>Nothing is waiting on you.</div>}

      {groups.map((g) => (
        <section key={g.kind}>
          <div className={own.section}>
            {g.label} ({g.items.length})
          </div>
          {g.items.map((i) => (
            <div className={own.row} key={i.key}>
              <span className={own.who}>{i.title}</span>
              <span className={own.detail}>{i.detail}</span>
              {i.kind === "mail" && checkinBucketLine(preview?.buckets?.[i.key]) && (
                <span className={`${own.bucket} ${preview?.buckets?.[i.key]?.bucket === "urgent" ? own.urgent : ""}`}>{checkinBucketLine(preview?.buckets?.[i.key])}</span>
              )}
              {i.fresh && i.triggers && <span className={own.fresh}>new</span>}
              {sorting && i.kind === "mail" && (
                <button
                  className={styles.button}
                  disabled={drafting !== ""}
                  onClick={() => void draftReply(i.key)}
                  title="Writes a reply for you to read and approve. Nothing is sent."
                  type="button"
                >
                  {drafting === i.key ? "Drafting…" : "Draft a reply"}
                </button>
              )}
            </div>
          ))}
        </section>
      ))}

      {status?.sources && (
        <section>
          <div className={own.section}>What a check-in reads</div>
          <div className={own.sources}>
            {SOURCE_LABELS.map(([kind, label]) => (
              <label className={own.source} key={kind}>
                <input
                  checked={status.sources?.[kind] !== false}
                  onChange={(e) => void toggleSource(kind, e.target.checked)}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
        </section>
      )}

      {status && status.runs.length > 0 && (
        <section>
          <div className={own.section}>Past checks</div>
          {status.runs.map((r) => (
            <div className={own.row} key={r.id}>
              <span className={own.when}>{when(r.at)}</span>
              <span className={own.who}>{checkinRunLabel(r)}</span>
              <span className={own.detail}>{r.title || `${r.total} found`}</span>
            </div>
          ))}
        </section>
      )}

    </div>
  );
};

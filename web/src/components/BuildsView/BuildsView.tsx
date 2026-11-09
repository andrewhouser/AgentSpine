import { useState } from "react";

import type { Build, BuildDiff } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: Build[] = [];

/**
 * The verdict, as one scannable word.
 *
 * `ok` is deliberately three-valued. A run that only branched and committed never ran a
 * command, so it has no verdict — and showing that as "failed" would be a lie about the one
 * thing this page exists to tell you at a glance.
 */
const verdict = (b: Build): string => (b.ok === null ? "no command ran" : b.ok ? "passed" : "failed");

const shortRepo = (repo: null | string): string => (repo ? (repo.split("/").pop() ?? repo) : "—");

export const BuildsView = () => {
  const [builds] = useResource(api.listBuilds, NONE);
  const [diff, setDiff] = useState<{ runId: number; value: BuildDiff } | null>(null);
  const [error, setError] = useState("");

  const show = async (b: Build): Promise<void> => {
    if (diff?.runId === b.run_id) return setDiff(null);
    setError("");
    try {
      setDiff({ runId: b.run_id, value: await api.buildDiff(b.run_id) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader
        subtitle="Runs that built or tested something. Each one is a branch you can read as a diff — nothing here is committed to main."
        title="Builds"
      />
      {error && <div className={styles.error}>{error}</div>}
      {builds.length === 0 && (
        <div className={styles.empty}>
          No builds yet. Declare commands for a repo in policy.build, then ask it to change something there.
        </div>
      )}
      {builds.map((b) => (
        <div className={styles.cardStack} key={b.run_id}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <div className={styles.body}>
              <div className={styles.title}>
                {shortRepo(b.repo)} · {verdict(b)}
              </div>
              <div className={styles.meta}>
                {b.branch ?? "no branch"} · run #{b.run_id} · {new Date(b.started).toLocaleString()}
                {b.commits > 0 && ` · ${b.commits} commit${b.commits === 1 ? "" : "s"}`}
                {b.files.length > 0 && ` · ${b.files.length} file${b.files.length === 1 ? "" : "s"} written`}
              </div>
              {b.task && <div className={styles.snippet}>{b.task}</div>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {b.commands.map((c, i) => (
                  <span className={styles.chip} key={`${c.ts}-${i}`} title={c.decision}>
                    {c.name}: {c.verdict}
                  </span>
                ))}
              </div>
            </div>
            {b.branch && (
              <button className={styles.button} onClick={() => void show(b)} type="button">
                {diff?.runId === b.run_id ? "Hide" : "Diff"}
              </button>
            )}
          </div>
          {diff?.runId === b.run_id && (
            <div className={styles.preview}>
              {diff.value.branch
                ? `${diff.value.branch} vs ${diff.value.base}\n\n${diff.value.stat || "(no committed changes)"}\n\n${diff.value.patch}`
                : "This build committed nothing to a branch."}
              {diff.value.uncommitted && `\n\n--- still uncommitted in ${diff.value.repo} ---\n${diff.value.uncommitted}`}
              {diff.value.untracked.length > 0 &&
                `\n\n--- not tracked by git at all (${diff.value.untracked.length}) ---\n${diff.value.untracked.join("\n")}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

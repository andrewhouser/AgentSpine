/**
 * The privacy rail (PLAN-open-work section 15, R10): where a thread or a turn ran, from what the server
 * recorded (runs.private, runs.served, a project, a local-only thread), never from a guess. `PrivacyWords`
 * in Models.swift mirrors these; test/privacy-rail.test.mjs holds them equal.
 */

/** A thread: "Local only" when it can never use the cloud, "Cloud used" once a turn did, else "Local so far". */
export const threadWhere = (t: { local_only?: null | number; project_id: null | number; ran_cloud?: null | number }): string =>
  t.local_only === 1 || t.project_id !== null ? "Local only" : t.ran_cloud === 1 ? "Cloud used" : "Local so far";

/** A turn: "Local" or "Cloud", or "" for a turn recorded before the server kept it. */
export const turnWhere = (served: { cloud: boolean; via: "cloud" | "local" } | null | undefined): string =>
  !served ? "" : served.cloud || served.via === "cloud" ? "Cloud" : "Local";

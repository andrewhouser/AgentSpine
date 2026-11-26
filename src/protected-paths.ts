/**
 * The files that ARE the gates, and the rule that an edit to one is always read by a person
 * (PLAN-open-work section 10, SC6).
 *
 * `policy.json` cannot be written by any tool, so a builder cannot widen its own permissions
 * there. It could still get the same result one step earlier: edit the broker so it stops
 * asking, the pin so private text may leave, the approval code so a card approves itself, or
 * the test that would have caught any of those. Those files are ordinary `.ts` inside a
 * writable folder, so the write was classified reversible and ran unasked.
 *
 * ## Why a list in code and not in policy
 *
 * A protected list in `policy.json` is a list a project overlay, a proposal or a tired edit can
 * shorten. This one is a constant, it names itself, and `test/architecture.test.mjs` fails if an
 * entry is taken out. Changing it is a change to this file, which asks.
 *
 * ## What "protected" means
 *
 * Not refused, as the control files are: changing the broker is real work, and a diff of it is
 * something a person can read. An edit is classified irreversible AND `alwaysConfirm`, so the
 * broker queues it under every one of its skips (`policy.autoApprove`, a user-directed request,
 * a tool trusted in chat, a schedule's pre-approval), with the diff on the card. The write tools
 * check a second time themselves: a protected file is written only while an approval a person
 * gave is being carried out (`runApproved`), so a broker that forgot to ask still writes nothing.
 *
 * Only the files in THIS checkout are protected: the one the running service loaded its own
 * code from. A second clone of the same repo elsewhere is just source, reviewed as a diff
 * before anyone merges it.
 *
 * ## The other ways a file can change
 *
 *   - `move_file`: either end being protected asks, as either end being a manifest does.
 *   - `run_command` and `scaffold_ios_app` start a process that writes what it likes. They run
 *     inside `keepingProtected`, which puts back any protected file the process changed and
 *     says so. A declared `lint --fix` that reformats the broker is still an unread change.
 *   - `git_write` writes no content of its own. `switch`, `stash` and `restore` swap a file for
 *     a version git already holds, and those ask when a protected file would change
 *     (`gitTouchesProtected`). `commit` and `add` do not touch the working tree.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BASE } from "./config.ts";
import { real, realForWrite } from "./fs-scope.ts";
import * as store from "./memory/store.ts";
import type { ClassifiedAction } from "./types.ts";

/**
 * Repo-relative, forward slashes, sorted. The first five are the ones SC6 named: the broker,
 * the local-only pin, the approval code, the one writer of `policy.json`, and the test that
 * pins all of this. The Google and Instagram entries hold the two write tokens and the only
 * functions that use them. The last is this file.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "src/broker.ts",
  "src/confirmations.ts",
  "src/google/write.ts",
  "src/instagram/api.ts",
  "src/instagram/token.ts",
  "src/learn/promote.ts",
  "src/protected-paths.ts",
  "src/sensitivity.ts",
  "test/architecture.test.mjs",
];

/**
 * Files that are trusted prompt text and that no tool may write at all (see `isControlFile` in
 * tools/write-file.ts). They are named here only so a child process cannot change them either:
 * `keepingProtected` puts them back with the rest.
 */
const KEPT_PATHS: readonly string[] = [...PROTECTED_PATHS, "src/area-map.md"];

/** macOS volumes ignore case by default, so `src/Broker.ts` is the broker. Compared folded. */
const fold = (p: string): string => p.normalize("NFC").toLowerCase();

const root = (): string => real(BASE);

/** The protected file a path names, as its repo-relative name, or null. Symlinks are resolved first. */
export const protectedRel = (target: string): null | string => {
  if (!target) return null;
  const t = fold(realForWrite(target));
  const base = root();
  for (const rel of PROTECTED_PATHS) {
    if (t === fold(path.join(base, ...rel.split("/")))) return rel;
  }
  return null;
};

export const isProtectedPath = (target: string): boolean => protectedRel(target) !== null;

/**
 * Mark a classification as one that asks every time. Written as a cast so a tool can say it
 * in one place; the broker reads `alwaysConfirm` and applies none of its four skips.
 */
export const asksEveryTime = (c: ClassifiedAction): ClassifiedAction => ({ ...c, alwaysConfirm: true }) as ClassifiedAction;

// --- carrying out an approval ---------------------------------------------------------------

/** What the approval being carried out was of: the row a person answered, and the card they read. */
export interface Approval {
  id: number;
  summary: string;
}

const approvals = new AsyncLocalStorage<Approval>();

/**
 * Run `fn` as the carrying out of one approved confirmation. Called by `approveOnly` in
 * confirmations.ts and by nothing else, which is the point: a tool that asks `currentApproval()`
 * learns whether a person said yes to THIS call, from the code that took the click, and not from
 * an argument the model could set or a context field a caller could forget.
 */
export const runApproved = <T>(approval: Approval, fn: () => Promise<T>): Promise<T> => approvals.run(approval, fn);

export const currentApproval = (): Approval | undefined => approvals.getStore();

// --- the card -------------------------------------------------------------------------------

/** A short name for one version of a file, so a card can say which text its diff was made against. */
export const versionOf = (text: null | string): string =>
  text == null ? "absent" : createHash("sha256").update(text).digest("hex").slice(0, 12);

const VERSION_LINE = /\(file version when proposed: ([0-9a-f]{12}|absent)\)/;

/** The version a card was written against, read back from the card. Null when it names none. */
export const versionInSummary = (summary: string): null | string => VERSION_LINE.exec(summary)?.[1] ?? null;

/** Numbers for the diff on a card. A card is read on a phone, so it shows the change and little else. */
export const DIFF_LIMITS = {
  /** Unchanged lines kept on each side of a change. */
  context: 2,
  /** Above this many line pairs the exact comparison is skipped for a cheaper one. */
  maxCells: 4_000_000,
  /** Lines of diff on one card. The rest is counted, not shown. */
  maxLines: 160,
} as const;

/**
 * The changed lines between two texts, with a little context: "- " removed, "+ " added.
 *
 * A longest-common-subsequence, because the simpler set comparison used for schedule text
 * (`diffLines` in learn/rewrite.ts) shows nothing when a line that already exists elsewhere in
 * the file is added a second time, and in a broker that line could be `return true;`.
 */
export const changedLines = (before: string, after: string): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  type Op = { line: string; op: " " | "+" | "-" };
  const ops: Op[] = [];

  // Trim what both ends share, so the table below covers only the part that differs.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);

  for (const line of a.slice(0, head)) ops.push({ line, op: " " });
  if (am.length * bm.length > DIFF_LIMITS.maxCells) {
    // Too large to compare exactly. Everything in the middle is shown as replaced, which is
    // longer than it need be and never hides a line.
    for (const line of am) ops.push({ line, op: "-" });
    for (const line of bm) ops.push({ line, op: "+" });
  } else {
    const w = bm.length + 1;
    const table = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        table[i * w + j] = am[i] === bm[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        ops.push({ line: am[i], op: " " });
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        ops.push({ line: am[i++], op: "-" });
      } else {
        ops.push({ line: bm[j++], op: "+" });
      }
    }
    while (i < am.length) ops.push({ line: am[i++], op: "-" });
    while (j < bm.length) ops.push({ line: bm[j++], op: "+" });
  }
  for (const line of a.slice(a.length - tail)) ops.push({ line, op: " " });

  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, at) => {
    if (o.op === " ") return;
    for (let k = Math.max(0, at - DIFF_LIMITS.context); k <= Math.min(ops.length - 1, at + DIFF_LIMITS.context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let shown = 0;
  let hidden = 0;
  let gap = false;
  ops.forEach((o, at) => {
    if (!keep[at]) {
      gap = true;
      return;
    }
    if (shown >= DIFF_LIMITS.maxLines) {
      if (o.op !== " ") hidden++;
      return;
    }
    if (gap && out.length) out.push("  ...");
    gap = false;
    out.push(`${o.op} ${o.line}`);
    shown++;
  });
  if (hidden) out.push(`  ... and ${hidden} more changed line(s) not shown. Read the whole file before approving.`);
  return out.length ? out.join("\n") : "(no lines differ)";
};

/** The file as it is now, or null when it does not exist or cannot be read as text. */
export const readCurrent = (target: string): null | string => {
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
};

/**
 * The card for an edit to a protected file: which gate it is, the diff, and the version the
 * diff was made against. `after` null means the edit could not be worked out (the text to
 * replace is not in the file), which the card says so that nobody approves a blank.
 */
export const protectedSummary = (rel: string, verb: string, before: null | string, after: null | string): string =>
  [
    `${verb} PROTECTED FILE ${rel}. This file is one of AgentSpine's own gates, so the change waits for you whatever else is trusted.`,
    "It takes effect the next time the service restarts from this checkout.",
    "",
    "(- removed, + added, a few unchanged lines around each change)",
    "",
    after == null ? "(the change could not be worked out from the arguments, so approving it will fail)" : changedLines(before ?? "", after),
    "",
    `(file version when proposed: ${versionOf(before)})`,
  ].join("\n");

/**
 * Whether a protected write may go ahead right now: only while an approval is being carried
 * out, and only if the file is still the text the card's diff was made against. Returns the
 * reason it may not, or null. A stale card would otherwise replace a fix made since with the
 * text someone approved before it existed.
 */
export const protectedWriteProblem = (target: string): null | string => {
  const rel = protectedRel(target);
  if (!rel) return null;
  const approval = currentApproval();
  if (!approval) {
    return `${rel} is one of AgentSpine's own gates. A change to it is written only when the user approves its card, and this call was not approved.`;
  }
  const asked = versionInSummary(approval.summary);
  const now = versionOf(readCurrent(target));
  if (asked && asked !== now) {
    return `${rel} has changed since this was proposed (it was ${asked}, it is now ${now}), so the diff that was approved is not the change this would make. Propose it again.`;
  }
  return null;
};

// --- processes and git ----------------------------------------------------------------------

/**
 * Run something that may write anywhere (a declared command, a project generator) and put
 * back any protected file it changed, created or removed. Returns what `fn` returned and a
 * line per file that was put back.
 *
 * The change is not thrown away. Where it is text a write tool could have proposed, it is
 * queued as the `write_file` call that would make it, with the same card and diff an ordinary
 * edit gets, so "an edit to a gate waits for the user" holds for this route too. That also
 * covers the awkward case: the owner editing one of these files by hand while a long test
 * command happens to be running. Their edit is put back with everything else, and it is in
 * the queue, whole, one tap from being applied again.
 *
 * Only for work inside this checkout: a build of some other repo cannot reach these files
 * through `cwd`, and reading ten files around every `cargo test` would be cost for nothing.
 * `fn` running elsewhere is called as is.
 */
export const keepingProtected = async <T>(
  cwd: string,
  fn: () => Promise<T>,
  runId: null | number = null,
): Promise<{ putBack: string[]; value: T }> => {
  const base = root();
  const here = real(cwd);
  if (here !== base && !here.startsWith(base + path.sep) && !base.startsWith(here + path.sep)) return { putBack: [], value: await fn() };

  const files = KEPT_PATHS.map((rel) => ({ abs: path.join(base, ...rel.split("/")), rel }));
  const read = (abs: string): Buffer | null => {
    try {
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  };
  const snapshot = files.map((f) => read(f.abs));
  const restore = (): string[] => {
    const putBack: string[] = [];
    files.forEach((f, at) => {
      const was = snapshot[at];
      const now = read(f.abs);
      if (was == null && now == null) return;
      if (was != null && now != null && was.equals(now)) return;
      try {
        if (was == null) fs.rmSync(f.abs, { force: true });
        else {
          fs.mkdirSync(path.dirname(f.abs), { recursive: true });
          fs.writeFileSync(f.abs, was);
        }
      } catch {
        // Could not be put back. Named all the same, because the caller's report is then the
        // only place a person learns the file is not what it was.
        putBack.push(`${f.rel} (could NOT be put back)`);
        return;
      }
      // Only a protected file can be proposed: the code map is a control file, which no tool
      // call may write even with an approval, and a removal has no tool at all.
      let card: null | number = null;
      if (now != null && PROTECTED_PATHS.includes(f.rel)) {
        try {
          const before = was == null ? null : was.toString("utf8");
          const after = now.toString("utf8");
          card = store.queueConfirmation(
            { args: { content: after, path: f.abs }, tool: "write_file" },
            protectedSummary(f.rel, "CHANGE MADE BY A COMMAND TO", before, after),
            runId,
          );
        } catch {
          card = null;
        }
      }
      putBack.push(card == null ? f.rel : `${f.rel} (the change is waiting for the user's approval as #${card})`);
    });
    return putBack;
  };
  try {
    const value = await fn();
    return { putBack: restore(), value };
  } catch (err) {
    restore();
    throw err;
  }
};

/** What to add to a tool's report when `keepingProtected` put something back. Empty when it did not. */
export const putBackNote = (putBack: string[]): string =>
  putBack.length
    ? `\nPROTECTED FILES PUT BACK: ${putBack.join(", ")}. That step changed them, and a change to one of AgentSpine's own gates ` +
      `takes effect only when the user approves it. Do not make the change again another way.`
    : "";

const gitLines = (repo: string, args: string[]): string[] => {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The protected files a git verb would change in the working tree, for `git_write`'s
 * classification. Read from git, synchronously, as `currentBranch` is: which files differ is a
 * fact about the repo, not a claim in the model's arguments. Empty for another repo, for a verb
 * that does not touch the working tree, and when git cannot say.
 */
export const gitTouchesProtected = (repo: string, verb: string, a: { branch?: unknown; paths?: string[] }): string[] => {
  const base = root();
  if (real(repo) !== base) return [];
  const rels = [...PROTECTED_PATHS];
  if (verb === "switch") {
    const branch = String(a?.branch ?? "");
    // Refused later by checkPolicy if it is not a usable name; never reaches git as a flag here.
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)) return [];
    return gitLines(base, ["diff", "--name-only", "HEAD", branch, "--", ...rels]).filter((f) => rels.includes(f));
  }
  if (verb === "stash") {
    return gitLines(base, ["diff", "--name-only", "HEAD", "--", ...rels]).filter((f) => rels.includes(f));
  }
  if (verb === "restore") {
    // Only a file that has uncommitted changes is changed by discarding them.
    const dirty = gitLines(base, ["diff", "--name-only", "HEAD", "--", ...rels]);
    const named = (a?.paths ?? []).map((p) => real(path.isAbsolute(p) ? p : path.resolve(base, p)));
    return rels.filter((rel) => {
      if (!dirty.includes(rel)) return false;
      const abs = path.join(base, ...rel.split("/"));
      return named.some((n) => fold(abs) === fold(n) || fold(abs).startsWith(fold(n) + path.sep));
    });
  }
  return [];
};

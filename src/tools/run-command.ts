/**
 * run_command — run a command the USER declared, in a repo the user allowlisted, and read
 * what it printed. The missing primitive: until this existed the agent could write code and
 * had no way to find out whether it worked.
 *
 * ## The model never chooses an argv
 *
 * This is the whole security design, and it is `git_status`'s rule generalised — *"the model
 * chooses a repo path, never a git command"*. Here the model chooses a repo and a **name**;
 * `policy.build.repos[repo].commands[name].argv` supplies the array, and that array came
 * from a human editing `policy.json`. There is no string anywhere in this file that the
 * model can influence and that reaches a shell, because there is no shell: `execFile` takes
 * argv as an array, so a filename containing `;` is an argument and nothing else.
 *
 * A general `shell(cmd: string)` tool was the alternative and was rejected in
 * docs/PLAN-build-loop.md: it cannot be allowlisted, cannot be classified honestly, and
 * would make every other gate in broker.ts decorative.
 *
 * ## Why this is REVERSIBLE, which is the decision everything rests on
 *
 * An irreversible classification would queue every invocation for approval, and one feature
 * is thirty invocations. Nobody approves forty cards; they turn the gate off instead, and a
 * gate that gets turned off protects nothing. The same reasoning write-file.ts uses for
 * backups: "an approval nobody reads protects less than a backup that always exists."
 *
 * What EARNS reversible is that the argv is the user's. `cargo test` run twice changes
 * nothing that cannot be re-run. A free-form shell could never claim this, which is exactly
 * why it is not the design. The rails that remain are the ones that suit a loop rather than
 * a decision: the repo allowlist, the name allowlist, a per-command timeout, and
 * `policy.budgets.perRun.tools.run_command`, which is the right instrument for a build loop
 * that stops converging.
 *
 * Honest about the limit: a declared command runs the repo's own code — a `test` script, a
 * `build.rs`, a Makefile rule. Declaring a command for a repo is therefore a statement that
 * you trust that repo's build to run on this machine. That is a per-repo decision, which is
 * why `repos` is a map and not a boolean.
 *
 * ## The environment is an allowlist, not an inheritance
 *
 * The dashboard's own process env holds OPENAI_API_KEY, DASHBOARD_TOKEN, TAVILY_API_KEY and
 * the path to the APNs signing key. A test suite has no business reading any of them, and
 * `npm test` in a repo with a compromised dependency is precisely the thing that would. So
 * the child gets a constructed env: a handful of names it genuinely needs, plus the ones
 * that make build tools print machine-readable output, plus whatever the command's own
 * declaration adds.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { COMMAND_MAX_TIMEOUT_MS, COMMAND_OUTPUT_CHARS, COMMAND_OUTPUT_PASS_CHARS, COMMAND_TIMEOUT_MS } from "../config.ts";
import { expand, real } from "../fs-scope.ts";
import { clip } from "../stash.ts";
import type { BuildRepo, ClassifiedAction, DeclaredCommand, Policy, PolicyDecision, Tool } from "../types.ts";
import { summarise, type CommandResult } from "./command-output.ts";

/** Resolved pairing of a declared repo root with its configuration. */
interface ResolvedRepo {
  conf: BuildRepo;
  /** The DECLARED root, realpath-resolved. Commands run here, never in a subdirectory. */
  root: string;
}

/**
 * Find the declared repo a path belongs to.
 *
 * Containment, not equality, so naming a file inside the repo works — the model has usually
 * just been editing `src/foo.rs` and should not have to restate the root. The longest match
 * wins, so a repo declared inside another repo resolves to the more specific one.
 *
 * The command still runs with `cwd` set to the declared ROOT, never to the path given. A
 * subdirectory would quietly change what `npm test` or `cargo test` means.
 */
export const findRepo = (policy: Policy, target: string): null | ResolvedRepo => {
  const t = real(expand(target || "."));
  let best: null | ResolvedRepo = null;
  for (const [declared, conf] of Object.entries(policy.build?.repos ?? {})) {
    const root = real(expand(declared));
    if (t !== root && !t.startsWith(root + path.sep)) continue;
    if (!best || root.length > best.root.length) best = { conf, root };
  }
  return best;
};

const commandNames = (conf: BuildRepo): string[] => Object.keys(conf.commands ?? {}).sort();

/** Every declared repo and the commands in it — what `commands_list` hands back. */
const describeRepos = (policy: Policy): string => {
  const entries = Object.entries(policy.build?.repos ?? {});
  if (!entries.length) return "No repos are declared in policy.build.repos.";
  return entries
    .map(([declared, conf]) => {
      const names = commandNames(conf);
      const cmds = names.length
        ? names
            .map((n) => {
              const c = conf.commands?.[n];
              const note = c?.description ? ` — ${c.description}` : "";
              return `    ${n}: ${(c?.argv ?? []).join(" ")}${note}`;
            })
            .join("\n")
        : "    (no commands declared)";
      return `  ${declared}${conf.gitWrite ? "  [git_write allowed]" : ""}\n${cmds}`;
    })
    .join("\n");
};

const TIMEOUT_SIGNAL = "SIGTERM";

/**
 * Run one declared command to completion.
 *
 * Resolves rather than rejects on a non-zero exit, because a failing build is the normal
 * case here and not an error: the whole point of the tool is to read the failure. `execFile`
 * hands stdout and stderr back on the error object, so nothing is lost either way.
 */
/**
 * What `runDeclared` saw, which is `CommandResult` plus the one thing the parsers have no use
 * for: whether the process ever started. ENOENT (no such binary) and EACCES (not executable)
 * are configuration facts, not build failures, and they must not be reported as either an
 * exit code or a signal.
 */
interface RawResult extends CommandResult {
  spawnError: null | string;
}

const runDeclared = (cmd: DeclaredCommand, cwd: string, timeoutMs: number): Promise<RawResult> =>
  new Promise((resolve) => {
    const [bin, ...args] = cmd.argv;
    execFile(
      bin,
      args,
      {
        cwd,
        env: childEnv(cmd),
        maxBuffer: 16_000_000,
        timeout: timeoutMs,
        // No `shell` option, by design. Adding one would make every argument a shell string.
        windowsHide: true,
      },
      (err: any, stdout, stderr) => {
        const timedOut = !!err && (err.killed === true || err.signal === TIMEOUT_SIGNAL);
        // A string `code` is errno — the process never ran. A number is an exit status.
        const spawnFailed = !!err && typeof err.code === "string";
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : null) : 0,
          signal: err?.signal ?? null,
          spawnError: spawnFailed ? `${err.code}: ${String(err.message ?? "").split("\n")[0]}` : null,
          stderr: String(stderr ?? ""),
          stdout: String(stdout ?? ""),
          timedOut,
        });
      },
    );
  });

/**
 * The child's environment, built rather than inherited. See the header for why.
 *
 * - PASSTHROUGH: what a toolchain cannot work without. PATH to find `cargo`/`npm`/`xcodebuild`,
 *   HOME because every package manager keeps its cache there, the locale so output is not
 *   mojibake, TMPDIR because the sandbox sets it.
 * - FORCED: machine-readable output. Colour escapes make every parser in command-output.ts
 *   wrong, and a progress spinner writes thousands of lines that all say the same thing.
 * - The command's own `env` is last, because it is the user's declaration and may legitimately
 *   need to override any of the above (RUSTFLAGS, DEVELOPER_DIR, a NODE_ENV).
 */
const PASSTHROUGH = ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "TMPDIR", "USER"];

export const childEnv = (cmd: DeclaredCommand): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const v = process.env[key];
    if (v != null) out[key] = v;
  }
  out.CI = "1";
  out.FORCE_COLOR = "0";
  out.NO_COLOR = "1";
  out.TERM = "dumb";
  for (const [k, v] of Object.entries(cmd.env ?? {})) out[k] = String(v);
  return out;
};

const verdict = (r: CommandResult, timeoutMs: number): string => {
  if (r.timedOut) return `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — killed, so nothing here is a verdict on the code.`;
  if (r.code === 0) return "PASSED (exit 0)";
  if (r.code == null) return `KILLED by ${r.signal ?? "a signal"}`;
  return `FAILED (exit ${r.code})`;
};

export const runCommand: Tool = {
  name: "run_command",
  description:
    "Run one of the commands declared for a repo in policy.build — a test suite, a type " +
    "check, a linter, a build — and read what it printed. You choose the repo and the " +
    "command NAME; you cannot supply a command line. Call commands_list first to see what " +
    "exists. Use it after every edit: a change you have not run is not a result.",
  argsSchema: '{ "repo": string, "name": string }',
  classify: (a): ClassifiedAction => ({
    // Reversible: the argv is the user's, declared in policy, and running it again produces
    // the same effect. See the header for why this classification is the load-bearing one.
    reversibility: "reversible",
    summary: `Run "${a?.name ?? ""}" in ${a?.repo ?? ""}`,
    target: `${expand(a?.repo ?? "")}#${a?.name ?? ""}`,
  }),
  checkPolicy: (policy, a): PolicyDecision => {
    if (!policy.build?.enabled)
      return { allowed: false, reason: "policy.build.enabled is not set — no commands may run (deny by default)." };

    const repoArg = String(a?.repo ?? "");
    const name = String(a?.name ?? "");
    if (!repoArg) return { allowed: false, reason: "no repo given. Call commands_list to see the declared repos." };
    if (!name) return { allowed: false, reason: "no command name given. Call commands_list to see what is declared." };

    const found = findRepo(policy, repoArg);
    if (!found)
      return {
        allowed: false,
        reason:
          `${expand(repoArg)} is not inside any repo declared in policy.build.repos (deny by default). ` +
          `Declared: ${Object.keys(policy.build.repos ?? {}).join(", ") || "(none)"}.`,
      };

    const declared = found.conf.commands?.[name];
    if (!declared)
      return {
        allowed: false,
        reason:
          `"${name}" is not declared for ${found.root}. Available: ${commandNames(found.conf).join(", ") || "(none)"}. ` +
          `A command has to be added to policy.json by hand — you cannot create one.`,
      };
    if (!Array.isArray(declared.argv) || !declared.argv.length || typeof declared.argv[0] !== "string")
      return { allowed: false, reason: `"${name}" in ${found.root} has no usable argv in policy.json.` };

    return { allowed: true, reason: `declared as "${name}" for ${found.root}` };
  },
  run: async (a, ctx) => {
    const found = findRepo(ctx.policy, String(a?.repo ?? ""));
    // checkPolicy has already proved both of these; the guards are here so this function is
    // honest on its own rather than relying on its caller's order of operations.
    if (!found) return "DENIED: no declared repo for that path.";
    const name = String(a?.name ?? "");
    const cmd = found.conf.commands?.[name];
    if (!cmd) return `DENIED: "${name}" is not declared for ${found.root}.`;
    if (!fs.existsSync(found.root)) return `NOT FOUND: ${found.root} does not exist.`;

    const timeoutMs = Math.min(
      COMMAND_MAX_TIMEOUT_MS,
      Math.max(1000, Math.round(Number(cmd.timeoutMs ?? COMMAND_TIMEOUT_MS)) || COMMAND_TIMEOUT_MS),
    );

    const started = Date.now();
    let r: RawResult;
    try {
      r = await runDeclared(cmd, found.root, timeoutMs);
    } catch (err) {
      // A missing binary lands here (ENOENT), which is a configuration fact worth stating
      // plainly rather than as a stack trace: the fix is in policy.json or in PATH.
      return `ERROR: could not run ${cmd.argv[0]} — ${err instanceof Error ? err.message : String(err)}`;
    }
    // Said before anything else, because the fix is in policy.json or in PATH and not in the
    // repo. Reporting it as a failed build would send the loop editing code to fix a typo.
    if (r.spawnError) return `ERROR: could not run ${cmd.argv[0]} — ${r.spawnError}`;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const head = [
      `$ ${cmd.argv.join(" ")}`,
      `in ${found.root} — ${verdict(r, timeoutMs)} in ${seconds}s`,
    ].join("\n");

    const summary = summarise(cmd.parse, r);
    const raw = [r.stdout, r.stderr].filter((s) => s.trim() !== "").join("\n--- stderr ---\n");

    // On a clean pass with nothing to report, the output itself is noise — "PASSED" is the
    // whole answer, and pasting a successful build log into the loop costs context for
    // nothing. The raw text is still available through the ref when there is a lot of it.
    if (r.code === 0 && !summary) {
      return clip(
        { max: COMMAND_OUTPUT_PASS_CHARS, runId: ctx?.runId ?? null, source: `command ${name} in ${found.root}`, tool: "run_command" },
        `${head}\n\n${raw}`,
      );
    }

    const body = [head, summary ? `\n${summary}` : "", raw ? `\n--- output ---\n${raw}` : ""].join("\n");
    // Build output is UNTRUSTED: it carries file contents, dependency names, test fixtures and
    // panic messages, any of which a third party may have written. `clip` tags it.
    return clip(
      { max: COMMAND_OUTPUT_CHARS, runId: ctx?.runId ?? null, source: `command ${name} in ${found.root}`, tool: "run_command" },
      body,
    );
  },
};

/**
 * commands_list — what may be run, and where.
 *
 * A separate tool rather than text in `run_command`'s description because a tool description
 * is a static string built at import time, while `policy.json` is re-read every heartbeat.
 * Describing the declarations in the description would mean describing whatever they were
 * when the process started.
 */
export const commandsList: Tool = {
  name: "commands_list",
  description:
    "List the repos declared in policy.build and the command names available in each. " +
    "Call this before run_command so you name a command that exists.",
  argsSchema: "{}",
  classify: (): ClassifiedAction => ({
    reversibility: "reversible",
    summary: "List declared build commands",
    target: "policy.build",
  }),
  checkPolicy: (policy): PolicyDecision =>
    policy.build?.enabled
      ? { allowed: true, reason: "policy.build.enabled" }
      : { allowed: false, reason: "policy.build.enabled is not set — no commands are declared (deny by default)." },
  // This is the machine's own configuration, not external content, so it is not tagged
  // UNTRUSTED — the user wrote every byte of it.
  run: async (_a, ctx) => describeRepos(ctx.policy),
};

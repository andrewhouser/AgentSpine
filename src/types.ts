/**
 * Shared types. Kept dependency-free so every module can import them.
 */

export type Reversibility = "reversible" | "irreversible";

/** A specific invocation of a tool, classified for the broker. */
export interface ClassifiedAction {
  reversibility: Reversibility;
  /** What the allowlist keys on: an app bundle id, a domain, a path. */
  target: string;
  /** Human-readable one-liner shown in the confirmation queue. */
  summary: string;
  /**
   * Queue this call whatever would otherwise let it through: `autoApprove`, `userDirected`, `trust.chatAutoTools`, a
   * scheduled run's pre-approval, and `irreversibleAlwaysConfirm` being off. Set only with `irreversible`. Today only
   * an edit to a file that enforces the gates sets it (src/protected-paths.ts, SC6, decided 2026-11-25).
   */
  alwaysConfirm?: true;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/**
 * One command `run_command` may invoke, as declared in policy.json.
 *
 * `argv` is the whole point: an array, passed straight to `execFile`, written by a human.
 * The model picks the NAME this sits under and never supplies any part of this object, which
 * is what lets the call be classified reversible — see src/tools/run-command.ts.
 */
export interface DeclaredCommand {
  /** argv[0] is the binary; the rest are arguments. Never a shell string. */
  argv: string[];
  /** Shown to the model beside the name, e.g. "unit tests, ~40s". */
  description?: string;
  /** Extra environment for this command only (RUSTFLAGS, DEVELOPER_DIR). The child's env is otherwise an allowlist, not an inheritance. */
  env?: Record<string, string>;
  /** Which parser in src/tools/command-output.ts reduces the output. Unknown or absent falls back to `generic`. */
  parse?: string;
  /** Wall-clock cap for this command. Defaults to COMMAND_TIMEOUT_MS, capped at COMMAND_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** A repo the agent may work in, and what it may do there. */
export interface BuildRepo {
  /** Whether `git_write` may push this repo to its remote. Absent = denied; a push still queues for approval. */
  allowPush?: boolean;
  /** Runnable commands, keyed by the name the model asks for. */
  commands?: Record<string, DeclaredCommand>;
  /** The branch `git_write switch` may return to, besides the ones it created. Defaults to "main". */
  defaultBranch?: string;
  /** Whether `git_write` may touch this repo at all. Absent = denied; `git_status` is unaffected. */
  gitWrite?: boolean;
}

/** One remote MCP server (Streamable HTTP), as declared in policy.json. */
export interface McpServerPolicy {
  /** Set false to switch one server off without deleting its entry. */
  enabled?: boolean;
  /** Name of the environment variable holding a bearer token. The token itself never lives in policy.json. */
  tokenEnv?: string;
  /**
   * Only these server tool names are exposed. Absent = all of them. Worth setting: every
   * exposed tool's description is part of the prompt, and prefill is the expensive part here.
   */
  tools?: string[];
  url: string;
}

export interface Policy {
  version: number;
  autoExecute: {
    reversible: boolean;
    irreversibleAlwaysConfirm: boolean;
    /**
     * Report what every tool call WOULD do — execute or queue — and do neither. The way
     * to read a new schedule's task before letting it touch anything.
     */
    dryRun?: boolean;
  };
  apps: { allow: string[] };
  web: { searchEnabled: boolean; fetchAllowlist: string[] };
  browser: {
    /**
     * Set only by narrowPolicy, when a project overlay and the global list share no domain. An
     * empty `navigateAllowlist` means "any domain", so "nothing is allowed" cannot be written
     * as an empty list; this says it outright. Both page tools test it before the list.
     */
    denyAll?: boolean;
    enabled: boolean;
    navigateAllowlist: string[];
    /**
     * Hosts the browser never touches, whoever approves (PLAN-open-work section 12 D2). Your bank
     * and broker go here: a button labelled "Continue" passes any word list, a host does not.
     * Matches the host and its subdomains. Navigation to one is denied, and so is a read, type,
     * click or submit on a page that has ended up on one (a redirect, a link). Absent or empty
     * means none, and a project overlay can only add to it.
     */
    neverDomains?: string[];
  };
  google: { enabled: boolean; write?: GoogleWritePolicy };
  fs: { readableDirs: string[]; writableDirs?: string[] };
  /**
   * Optional sections. A policy.json written before these existed simply lacks them, and
   * every gate below treats "absent" as "denied" — an old config can never silently grant
   * a capability that didn't exist when it was written.
   */
  weather?: { enabled: boolean };
  /**
   * Heads-up's time-sensitive watches (docs/archive/PLAN-heads-up.md, Phase 5). Both default to denied.
   *
   * `flights` lets it look up a flight's status with a third-party API, which learns the flight
   * number and date. `travel` lets it ask a routing API how long a drive will take, which learns
   * your home address and where you are going. Those are privacy decisions, so they are yours to
   * make here rather than defaults, the same as `weather`.
   */
  headsup?: { flights?: boolean; travel?: boolean };
  git?: { repoDirs: string[] };
  /**
   * The build loop (docs/archive/PLAN-build-loop.md). Absent = denied, like every other optional
   * surface: `run_command`, `commands_list` and `git_write` are all unreachable without it.
   *
   * `repos` is a map and not a boolean because declaring a command for a repo is a statement
   * that you trust THAT repo's build to run on this machine — a `test` script, a `build.rs`
   * and a Makefile rule are all code, and the declaration is where that is decided. Nothing
   * the model can call can add a repo or a command here.
   */
  build?: { enabled: boolean; repos?: Record<string, BuildRepo> };
  /**
   * Draft-not-send (SPEC §5, preferred path). Enabling this grants NO new OAuth scope —
   * drafts are proposed text reviewed in the confirmation queue, and approving one writes
   * a file. The Google token remains read-only by construction.
   */
  drafts?: { enabled: boolean; dir?: string };
  /**
   * Call caps, counted from the audit log. `default` applies to any tool without its own
   * entry; `tools` overrides per tool. Absent or 0 means no limit — budgets are a rail you
   * opt into, not a default that would surprise you mid-run.
   */
  /**
   * Delegation to units defined in agents/*.md. Denied when absent, like every other
   * optional surface — a policy written before subagents existed cannot silently grant
   * them. A subagent's tools are the intersection of its declaration and its caller's, and
   * every call it makes still passes through this same broker and this same policy.
   */
  subagents?: { enabled: boolean };
  /**
   * The agent's access to AgentSpine's own scheduler — `schedule_list` / `schedule_create` /
   * `schedule_update` / `schedule_delete`. Absent = denied, like every other optional surface.
   *
   * This grants no new capability to a scheduled job: a job runs through this same broker
   * under this same policy, so it can reach exactly what a chat turn can reach. What it
   * changes is *when* — a standing job acts while nobody is watching, and its task text is a
   * prompt the model wrote. So every write is classified irreversible and lands in the
   * confirmation queue with the full task shown, and nothing here can edit policy.json.
   */
  schedules?: { enabled: boolean };
  /**
   * Microphone capture for meeting transcription. Absent = denied, like every other
   * optional surface.
   *
   * `devices` is an allowlist of avfoundation input names, and [] means NO device rather
   * than any device. That inverts the convention `browser.navigateAllowlist` uses, and the
   * inversion is deliberate: an empty allowlist that means "everything" is a reasonable
   * default for reading public web pages and an unreasonable one for a microphone, where
   * the failure mode is recording a room nobody agreed to record.
   *
   * `announce` makes the capture say so out loud when it starts, for a room where the people
   * being recorded would not otherwise know — recording other people is the one capability
   * here whose risk lands on someone who is not the operator. It is off unless set to exactly
   * `true`: a Mac capturing its own operator has nobody to tell, and a line spoken into the
   * room is the wrong default for that, which is the common case.
   *
   * `remoteSources` names clients allowed to send their own captured audio (the Mac app's
   * microphone, POST /api/meetings/remote). Same inversion as `devices`: [] or absent means
   * none, and it needs `enabled` too.
   */
  audio?: { enabled: boolean; devices: string[]; announce?: boolean; remoteSources?: string[] };
  /**
   * Local image generation via the MFLUX service (the `generate_image` tool). Absent =
   * denied, like every other optional surface.
   *
   * The tool is reversible — it writes a PNG into a directory it owns and touches nothing
   * else — so it is not gated for danger. It is gated because the prompt is model-authored
   * and the effect is a file written to disk, and because the render runs a local model
   * that must stay on the app host (an image render on the model host pages the language
   * models out; see docs/IMAGE_GENERATION.md). Whether that capability exists at all is a
   * decision to make here, not a default.
   */
  images?: { enabled: boolean };
  /**
   * Publishing to one Instagram professional account (docs/INSTAGRAM.md). Absent = denied, like
   * every other optional surface.
   *
   * `enabled` switches on the read side: the queue, the dry run, account checks and insights.
   * `publish` is the write switch and it must be exactly `true`: anything else, absent included,
   * is a dry run that reports what would be posted and posts nothing. A public post cannot be
   * taken back from the people who saw it, so the default is the one that does nothing.
   *
   * `account` is the one username this install may post to. A token that turns out to belong to
   * any other account is refused before a container is created. `liveStatusUrl` is the page the
   * runner asks whether the stream is live; without it a "live now" row is held, never guessed.
   *
   * The access token is not here and never will be: it lives 0600 outside the repo, held by
   * src/instagram/token.ts alone.
   */
  instagram?: { account: string; enabled: boolean; liveStatusUrl?: string; publish?: boolean };
  /**
   * MCP servers whose tools the agent may call (docs/MCP.md). Absent = denied, like every
   * other optional surface. The URL and the allowlist live here, written by a human; nothing
   * the model can call edits policy.json, so it cannot add a server.
   */
  mcp?: { enabled: boolean; servers: Record<string, McpServerPolicy> };
  budgets?: {
    perRun?: { default?: number; tools?: Record<string, number> };
    perDay?: { default?: number; tools?: Record<string, number> };
  };
  /**
   * Per-shape auto-approval (LEARNING Phase 2). A list of `{tool, target}` shapes that may
   * auto-execute even though they are irreversible, because the user has approved that exact
   * shape enough times, with no rejections, that queuing it again is friction rather than
   * safety. Absent = none, like every other optional surface: an irreversible action queues
   * unless its shape is listed here.
   *
   * This is deliberately the NARROWEST possible grant — one `(tool, target)` pair, never a
   * whole tool and never a domain — and it is only ever written to `policy.json` by a human
   * clicking a proposal in the dashboard. `src/learn/promote.ts` can *propose* an entry; it
   * cannot add one, and no tool in the registry can reach either the proposal or the write.
   * The narrowing is checked against the tool's own `classify().target`, so it matches the
   * same key the allowlist and the broker already use.
   */
  autoApprove?: { tool: string; target: string }[];
  /**
   * Irreversible actions that run WITHOUT confirmation when the user's own message, in a live
   * chat turn, asked for exactly that action ("email Jeff that…", "remind me at 5 to…").
   * Absent or disabled = everything irreversible confirms, as before.
   *
   * Entries are "<tool>.<action>", e.g. "mac_control.send_mail". The tool decides whether a
   * call was directed (Tool.directed, reading the user's words); this list decides whether
   * that is enough. Unattended runs — schedules, watchers, subagents, approvals executed
   * later — never qualify, because nobody said anything in them.
   */
  userDirected?: { actions: string[]; enabled: boolean };
  /**
   * Tools whose irreversible calls run without confirmation in a LIVE CHAT turn — a person is
   * typing and watching. Never applies to schedules, watchers, heartbeats or subagents, which
   * have nobody to ask but also nobody to blame. Absent means none.
   */
  trust?: { chatAutoTools?: string[] };
}

/**
 * What the broker knows about the run a call is being made from.
 *
 * A few capabilities are appropriate in one setting and noise in another — pushing a
 * notification to someone's phone to answer a question they are typing to you right now
 * being the case that prompted this. Deciding that needs facts the tool cannot see from its
 * arguments, so the loop states them here and the tool's `checkPolicy` gets to act on them
 * in code rather than the prompt merely asking nicely.
 *
 * `goal` is the user's own message, and it is the only statement of intent in the system
 * worth trusting: the model's claim that "the user wanted a push" is a claim by the party
 * being gated. Absent — a subagent, an approval executed later — means the safe reading,
 * which is that nobody is watching and nobody asked.
 */
/**
 * What the Google WRITE token may be used for (docs/SPEC.md section 5, 2026-11-21). Absent means
 * denied, like every other optional section, so an old policy.json can never grant it by omission.
 */
export interface GoogleWritePolicy {
  /** Calendars bill events may be written to, by name. Never created. Default ["Bills"]. */
  calendars?: string[];
  enabled: boolean;
  /** The most Gmail changes one run may make. Default 60. A cleanup that wants more has gone wrong. */
  maxChangesPerRun?: number;
  /**
   * Senders whose mail may be trashed even though you have emailed them, as an address or a domain.
   * The "never touch anyone you have emailed" rule is code, so an exception is a line here, in your
   * file, and not something a model can talk itself into.
   */
  trashOverrideSenders?: string[];
}

/**
 * The two facts about a run that mean the same thing to the tools and to the model (S1). The tool-facing
 * `RunContext` and the model-facing `HarnessContext` (src/harness.ts) both extend it, and both are
 * filled from the run's kind by one pair of functions there, so "chat" and "scheduled" cannot come to
 * mean different things in two type definitions.
 */
export interface RunFacts {
  /** A person is reading this exchange as it happens, i.e. a chat turn. */
  conversational: boolean;
  /**
   * The user set this run up in advance — a schedule (watchers included) or the heartbeat —
   * and creating it was the approval. The broker runs its irreversible calls without asking
   * again; the allowlist, budgets and dry run still apply. Inherited by subagents of such a
   * run. Absent means a person may still be asked.
   */
  preApproved?: boolean;
}

export interface RunContext extends RunFacts {
  /** The user's message for this run, verbatim. */
  goal: string;
  /**
   * For a `preApproved` run, the text the user approved when they set it up: the schedule's
   * task or the heartbeat's goal, verbatim. A subagent gets its root's, unchanged, because its
   * own `goal` is a brief the model wrote. Absent for every other run, and a tool that needs
   * it treats absent as "nothing was approved" (F9, 2026-11-24).
   */
  approvedTask?: string;
  /**
   * The project this run belongs to — the conversation's project, or one a schedule named.
   * Tools that create or file things (tasks) default to it, so work done inside a project
   * stays attributed to that project without the model having to know its numeric id.
   */
  projectId?: null | number;
}

export interface ToolContext {
  policy: Policy;
  run?: RunContext;
  /**
   * The run this call belongs to. A tool needs it only to reach run-scoped storage — today
   * that is the stash behind `read_more`, whose whole security property is that a ref
   * cannot be read outside the run that produced it (see src/stash.ts). Null means there
   * is no such run, and a tool that ignores it behaves exactly as it did before.
   */
  runId?: number | null;
}

/**
 * A tool the agent can call. Every tool is responsible for describing itself to
 * the model, classifying an invocation's risk, and checking it against policy.
 * The broker — not the tool — decides whether to run, queue, or deny.
 */
export interface Tool {
  name: string;
  /** Shown to the model. */
  description: string;
  /** Shown to the model: the shape of `args`. */
  argsSchema: string;
  classify(args: any): ClassifiedAction;
  /**
   * `run` describes the run this call comes from (see RunContext). Optional, and absent
   * means the cautious reading — a tool that ignores it behaves exactly as it always did,
   * which is why adding the parameter changed no other tool in the registry.
   */
  checkPolicy(policy: Policy, args: any, run?: RunContext): PolicyDecision;
  /**
   * Whether this tool can be used AT ALL under `policy`, whatever the arguments: the switch and
   * allowlist part of `checkPolicy`, pulled out so the capability summary in the harness envelope
   * asks the tool instead of re-reading the same policy fields (which drifted once: the summary
   * treated an absent `schedules.enabled` as on while the tool's gate treated it as off). A tool
   * that defines it calls it first from its own `checkPolicy`, so there is one owner. Advice to
   * the planner only; the broker still decides every call.
   */
  available?(policy: Policy): PolicyDecision;
  /**
   * The third tier, "refused, whoever approves" (D2). Returns the reason when this call must
   * not happen at all, or null. Checked in the broker right after the allowlist and before every
   * way of skipping the queue: `policy.autoApprove`, `userDirected`, `trust.chatAutoTools` and a
   * scheduled run's pre-approval cannot reach it, and nothing is queued, so there is nothing
   * to approve. Recorded and shown as an ordinary denial. Plain code over the arguments; a
   * function that throws refuses the call, because a bug there must not open a way through.
   */
  refuse?(args: any, run?: RunContext, policy?: Policy): null | string;
  /**
   * The argument strings of a call that leave the machine: a message body, a notification, a
   * search query. The broker scans them for card numbers, Social Security numbers and secrets
   * (src/outgoing.ts) and records what it finds; with `OUTGOING_ENFORCE` on it refuses the call.
   * Declare only text that goes out, as `privateOutput` declares only what comes back.
   */
  outgoingText?(args: any): string[];
  /**
   * Whether the user's own message, in a live chat turn, asked for exactly this call — and
   * if so, which named action it is and why. Optional; a tool without it never skips
   * confirmation this way. Read only off `run.goal`, never off the model's arguments alone,
   * because the model is the party being gated. The broker acts on it only when the action
   * is also listed in `policy.userDirected.actions` — see Policy.userDirected.
   */
  directed?(args: any, run: RunContext): null | { action: string; reason: string };
  /**
   * Irreversible calls to this tool still queue when the run is `preApproved` (a schedule,
   * watcher or heartbeat). Pre-approval exists so scheduled jobs don't stall on questions about
   * the work they were set up to do. It must not let an unattended run write the instructions
   * that future unattended runs follow, since a job that reads a hostile page could otherwise
   * schedule itself more jobs. Set it on tools that edit AgentSpine's own standing work, the
   * schedule writes. It doesn't loosen anything: without it, a call is treated as before.
   *
   * `true` is every irreversible call; a function decides per call, for a tool where only some
   * calls must ask. Two tools need it (F8 and F9, 2026-11-24). The browser reads the arguments:
   * a scheduled job may submit a search form unasked, but not click "Place order". `mac_control`
   * also reads `run.approvedTask`: a send asks unless the job's own text names the recipient.
   * The function is plain code, and one that throws counts as "ask".
   */
  confirmWhenUnattended?: boolean | ((args: any, run?: RunContext) => boolean);
  /**
   * What this tool returns must never reach the cloud tier: meeting transcripts and
   * summaries, study material drawn from a project's documents. `true` is every call; a
   * function decides per call from the arguments and the project the run is inside.
   * Once such a call has run, the agent loop pins the rest of that run, and any subagent it
   * starts, to `sensitivity: "private"` (see src/sensitivity.ts), because the output now
   * sits in the message history that the next model request carries.
   */
  privateOutput?: boolean | ((args: any, ctx: { projectId: null | number }) => boolean);
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolCall {
  tool: string;
  args: any;
}

export type BrokerStatus = "executed" | "queued" | "denied" | "error" | "dry-run";

export interface BrokerResult {
  /** The confirmation id, when the call was queued for approval. */
  confirmationId?: number;
  status: BrokerStatus;
  /** What the agent sees as the tool's output. */
  output: string;
}

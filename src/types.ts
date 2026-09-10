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
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
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
  browser: { enabled: boolean; navigateAllowlist: string[] };
  google: { enabled: boolean };
  fs: { readableDirs: string[] };
  /**
   * Optional sections. A policy.json written before these existed simply lacks them, and
   * every gate below treats "absent" as "denied" — an old config can never silently grant
   * a capability that didn't exist when it was written.
   */
  weather?: { enabled: boolean };
  git?: { repoDirs: string[] };
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
   * `announce` makes the capture say so out loud when it starts. Recording other people is
   * the one capability here whose risk lands on someone who is not the operator, and they
   * cannot object to something they do not know is happening.
   */
  audio?: { enabled: boolean; devices: string[]; announce?: boolean };
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
export interface RunContext {
  /** A person is reading this exchange as it happens, i.e. a chat turn. */
  conversational: boolean;
  /** The user's message for this run, verbatim. */
  goal: string;
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
  run(args: any, ctx: ToolContext): Promise<string>;
}

export interface ToolCall {
  tool: string;
  args: any;
}

export type BrokerStatus = "executed" | "queued" | "denied" | "error" | "dry-run";

export interface BrokerResult {
  status: BrokerStatus;
  /** What the agent sees as the tool's output. */
  output: string;
}

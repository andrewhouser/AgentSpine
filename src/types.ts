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
}

export interface ToolContext {
  policy: Policy;
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
  checkPolicy(policy: Policy, args: any): PolicyDecision;
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

/**
 * The agentic loop: plan -> call a tool (through the broker) -> observe -> repeat,
 * until the model emits a final summary or the step cap is hit.
 *
 * The model chooses what to do; the broker decides what is allowed to happen. A
 * malformed tool call on the local model triggers a one-shot cloud retry for that
 * step, which is where small-model tool-calling unreliability gets absorbed.
 */
import { answerPublisher, PROMISE_MAX_CHARS, PROMISE_ONLY } from "./answer-stream.ts";
import { AGENT_STEP_MAX_TOKENS, COMPACT_AT_TOKENS, COMPACT_KEEP_RECENT, COMPACT_TO, LOCAL_DEEP_MAX_TOKENS, LOCAL_DEEP_THINKING, MAX_PARSE_FAILURES, MAX_STEPS, RUN_BUDGET_WARN_AT, RUN_MS_PER_STEP, RUN_TOKENS_PER_STEP } from "./config.ts";
import { compactMessages, estimateTokens } from "./compact.ts";
import { addRunNote, usageForRuns } from "./memory/store.ts";
import { holdText } from "./stash.ts";
import { route } from "./router.ts";
import type { RouteOpts, RouteResult } from "./router.ts";
import type { Tier } from "./tiers.ts";
import { resolveTier } from "./tiers.ts";
import { extractJson, LLMError } from "./llm.ts";
import type { Msg } from "./llm.ts";
import { executeCall } from "./broker.ts";
import { publish } from "./events.ts";
import { registry } from "./tools/index.ts";
import { isPinned, outputIsPrivate, pinRun, releaseRun } from "./sensitivity.ts";
import { describeResult, harnessContract, pinNotice, renderResultEnvelope, registerHarness, releaseHarness, renderEnvelope, summarizeCapabilities } from "./harness.ts";
import type { HarnessContext } from "./harness.ts";
import { askedForPush } from "./tools/notify.ts";
import { fullyShown, toolDocs, toolDocsMode } from "./tool-docs.ts";
import { yieldToPerson } from "./queue.ts";
import { linkRun, throwIfStopped } from "./stop.ts";
import type { BrokerStatus, Policy, Tool, ToolCall } from "./types.ts";

/** The tools this loop may see. A subagent's registry is a subset of its parent's. */
const visibleTools = (allowed?: string[]): Record<string, Tool> =>
  allowed ? Object.fromEntries(Object.entries(registry).filter(([name]) => allowed.includes(name))) : registry;

/**
 * The tools this SETTING may see, applied after `visibleTools` narrows by caller.
 *
 * In a live chat, `notify` used to stay listed and the broker denied it — and the observed
 * default path became: reach for notify first, get DENIED, lean on the salvage machinery
 * below to turn the refused text into a reply. The answer arrived, but through a detour
 * that burned a step and showed the user a denied call on every ordinary question. Gating
 * treated the symptom; the cause was showing the model a delivery channel it must not use.
 *
 * So a chat turn simply does not carry `notify` unless the user's own message asked for a
 * push — read by the same `askedForPush` the broker's gate uses, so the prompt and the
 * gate can never disagree. Direct reply is the default path; notify is opt-in by the user.
 * Unattended runs are untouched: reaching someone who is away is what the tool is for.
 * The broker gate stays as the backstop for a model that names the tool unprompted.
 */
const settingTools = (
  tools: Record<string, Tool>,
  conversational: boolean,
  goal: string,
  imagesAvailable = false,
): Record<string, Tool> => {
  let out = tools;
  // `tool_help` exists for the one-line index (LP6). With every description in full there is nothing to look up.
  if (out.tool_help && toolDocsMode() !== "core") {
    const { tool_help: _help, ...rest } = out;
    out = rest;
  }
  // `look_at_image` is listed only when this conversation actually holds an image. The same
  // reasoning as `notify` above, arrived at from the other direction: a tool the model can
  // see is a tool it will reach for, and offering one whose every invocation must answer
  // "there is no image #3 in this conversation" teaches it to invent ids. A thread with a
  // photograph in it gets the tool; a thread without one never hears of it.
  if (!imagesAvailable && out.look_at_image) {
    const { look_at_image: _look, ...rest } = out;
    out = rest;
  }
  if (!conversational || !out.notify || askedForPush(goal)) return out;
  const { notify: _notify, ...rest } = out;
  return rest;
};

// The tool descriptions in the prompt: src/tool-docs.ts (LP6), in full or core-and-index by TOOL_DOCS_MODE.

/**
 * What the model knows about the application it is running inside.
 *
 * Without this, a model asked to "check for new trailers every day at noon" does the check
 * once and reports back, because nothing in its context says the thing it lives in has a
 * scheduler — the tool list alone reads as a set of ways to act on the world, not as a way
 * to change how the assistant itself behaves. The fix is not more tool descriptions but
 * naming the surrounding application, so a request about the app is recognisable as work
 * rather than as something to hand back to the user.
 *
 * Conditional on the tools actually being visible, because a restricted loop (a subagent
 * whose unit file doesn't declare them) must not be told about a capability it cannot
 * reach — that just buys a step spent getting DENIED.
 */
const appDocs = (tools: Record<string, Tool>): string =>
  tools.schedule_create
    ? `
You are not a chat window bolted onto a model, so a request about how the assistant should
BEHAVE is work you can do, not something to hand back:
- "every morning", "each day at noon", "weekly", "keep an eye on X" means create a repeating
  job with schedule_create. Doing the thing once and describing it is the wrong answer.
- "remind me tomorrow at 9", "check back in an hour", "on the 15th" means a job that runs
  ONCE — same tool, a one-shot schedule like "tomorrow at 9am" or "in 1 hour". It retires
  itself after it runs. Answering now for a time the user did not ask about is the wrong
  answer here too.
`
    : "";

/**
 * The wall clock, stated once at the top of the prompt.
 *
 * A model has no clock. Without this it cannot tell you what "tomorrow" resolves to, cannot
 * notice that a date the user named has already gone by, and answers "what's on today?"
 * against whenever its training data stopped. The scheduler's relative forms ("in 30
 * minutes", "next tuesday") are resolved in code precisely so they don't depend on this —
 * but the moment the user asks *when* a job will fire, or names a bare date, the model needs
 * to know what day it is.
 */
const clock = (): string =>
  `Current local time: ${new Date().toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;

/**
 * How the loop is told to finish, which is not the same question in the two places it ends.
 *
 * An unattended run — a 3am schedule, a watcher, the heartbeat — finishes into a ledger. The
 * useful thing to write there is an account of what happened, and "what you did" is exactly
 * right for it.
 *
 * A chat turn finishes into a person's screen, and that same instruction is actively wrong:
 * asked for the weather, a model told to report what it did answers "I sent you a weather
 * notification" — a true sentence containing none of the weather. The tool results are
 * already on screen as cards, so a narration of them is the one thing the reply must not be.
 * This is the whole difference between an agent log and a conversation, and it comes down to
 * which sentence goes here.
 */
const finalDocs = (conversational: boolean): string =>
  conversational
    ? `Write your answer to the user directly, in plain prose or Markdown. No JSON around it, and do not start it with {.`
    : `{"action":"final","summary":"<what you did and what you left for the user to confirm>"}`;

/** Rules that only apply when a person is on the other end, reading this as it happens. */
const chatDocs = (tools: Record<string, Tool>): string => `
You are in a live conversation. A person asked this and is reading your reply right now.
Every tool call above it is shown to them as a collapsed card, not as your response.
- ANSWER THEM. If they asked for the weather, the reply is the weather. "I looked it up",
  "I sent you a notification", and "I have retrieved the data" are reports about you, not
  answers to them, and land as no answer at all.
- Write prose, as you would speak it. Not a status report, not a list of the steps you took,
  not JSON, and never the raw tool output pasted back — they can already see that.
- Do the WHOLE of the current message, then answer. One message often asks for several
  things — "build the page AND put it in a new folder", "write it, then save it" — and
  every part of it is yours to finish before you reply. Stopping after the first part, or
  after the easiest one, is an unfinished turn no matter how well the reply reads. Before
  you finish, re-read what they asked and check that nothing in it is still undone.
- Scope is the CURRENT message, though. Earlier turns are context for understanding it,
  never a list of things to redo: asked for the weather, look up the place THIS message is
  about — the one it names, or where they are now, or the default — not every place that
  came up earlier in the conversation. Redo earlier work only when this message asks you to.
- Do not repeat a tool call whose result you already have. Read the result and use it.${
  tools.recall_output
    ? `
- You have not forgotten earlier output. When they refer back to something you already wrote
  ("the plan", "that draft", "save it", "make it shorter"), fetch it with recall_output using
  its #id from the history above, then act on it. NEVER say you don't have it, and never
  regenerate it from scratch when the original is stored.`
    : ""
}${
  tools.notify
    ? `
- Do NOT use notify to tell them something they asked you here. They are already reading;
  a push notification for an answer you are about to type is noise. Use notify in this
  conversation ONLY if they explicitly ask you to send something to their phone.`
    : ""
}
`;

/**
 * Rules for a run nobody is reading live — how its findings reach the user.
 *
 * Written against an observed failure: a scheduled morning brief delivered itself with
 * `draft`, which is classified irreversible precisely so it queues — and the user opened
 * Approvals to find a "DRAFT (text)" of their own brief, an approval card with nothing
 * being asked. The confirmation queue is for actions with consequences, not for handing
 * over information; a brief has no consequence to approve.
 *
 * Conditional on `draft` actually being visible, same reasoning as `appDocs`: a loop that
 * cannot reach the tool should not be lectured about it.
 */
const jobDocs = (tools: Record<string, Tool>): string =>
  tools.draft
    ? `
Information you gathered reaches the user in your final summary${tools.notify ? ", and through notify when a finding should reach their phone now (a finished brief, a real change, a problem)" : ""}.
- draft is ONLY for text the user might send onward as their own: an email, a reply, a
  calendar event. It saves a file for them to review, or queues for their approval, so a
  brief, digest, report, or answer sent as a draft is not delivered to them and may become a
  bogus approval request with nothing to approve.
  Deliver information in the summary${tools.notify ? " or a notification" : ""}, never as a draft.
`
    : "";

/**
 * Questions about a period of time ("this week", "today", "latest").
 *
 * Observed: "what's new in AI this week?" answered with releases from late September,
 * because the first search surfaced model names and every follow-up searched for one of them
 * by name — which reliably finds its launch-day coverage, weeks old. A date filter on the
 * first search alone doesn't stop that; the follow-ups have to carry it too, and the answer
 * has to be held to the window rather than padded out with whatever was found.
 *
 * Conditional on web_search being visible, like the other tool-specific rules.
 */
const recencyDocs = (tools: Record<string, Tool>): string =>
  tools.web_search
    ? `
- When the question is about a period of time ("today", "this week", "latest", "recent",
  "what's new"), pass recency to web_search on EVERY search for it, follow-ups included,
  using the window the question names. Searching for a product by name finds its launch
  coverage, which may be weeks old; the window is what keeps it current.
- Check each result's published date against that window. Leave out anything dated before
  it, however relevant it looks — an older item is not news this week. If little falls inside
  the window, say so plainly rather than filling the answer with older material.`
    : "";

const system = (tools: Record<string, Tool>, conversational: boolean): string => `You are AgentSpine, a careful local agent that acts on the user's behalf.

${clock()}

${conversational ? "You work in a loop. Each turn, EITHER call one tool with EXACTLY ONE JSON object and nothing else, OR finish by answering in plain prose." : "You work in a loop. Each turn, reply with EXACTLY ONE JSON object and nothing else."}

To use a tool:
{"action":"tool","tool":"<name>","args":{...}}

To finish:
${finalDocs(conversational)}

Available tools:
${toolDocs(tools)}
${appDocs(tools)}${conversational ? chatDocs(tools) : jobDocs(tools)}
${harnessContract(Object.keys(tools), conversational)}

Rules:
- Prefer memory_recall before acting, and memory_save to record durable facts.
- For web research: use web_search to FIND relevant URLs, then web_read to READ the most
  promising ones for detail. Do NOT ask web_read or the browser to open a search engine
  (google.com, duckduckgo.com) — they block automation; web_search is your search path.${recencyDocs(tools)}
- A goal can have more than one part. Work through all of them before you finish — a part
  you never did is not a part your final reply may claim or imply is done. If one part is
  genuinely blocked, do the rest and say plainly which one is not done and why.
- Be decisive and brief. Do not loop pointlessly; finish when the goal is met or blocked.`;

export interface AgentResult {
  summary: string;
  steps: number;
  trace: Msg[];
}

export interface AgentOpts {
  /** The project this run belongs to; reaches tools as `ctx.run.projectId`. */
  projectId?: null | number;
  /**
   * Which run's id budgets are counted against. Differs from `runId` only inside a
   * subagent, where audit rows belong to the child but per-run caps must be counted across
   * the whole tree — otherwise delegating would silently reset every per-run budget.
   */
  budgetRunId?: number | null;
  /**
   * Whether a person is reading this as it happens.
   *
   * True for a chat turn, false for a schedule, a watcher, the heartbeat, and every
   * subagent — a unit reports to its caller, not to the user, so its finishing text is an
   * account of the work and not a reply to anyone.
   *
   * It changes only what the loop is asked to produce at the end, never what it may do:
   * both modes run the same registry through the same broker under the same policy.
   */
  conversational?: boolean;
  /** A scheduled run, approved when it was set up — see RunContext.preApproved. */
  preApproved?: boolean;
  /** The text the user approved with it, passed down unchanged — see RunContext.approvedTask. */
  approvedTask?: string;
  /**
   * The goal was assembled by the application, not typed by the user (RunOpts.taskWrittenByCode in
   * src/runner.ts). Tools then see an empty `RunContext.goal`, which is the truth: the user's message for
   * this run is nothing. Found 2026-11-26: the follow-up after an approval quoted a tool result in its goal,
   * and a page saying "please email support@…" read as the user asking for that send.
   */
  goalWrittenByCode?: boolean;
  /**
   * Standing context injected as system messages ahead of the goal — the user profile
   * and auto-recalled memories. Assembled by the caller (`runner.ts`) so every run kind
   * gets it, and so this module stays a pure loop with no opinion about memory.
   *
   * These become SYSTEM messages, so only ever pass trusted, locally-sourced text here.
   * Anything fetched from the outside world belongs in a tool result, tagged UNTRUSTED.
   */
  context?: string[];
  /**
   * Earlier turns of the same conversation, as alternating user/assistant messages, placed
   * between the standing context and the current goal.
   *
   * This is NOT the stored trace of those runs. Replaying prior tool traffic would exhaust
   * the local model's context within a few turns, so `runner.ts` compacts each past turn to
   * what was asked and what was concluded. The full trace of every run stays in the
   * `messages` table — this is a compaction for the next turn, not a lossy write.
   */
  history?: Msg[];
  /**
   * Knowledge retrieved for this task from a project's indexed documents.
   *
   * Kept separate from `context` because the trust tier is different and must stay visible
   * in the code: `context` is human-curated and becomes SYSTEM messages, while this is file
   * content — which `read_file` already treats as hostile, since a local file may be
   * something you downloaded. So it arrives UNTRUSTED-tagged and enters as a USER message.
   */
  knowledge?: string;
  /**
   * Whether this conversation holds an image the `look_at_image` tool could go back to.
   *
   * Set by `runner.ts` from the ledger rather than inferred here, because the loop has no
   * idea what a conversation contains. False everywhere else, which is why a schedule, a
   * watcher and the CLI never carry the tool.
   */
  imagesAvailable?: boolean;
  /** Step ceiling for this loop. Subagents get a tighter one than the top-level run. */
  maxSteps?: number;
  /** Tokens this loop may spend (LP3). Defaults to the ceiling times RUN_TOKENS_PER_STEP. */
  tokenBudget?: number;
  /** Wall-clock milliseconds this loop may take, not counting time paused for a person. Defaults to the ceiling times RUN_MS_PER_STEP. */
  timeBudgetMs?: number;
  /**
   * Which model tier drives this loop. The broker gates every call identically whatever
   * this says — a cheaper tier buys a worse plan, never a wider permission.
   */
  tier?: Tier;
  /**
   * Restrict the loop to a subset of the registry. Used by subagents, where the child's
   * tools are the INTERSECTION of what it declares and what its parent could reach.
   * Undefined means the whole registry.
   */
  tools?: string[];
  /**
   * Pin the whole run to the local model from the first request. Set for a run inside a
   * project (its documents are workplace material) and for a thread that has touched private
   * material, where earlier replies travel as history. See src/sensitivity.ts.
   */
  startPrivate?: boolean;
  /**
   * What the application knows about this run, rendered once as a short envelope after the stable
   * prompt (src/harness.ts). Absent for callers that have no run record; the loop then runs as before.
   */
  harness?: HarnessContext;
}

/** One tier up, for the retry after a malformed reply. `deep` has nowhere further to go. */
const escalate = (tier: Tier): Tier => (tier === "fast" ? "standard" : "deep");

/**
 * Which steps of a run get the model's thinking turned on (LP2, "local deep").
 *
 * Only a run sized `deep` that is being served by a local model: privacy pinned it, or no cloud
 * tier is configured. Such a task used to get exactly the effort of an easy one. Within it, only
 * the three points where more thought changes what happens next: the first step, where the plan
 * is made; the re-ask after an unreadable reply, where sending the same prompt the same way
 * mostly buys the same reply; and the step after a tool error, where the model has to work out
 * what went wrong. Every other step is a tool call it has already decided on.
 */
const thinkNow = (s: { afterError: boolean; localDeep: boolean; reask: boolean; step: number }): boolean =>
  LOCAL_DEEP_THINKING && s.localDeep && (s.step === 0 || s.reask || s.afterError);

/**
 * One model call for a step. With `thinking` it is asked with the larger cap and its own timing
 * purpose ("step-think"), so the timing table shows what thinking adds per step. A thinking
 * call that fails, or spends its whole cap on the thought and answers nothing, is asked again
 * the ordinary way: thinking may make a step better, and must never be why a run failed.
 */
const routeStep = async (messages: Msg[], opts: RouteOpts): Promise<RouteResult> => {
  // The cap is explicit because the server's default is not "none" — see AGENT_STEP_MAX_TOKENS.
  const plain = (): Promise<RouteResult> => route(messages, { maxTokens: AGENT_STEP_MAX_TOKENS, ...opts, thinking: false });
  if (!opts.thinking) return plain();
  try {
    const thought = await route(messages, { ...opts, maxTokens: LOCAL_DEEP_MAX_TOKENS, purpose: `${opts.purpose ?? "step"}-think` });
    if (thought.text.trim()) return thought;
  } catch (err) {
    // A stop or a cloud cap is a decision, not a failed thought, and is not retried around.
    if (!(err instanceof LLMError)) throw err;
  }
  return plain();
};

const parseOr = async (messages: Msg[], opts: RouteOpts, read: (text: string, truncated: boolean, looped: boolean) => any) => {
  const result = await routeStep(messages, opts);
  return {
    actualTier: result.tier,
    looped: result.looped,
    parsed: read(result.text, result.truncated, result.looped),
    text: result.text,
    truncated: result.truncated,
    via: result.via,
  };
};

/**
 * What to say after a reply that did not parse. A truncated reply is a different failure
 * from a malformed one and needs a different instruction: "reply with valid JSON" to a model
 * that WROTE valid JSON, just too much of it, gets the same over-long reply back.
 */
const parseFailureNudge = (truncated: boolean, conversational: boolean, astray = false): string =>
  astray
    ? "That reply could not be used: it " +
      "wrote tool calls as plain text or repeated itself, so nothing ran. A tool only runs from " +
      'one JSON object: {"action":"tool","tool":"<name>","args":{...}}. Reply with exactly one ' +
      "such object for the single next call you need, and nothing else — you will see its result " +
      "before choosing the next." +
      (conversational ? " If you need no tool, answer the user directly instead." : "")
    : truncated
    ? "Your reply was cut off at the length limit before the JSON object closed, so none of it " +
      "could be used. Reply again with one complete JSON object, and keep it shorter — " +
      (conversational
        ? 'if you are answering, give the key points concisely in {"action":"final","reply":"..."}.'
        : 'if you are finishing, summarise briefly in {"action":"final","summary":"..."}.')
    : "That was not one valid JSON object. Reply with exactly one.";

/**
 * Where the finishing text lives in the model's reply.
 *
 * `summary` is the documented key and `reply` is the one the conversational prompt asks
 * for, but a local model finishing a chat turn reaches for whichever word the prompt put in
 * its head — and the cost of guessing wrong is total. `String(parsed.summary ?? "…")` on a
 * reply keyed `answer` yields the empty string, and an empty string renders as nothing at
 * all: the turn shows its tool cards and then simply stops, which is what a user reports as
 * "it returned the JSON output". Reading every plausible key is the same forgiveness the
 * tool-call parser already extends one branch below, for the same reason.
 */
const FINAL_KEYS = ["reply", "summary", "answer", "response", "message", "text", "content"];

const finalText = (parsed: any): string => {
  for (const key of FINAL_KEYS) {
    const value = parsed?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

/**
 * The text of a notification the broker refused during a live chat turn — which is to say,
 * a finished answer the model tried to send down a channel the user is not reading.
 *
 * Deliberately blind to *which* gate refused it. Any denied notify in a conversation means
 * the same thing operationally: this text did not reach the user, and it is addressed to
 * them. The body is where the answer lives; the title is a header ("Weather in Concord, NH")
 * and would only be a heading on a sentence.
 */
const refusedNotifyText = (conversational: boolean, call: ToolCall, status: BrokerStatus): string =>
  conversational && call.tool === "notify" && status === "denied" ? String(call.args?.body ?? "").trim() : "";

/**
 * Identity of a call, for spotting the model asking the same question over and over. Keys
 * are sorted so that argument order — which the model varies freely — doesn't disguise a
 * repeat as a new call.
 */
const callKey = (call: ToolCall): string => {
  const args = call.args ?? {};
  return `${call.tool}:${JSON.stringify(args, Object.keys(args).sort())}`;
};

/** Identical calls tolerated before the run is treated as stuck and closed out. */
const REPEAT_LIMIT = 3;

/** The same call this many times is stuck even if its output keeps changing (a clock, a counter, a banner). */
const CALL_CEILING = 6;

interface RepeatState {
  /** Consecutive calls that got this same output. */
  repeats: number;
  calls: number;
  output: string;
}

/**
 * A call is a repeat only when the ANSWER is the same as last time, not merely the arguments.
 *
 * Observed 2026-11-21 (run 807): the inbox cleanup is told to call gmail_search a second time "with the same
 * arguments for the next batch". Counting by arguments alone made that a repeat, so the loop told the model
 * "you received the same answer, do NOT call it again, answer now". The model obeyed, skipped gmail_triage
 * entirely, and wrote a summary of trashing it never did. A stateful tool (sinceKey remembers what it returned)
 * gives a different answer to an identical call, and that is progress. CALL_CEILING keeps a backstop for a
 * model that really is looping on a tool whose output happens to change every time.
 */
const nextRepeat = (prev: RepeatState | undefined, output: string): RepeatState => {
  const calls = (prev?.calls ?? 0) + 1;
  return { calls, output, repeats: prev && prev.output === output ? prev.repeats + 1 : 1 };
};

/**
 * One last call to the model, outside the loop's JSON protocol.
 *
 * A run that is going in circles still usually holds the answer — it looked the weather up
 * three times and got it three times; what it cannot do is stop and say so. Ending such a
 * run with "reached the step cap without concluding" throws that away and shows the user
 * nothing, which is the worst of both: the work was done and the answer was discarded.
 *
 * So the loop is abandoned and the model is asked one plain question with the material it
 * gathered. No tools, no protocol, nothing to get stuck in — the failure mode being escaped
 * is precisely the protocol, so the escape hatch must not use it.
 *
 * The material is tool output, so it enters as a USER message and keeps whatever UNTRUSTED
 * tagging its tool gave it. Never throws: this runs when things have already gone wrong.
 */
const closingAnswer = async (
  goal: string,
  gathered: string[],
  conversational: boolean,
  tier: Tier,
  runId: number | null = null,
  priv = false,
): Promise<string> => {
  const material = gathered.slice(-6).map((g) => g.slice(0, 1500)).join("\n\n").slice(0, 8000);
  if (!material) return "";
  try {
    const { text } = await route(
      [
        {
          role: "system",
          content: conversational
            ? "Answer the person's question using only the information below. Reply in plain prose — " +
              "no JSON, no tool calls, and no mention of tools, steps, or how the information was " +
              "obtained. If it does not answer their question, say so in one sentence."
            : "Summarise what was found, using only the information below. Plain prose, no JSON.",
        },
        { role: "user", content: `Question: ${goal}\n\nInformation gathered:\n${material}` },
      ],
      { maxTokens: AGENT_STEP_MAX_TOKENS, purpose: "closing", runId, ...(priv ? { sensitivity: "private" as const } : {}), tier },
    );
    return text.trim();
  } catch {
    return "";
  }
};

const safeJson = (text: string): any | null => {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
};

/**
 * A tool call written as bare text: a line that is only a tool's name, then `key=value`.
 *
 * Observed 2026-11-24 (see src/reply-loop.ts): the reply opened `memory_save` / `text=…` /
 * `kind=personal` / `memory_recall` / `query=…`. LP1 below reads prose as the answer, so that
 * was shown to the user as one and no tool ran. It is a failed protocol attempt, the same as a
 * broken JSON object. Not run from this form on purpose: the first call there was a write, and
 * a write should not start from a guess at what the arguments were.
 */
const textToolCall = (body: string, tools: Record<string, Tool>): boolean => {
  const lines = body.split("\n").map((l) => l.trim());
  return lines.some((line, i) => Object.hasOwn(tools, line) && /^[a-z_][a-z0-9_]*\s*=/i.test(lines[i + 1] ?? ""));
};

/** How much of a looped reply is kept in the transcript: enough to show the mistake once. */
const LOOPED_ECHO_CHARS = 600;

const CUT_OFF_NOTE = "\n\n_This reply reached the length limit and was cut off._";

/**
 * Read one step's reply. In a chat turn, plain prose is the answer (LP1).
 *
 * Measured 2026-11-23: of 33 samples that should have finished, 21 failed to parse, and the
 * two inspected were correct answers without the JSON wrapper. A real tool call still wins,
 * even after a sentence of preamble, and a reply opening with `{` is a broken protocol
 * attempt rather than an answer. Unattended runs keep the strict format: nobody is there to
 * notice a run that stopped early because it wrote a sentence.
 */
const readReply = (
  text: string,
  truncated: boolean,
  conversational: boolean,
  tools: Record<string, Tool>,
  looped = false,
): any => {
  // A reply stopped for looping was cut mid-thought wherever it was, so none of it is trusted,
  // not even a JSON object that happens to sit inside it.
  if (looped) return null;
  const parsed = safeJson(text);
  if (!conversational) return parsed;
  const action = parsed?.action;
  if (action === "final" || action === "tool" || (typeof action === "string" && tools[action])) return parsed;
  const body = text.trim();
  if (textToolCall(body, tools)) return null;
  if (!body || /^```(?:json)?\s*\{\s*"action"/.test(body)) return parsed;
  // Asked to "show a JSON object", the model opens with one and explains it, which is an answer.
  // Anything shaped like the protocol, or that does not parse, is still a failed attempt.
  if (body.startsWith("{") && (!parsed || "action" in parsed || "tool" in parsed || FINAL_KEYS.some((key) => key in parsed))) {
    return parsed;
  }
  if (body.length <= PROMISE_MAX_CHARS && PROMISE_ONLY.test(body)) return null;
  return { action: "final", reply: truncated ? `${body}${CUT_OFF_NOTE}` : body };
};

/**
 * Run the loop, then drop this run's private pin if it is the root of its tree. A subagent
 * shares its parent's `budgetRunId`, so it neither owns the pin nor releases it.
 */
export const runAgent = async (
  goal: string,
  policy: Policy,
  runId: number | null,
  opts: AgentOpts = {},
): Promise<AgentResult> => {
  try {
    return await runAgentLoop(goal, policy, runId, opts);
  } finally {
    if (opts.budgetRunId == null || opts.budgetRunId === runId) releaseRun(runId);
    releaseHarness(runId);
  }
};

const runAgentLoop = async (
  goal: string,
  policy: Policy,
  runId: number | null,
  opts: AgentOpts = {},
): Promise<AgentResult> => {
  // The harness context, when there is one, is the single owner of these two facts (S1); the plain
  // options remain for callers that build no context (tests, the eval harnesses).
  const conversational = opts.harness?.conversational ?? opts.conversational ?? false;
  // What the user typed, for the tools that ask "did they say so?": nothing, when the application wrote the goal.
  const userGoal = opts.goalWrittenByCode ? "" : goal;
  const tools = settingTools(visibleTools(opts.tools), conversational, userGoal, opts.imagesAvailable ?? false);
  const tier = opts.tier ?? "standard";
  // The loop alone knows which tools this setting lets the run see, so the context is completed here
  // and registered for a subagent to derive its own from.
  const harness = opts.harness
    ? {
        ...opts.harness,
        capabilities: summarizeCapabilities(Object.keys(tools), policy, {
          availability: (name) => tools[name]?.available?.(policy).allowed,
          cloudPrivateBlocked: Boolean(opts.startPrivate || opts.harness.private),
          conversational,
        }),
        tools: Object.keys(tools),
      }
    : undefined;
  if (harness) registerHarness(harness);

  const messages: Msg[] = [
    { role: "system", content: system(tools, conversational) },
    // The envelope leads the extra context: it is the one place the run states what it is, so it
    // comes straight after the stable prompt and shows up in the trace like any other message.
    ...(harness ? [{ role: "system", content: renderEnvelope(harness, opts.startPrivate ?? false) } as Msg] : []),
    ...(opts.context ?? []).map((content): Msg => ({ role: "system", content })),
    ...(opts.history ?? []),
    // Project knowledge is file content, so it enters as an untrusted USER message rather
    // than joining the trusted system context above. See AgentOpts.knowledge.
    ...(opts.knowledge ? [{ role: "user", content: opts.knowledge } as Msg] : []),
    { role: "user", content: goal },
  ];

  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  // LP3: the step count is a ceiling; tokens and time are the budget. Scaled from the ceiling, so a unit whose file
  // asks for more steps gets proportionally more of both (see RUN_TOKENS_PER_STEP in config.ts).
  const budget = { ms: opts.timeBudgetMs ?? maxSteps * RUN_MS_PER_STEP, tokens: opts.tokenBudget ?? maxSteps * RUN_TOKENS_PER_STEP };
  const startedAt = Date.now();
  let pausedMs = 0;
  let estimatedSpend = 0;
  let warned = false;
  /** Tokens spent so far: the host's own counts when it reported every call, else the running estimate. */
  const spent = (): number => {
    if (runId == null) return estimatedSpend;
    const u = usageForRuns([runId]);
    return u.calls > 0 && u.unreported === 0 ? u.promptTokens + u.completionTokens : estimatedSpend;
  };
  /** Where the run's own messages start: everything before is the prefix that compaction leaves alone. */
  const prefixEnd = messages.length;
  // LP6: the tools whose instructions the model has: those shown in full, and those it read with tool_help.
  const docsRead = fullyShown(tools);

  // The pin is per root run: a subagent reading a transcript pins its parent, and one started
  // after the parent read a transcript starts pinned. See src/sensitivity.ts.
  const rootId = opts.budgetRunId ?? runId;
  /** `sensitivity` for every model call from here on: private once private material is in the history. */
  const sens = (): { sensitivity?: "private" } => (isPinned(rootId) ? { sensitivity: "private" } : {});
  // A run that starts inside a project, or in a thread that has already touched private
  // material, is local from its first request, not only after a tool has run.
  if (opts.startPrivate) pinRun(rootId);
  // A subagent's model calls carry its own run id; linking it lets a stop on the turn reach them.
  linkRun(runId, rootId);

  let tierCorrected = false;
  /** A `deep` task that a local model is serving: pinned private, or no cloud tier to send it to (LP2). */
  const localDeep = (): boolean => tier === "deep" && resolveTier("deep", isPinned(rootId) ? "private" : "normal").tier !== "deep";
  /** The last tool call came back as an error, so the next step has something to work out. */
  let afterError = false;

  /**
   * An answer the model wrote into a notification that was refused. Held so that however
   * this run ends — a second refusal, or the step cap — the user gets the text that was
   * written for them rather than silence.
   */
  let undelivered = "";

  /** How many times each exact call has been made, and what the run has learned so far. */
  const callCounts = new Map<string, RepeatState>();
  const gathered: string[] = [];

  /**
   * End a run that is not going to end itself. Prefers text the model already wrote for the
   * user over spending another call, then a closing answer built from what was gathered,
   * and only says "nothing came of this" when there is genuinely nothing.
   */
  const concludeStuck = async (steps: number, fallback: string): Promise<AgentResult> => {
    const summary = undelivered || (await closingAnswer(goal, gathered, conversational, tier, runId, isPinned(rootId))) || fallback;
    publish(runId, { steps, summary, type: "final" });
    return { summary, steps, trace: messages };
  };

  /** Steps in a row whose reply could not be parsed, even after the tier-up re-ask. */
  let parseFailures = 0;
  const read = (text: string, truncated: boolean, looped: boolean): any =>
    readReply(text, truncated, conversational, tools, looped);
  // Only a chat turn has someone reading it as it is written (see AgentOpts.conversational).
  const answer = conversational ? answerPublisher((text) => publish(runId, { text, type: "answer" })) : null;
  const streaming = answer ? { onDelta: answer.update } : {};

  for (let step = 0; step < maxSteps; step++) {
    // The user pressed stop. Checked here, between steps, so a tool that was already running
    // finished cleanly rather than being cut off halfway (see src/stop.ts).
    throwIfStopped(rootId);
    // A person is waiting (LP5): a background run hands the model over here, at the same boundary, and carries on
    // once they are done. Nothing about this run changes while it waits. A stop asked for meanwhile lands on resume.
    const waitedFrom = Date.now();
    if (await yieldToPerson()) {
      const waitedMs = Date.now() - waitedFrom;
      pausedMs += waitedMs;
      publish(runId, { type: "paused_for_person", waitedMs });
      addRunNote(runId, "paused_for_person", { waitedMs });
      throwIfStopped(rootId);
    }

    // The budget (LP3). Over it, the run is closed out with what it gathered, as the step ceiling always did. Near
    // it, the model is told once, on the end of the message it is about to read, so the prefix stays as it was.
    const used = spent();
    const elapsed = Date.now() - startedAt - pausedMs;
    if (used >= budget.tokens || elapsed >= budget.ms) {
      const over = { elapsedMs: elapsed, reason: used >= budget.tokens ? "tokens" : "time", tokens: used };
      publish(runId, { ...over, type: "budget" });
      addRunNote(runId, "budget", over);
      return concludeStuck(step, used >= budget.tokens ? "Used its whole token budget without concluding." : "Ran out of time without concluding.");
    }
    if (!warned && step > 0 && (used >= budget.tokens * RUN_BUDGET_WARN_AT || elapsed >= budget.ms * RUN_BUDGET_WARN_AT)) {
      warned = true;
      const nudge =
        "You have used most of this run's budget. Do not start anything new: finish now with what you have" +
        (conversational ? ", answering the user in plain prose." : ', with {"action":"final","summary":"..."}.');
      const last = messages[messages.length - 1];
      if (last.role === "user" && typeof last.content === "string") last.content = `${last.content}\n\n${nudge}`;
      else messages.push({ content: nudge, role: "user" });
    }

    // Compaction (LP3, src/compact.ts): only when a held result can be read back, so nothing is dropped for good.
    if (tools.read_more && runId != null) {
      const c = compactMessages(messages, {
        atTokens: COMPACT_AT_TOKENS,
        from: prefixEnd,
        hold: (text) => holdText(runId, "an earlier tool result in this run", text),
        keepRecent: COMPACT_KEEP_RECENT,
        toFraction: COMPACT_TO,
      });
      if (c.stubs) {
        publish(runId, { after: c.after, before: c.before, stubs: c.stubs, type: "compacted" });
        addRunNote(runId, "compacted", { after: c.after, before: c.before, stubs: c.stubs });
      }
    }

    estimatedSpend += estimateTokens(messages);
    publish(runId, { step: step + 1, type: "step_start" });

    const thinkFirst = thinkNow({ afterError, localDeep: localDeep(), reask: false, step });
    afterError = false;
    let { text, parsed, actualTier, via, truncated, looped } = await parseOr(messages, {
      purpose: "step",
      runId,
      step: step + 1,
      tier,
      ...(thinkFirst ? { thinking: true } : {}),
      ...streaming,
      ...sens(),
    }, read);

    // A malformed reply gets one retry a tier up. This is where small-model unreliability
    // is absorbed: a 3B that fumbles the JSON protocol costs one extra call rather than
    // failing the run, which is what makes routing cheap work to a cheap tier safe.
    //
    // Not for a truncated one, though. That model did not fumble the protocol, it ran out
    // of room, and resending the identical prompt just buys the identical cut-off reply —
    // the nudge below, which asks for a shorter one, is what actually changes the outcome.
    //
    // Nor for one that went astray (looped, or wrote its tool calls as text): at this
    // temperature the same prompt walks into the same loop, and the nudge names the mistake.
    const astray = (): boolean => looped || textToolCall(text.trim(), tools);
    if (!parsed && !truncated && !astray()) {
      // Attributed as its own purpose, not folded into the step: a model that fumbles the
      // JSON protocol costs a whole extra round-trip, and the point of timing is to find
      // out how often that is actually happening rather than to assume.
      // The re-ask sends the whole prompt again, so it is spent again.
      estimatedSpend += estimateTokens(messages) + estimateTokens([{ content: text, role: "assistant" }]);
      ({ text, parsed, actualTier, via, truncated, looped } = await parseOr(messages, {
        purpose: "step-reask",
        runId,
        step: step + 1,
        ...(tier === "deep" ? { prefer: "cloud" as const } : { tier: escalate(tier) }),
        // On a local deep run the re-ask lands on the very endpoint that just fumbled, so
        // thinking is the one thing that makes it a different attempt (LP2).
        ...(thinkNow({ afterError: false, localDeep: localDeep(), reask: true, step }) ? { thinking: true } : {}),
        ...streaming,
        ...sens(),
      }, read));
    }

    estimatedSpend += estimateTokens([{ content: text, role: "assistant" }]);

    // Whatever this step showed was not the answer after all, so it comes back off the screen.
    if (!(parsed?.action === "final" && finalText(parsed))) answer?.retract();

    // If the router fell back to a different tier than what dispatch sized, correct the
    // badge so the UI never shows "local" when the answer actually came from the cloud.
    if (!tierCorrected && actualTier !== tier) {
      publish(runId, { reason: "fallback", tier: actualTier, type: "tier", via });
      tierCorrected = true;
    }
    // A looped reply goes back in short. The model has to see what it did for the nudge to
    // make sense, but a non-streamed loop arrives whole (13,286 characters, observed), and
    // that much repetition in context is an invitation to continue it.
    messages.push({ role: "assistant", content: looped ? text.slice(0, LOOPED_ECHO_CHARS) : text });

    if (!parsed) {
      /**
       * Bounded, because nothing else bounds it. Observed: sixteen consecutive cut-off
       * replies, each re-asked, each ~56s, ending only at a thirty-step cap eighteen minutes
       * in. The repeat guard never fires on this — no tool is being called — so the run is
       * closed out here with what it gathered while that is still worth having.
       */
      parseFailures += 1;
      if (parseFailures >= MAX_PARSE_FAILURES) {
        return concludeStuck(
          step + 1,
          astray()
            ? "Kept repeating itself instead of answering."
            : truncated
            ? "Kept running out of room before finishing a reply."
            : "Kept replying in a form that could not be read.",
        );
      }
      messages.push({ role: "user", content: parseFailureNudge(truncated, conversational, astray()) });
      continue;
    }
    parseFailures = 0;

    if (parsed.action === "final") {
      const summary = finalText(parsed);

      // A blank finish is not a finish. The UI renders the final text as the whole of the
      // assistant's turn, so returning "" here shows the user their question, some tool
      // cards, and no answer — a failure that looks exactly like a bug in the interface.
      // Ask once more instead; the step cap is what stops this from going around forever.
      if (!summary) {
        messages.push({
          role: "user",
          content: conversational
            ? "Your reply was empty. Answer the user now, in plain prose, using what the tools returned."
            : 'Your summary was empty. Finish with {"action":"final","summary":"<what you did>"}.',
        });
        continue;
      }

      publish(runId, { steps: step + 1, summary, type: "final" });
      return { summary, steps: step + 1, trace: messages };
    }

    /**
     * The forgiving parser. Local models reliably produce three shapes, and rejecting two
     * of them just burns steps re-asking for the third:
     *
     *   {"action":"tool","tool":"weather","args":{"location":"Boston"}}   the documented one
     *   {"action":"weather","args":{"location":"Boston"}}                 tool name as action
     *   {"action":"weather","location":"Boston"}                          args inlined
     *
     * The third is what a 30B emits most often for multi-argument tools, and without it a
     * two-argument tool like `subagent` is effectively uncallable — every attempt arrives
     * with empty args and gets denied. So when there is no `args` object, the leftover
     * top-level keys ARE the arguments.
     *
     * Resolved against `tools`, never the registry: the shorthand must not become a way
     * around a restricted tool set.
     */
    const inlined = (obj: any): any => {
      const { action: _action, args, tool: _tool, ...rest } = obj;
      if (args && typeof args === "object") return args;
      return Object.keys(rest).length ? rest : undefined;
    };

    let call: ToolCall | null = null;
    if (parsed.action === "tool") call = { tool: String(parsed.tool), args: inlined(parsed) };
    else if (tools[parsed.action]) call = { tool: parsed.action, args: inlined(parsed) };

    if (call) {
      // Enforced here as well as in the prompt, because a prompt is a request and this is
      // a rule. A restricted loop can name a tool it was not given — it just can't reach it.
      if (!tools[call.tool]) {
        messages.push({
          role: "user",
          content:
            `tool result [denied]:\nDENIED: ${JSON.stringify(call.tool)} is not available to you. ` +
            `You may only use: ${Object.keys(tools).join(", ")}.` +
            renderResultEnvelope(describeResult(call.tool, "denied", "")),
        });
        continue;
      }
      /**
       * How many times this exact call has now been made.
       *
       * Counted rather than blocked, and the call still executes. Repeating a *query* is
       * merely wasteful, but repeating an *action* — a click, a keystroke, a banner — may be
       * exactly what was intended, and serving those from a cache would silently break
       * workflows that legitimately do the same thing twice. So nothing is suppressed; the
       * repetition is used as the signal it is, that the model is stuck rather than working.
       */
      const key = callKey(call);

      // The goal passed here is the user's own message, not anything the model has since
      // written about it — a tool gating on "did they ask for this?" must read the request,
      // not the requester's account of it.
      const result = await executeCall(call, policy, runId, opts.budgetRunId ?? runId, {
        conversational,
        goal: userGoal,
        preApproved: opts.harness?.preApproved ?? opts.preApproved ?? false,
        // Not `goal`: in a subagent that is the caller's brief, which the model wrote.
        approvedTask: opts.approvedTask,
        projectId: opts.projectId ?? null,
      });
      if (result.status === "executed") gathered.push(`${call.tool} -> ${result.output}`);
      afterError = result.status === "error";
      const seen = nextRepeat(callCounts.get(key), result.output);
      callCounts.set(key, seen);
      const repeats = seen.repeats;
      // From here the output is in `messages`, which every later request carries. Pin before
      // the next one is built, not after.
      let pinMessage = "";
      if (result.status === "executed" && outputIsPrivate(call.tool, call.args, opts.projectId ?? null)) {
        // Said once, at the moment it becomes true, and appended to the history so the stable prefix is untouched.
        if (!isPinned(rootId) && harness) pinMessage = `\n\n${pinNotice()}`;
        pinRun(rootId);
      }

      /**
       * A notification refused in a live chat is not an obstacle to route around. It is the
       * answer, addressed to the wrong place — the model has already written the finished
       * message, it just tried to deliver it down a channel the user is not using.
       *
       * Left to itself the model does not read the refusal that way. Observed: denied,
       * search again, compose the same notification, denied, search again — around until
       * the step cap, and the user gets nothing at all despite a correct answer having been
       * written on the second step. So the text is kept, and the loop stops asking:
       *
       *   first refusal   keep the text, and say plainly that no more tools are wanted
       *   second refusal  stop negotiating — that text IS the reply, finish with it
       *   step cap        finish with it rather than with "reached the step cap"
       *
       * Only the delivery is refused; nothing here decides what the user may be told.
       */
      const refused = refusedNotifyText(conversational, call, result.status);
      if (refused) {
        if (undelivered) {
          publish(runId, { steps: step + 1, summary: refused, type: "final" });
          return { summary: refused, steps: step + 1, trace: messages };
        }
        undelivered = refused;
        messages.push({
          role: "user",
          content:
            `tool result [${result.status}]:\n${result.output}\n\n` +
            `You have already written the answer. Do NOT call another tool — no searches, no ` +
            `lookups, nothing. Reply now with that same text, in plain prose.`,
        });
        continue;
      }

      /**
       * The same call, for the third time, with the same arguments and the same answer.
       *
       * Observed: three identical `weather` calls and still going at step six, on its way to
       * burning the whole cap and showing the user nothing. The prompt already asks it not
       * to do this, and asking is evidently not enough — a model in this state reads its own
       * repetition as progress. So the run stops here and is closed out with what it found,
       * which it has now found three times.
       */
      if (repeats >= REPEAT_LIMIT || seen.calls >= CALL_CEILING) {
        return concludeStuck(step + 1, "Kept repeating the same tool call without concluding.");
      }

      if (call.tool === "tool_help" && result.status === "executed") {
        for (const n of Array.isArray(call.args?.names) ? call.args.names : [call.args?.names]) if (n) docsRead.add(String(n));
      }
      // A failed call to a tool listed in one line, whose instructions it never read, says how to read them.
      const unread =
        result.status !== "executed" && result.status !== "queued" && result.status !== "dry-run" && !docsRead.has(call.tool) && tools.tool_help
          ? `\n\nYou called ${call.tool} without reading its instructions. Read them first: {"action":"tool","tool":"tool_help","args":{"names":["${call.tool}"]}}`
          : "";
      messages.push({
        role: "user",
        content:
          `tool result [${result.status}]:\n${result.output}` +
          renderResultEnvelope(describeResult(call.tool, result.status, result.output, result.confirmationId)) +
          pinMessage +
          unread +
          // One warning first, on the second identical call, so a model that can take the
          // hint gets to finish properly rather than being cut off.
          (repeats > 1
            ? `\n\nYou have now made this exact call ${repeats} times and received the same answer. ` +
              `Do NOT call it again. You have what you need — answer now ` +
              (conversational ? "in plain prose." : `with {"action":"final","summary":"..."}.`)
            : ""),
      });
      continue;
    }

    messages.push({
      role: "user",
      content: conversational
        ? 'Call a tool with {"action":"tool","tool":"<name>","args":{...}}, or answer the user in plain prose.'
        : 'Reply with {"action":"tool","tool":"<name>","args":{...}} or {"action":"final","summary":"..."}.',
    });
  }

  // Out of steps, and the same reasoning applies: a run that gathered the answer and then
  // failed to say it should still say it. `maxSteps`, not MAX_STEPS — a subagent has its own
  // tighter cap, and reporting the top-level one here was simply wrong.
  publish(runId, { reason: "steps", type: "budget" });
  addRunNote(runId, "budget", { reason: "steps", steps: maxSteps });
  return concludeStuck(maxSteps, "Reached the step cap without concluding.");
};

/**
 * Exposed for test/agent-final.test.mjs. The prompt is the product here — the difference
 * between a reply and a status report is one sentence in it — so it is worth asserting on
 * directly rather than only through a live model that may paper over a bad instruction.
 */
export const __test = {
  thinkNow,
  // The system prompt as a run would send it, for test/prompt-snapshot.test.mjs (H1).
  systemFor: (tools: Record<string, Tool>, conversational: boolean) => system(tools, conversational),
  callKey,
  CALL_CEILING,
  finalText,
  nextRepeat,
  parseFailureNudge,
  readReply: (text: string, truncated: boolean, conversational: boolean, looped = false) =>
    readReply(text, truncated, conversational, registry, looped),
  refusedNotifyText,
  REPEAT_LIMIT,
  settingTools,
  systemPrompt: (conversational: boolean) => system(registry, conversational),
};

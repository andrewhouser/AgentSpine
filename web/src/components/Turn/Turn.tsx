import type { TurnSources } from "../../lib/moments.ts";
import type { RunNoteLike } from "../../lib/runNotes.ts";
import type { ServedModel } from "../../lib/types.ts";
import type { Attachment, LiveToolCall, PlanStep, VisionPass } from "../../lib/types.ts";

import { describeActivity } from "../../lib/activity.ts";
import { turnWhere } from "../../lib/privacy.ts";
import { describeRunNote } from "../../lib/runNotes.ts";
import { weatherCardOf } from "../../lib/weatherCard.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AssistantMessage } from "../AssistantMessage/AssistantMessage.tsx";
import { DecisionNote } from "../DecisionNote/DecisionNote.tsx";
import { DelegationCard } from "../DelegationCard/DelegationCard.tsx";
import { PlanCard } from "../PlanCard/PlanCard.tsx";
import { ReplyActions } from "../ReplyActions/ReplyActions.tsx";
import { Sources } from "../Sources/Sources.tsx";
import { ThinkingIndicator } from "../ThinkingIndicator/ThinkingIndicator.tsx";
import { TierBadge } from "../TierBadge/TierBadge.tsx";
import { UserMessage } from "../UserMessage/UserMessage.tsx";
import { VisionNote } from "../VisionNote/VisionNote.tsx";
import { WeatherCard } from "../WeatherCard/WeatherCard.tsx";
import styles from "./Turn.module.css";

interface TurnProps {
  /** Images sent with this turn. */
  attachments?: Attachment[];
  confirmations: { id: number; summary: string; tool: string }[];
  /** Persisted turns only: what the assistant had in front of it, and the reply's star. */
  contextUsed?: string[];
  /** Units this turn delegated to, live or persisted. */
  delegations?: { actions?: LiveToolCall[]; agent: string; status: null | string; summary: null | string; task: null | string; tier: null | string }[];
  error: null | string;
  /** "approval" draws the task as the user's decision rather than as a typed message. */
  kind?: null | string;
  live: boolean;
  /** Paused, compacted or stopped at a budget while it ran (LP3, LP5). Only a live turn has them. */
  notes?: RunNoteLike[];
  onConfirmationResolved: () => void;
  /** Put the message back in the composer to change it. Offered only on a finished turn. */
  onEdit?: () => void;
  /** Send the message again as a new turn. Offered only on a finished turn. */
  onRetry?: () => void;
  /** Live turns only: the plan card's newest snapshot (src/plan.ts). */
  plan?: PlanStep[];
  projectId?: null | number;
  runId?: number;
  /** Persisted turns only: what answered it, for the privacy rail (section 15, R10). */
  served?: null | ServedModel;
  /** Persisted turns only: what a knowledge answer rested on (section 15, R5). */
  sources?: null | TurnSources;
  starred?: boolean;
  /** When the message was sent. */
  startedAt?: string;
  step: number;
  summary: null | string;
  task: string;
  tier?: null | string;
  tierReason?: string;
  toolCalls: LiveToolCall[];
  /** The perception pass, when this turn had an image on it. */
  vision?: null | VisionPass;
  waitingBehind: number;
}

/**
 * One exchange, in the order it happened: what you asked, what it did to answer, anything
 * it needs you to approve, and what it concluded.
 *
 * Tool calls sit BEFORE the answer rather than being hidden behind it, because in this
 * system what it touched is part of the answer — an assistant that read your calendar to
 * reply is telling you something an assistant that guessed is not. They are folded into
 * the step checklist (PlanCard), which keeps that promise without making a twenty-call
 * research turn twenty rows tall; the Trace tab has every call.
 */
export const Turn = ({
  attachments = [],
  confirmations,
  contextUsed = [],
  delegations = [],
  error,
  kind = null,
  live,
  notes = [],
  onConfirmationResolved,
  onEdit,
  onRetry,
  plan = [],
  projectId = null,
  runId,
  served,
  sources,
  starred = false,
  startedAt,
  step,
  summary,
  task,
  tier,
  tierReason,
  toolCalls,
  vision = null,
  waitingBehind,
}: TurnProps) => {
  const weather = weatherCardOf(toolCalls);
  // Images bind to one run, once, so a message that carried any cannot be sent again: a retry
  // would quietly drop them and answer a different question. Copy and the time still show.
  const canResend = attachments.length === 0 && task.trim() !== "";

  return (
  <article className={styles.turn}>
    {kind === "approval" ? (
      <DecisionNote text={task} />
    ) : (
      <UserMessage
        attachments={attachments}
        onEdit={canResend ? onEdit : undefined}
        onRetry={canResend ? onRetry : undefined}
        startedAt={startedAt}
        text={task}
      />
    )}

    {/* The spine: everything the assistant did in answer to that hangs on one vertical line.
        Tool calls are nodes coloured by the broker's verdict; a hollow amber node is a
        question waiting on you. Drawn in CSS (Turn.module.css). Empty until there is
        something to hang on it, and then hidden, so a bare question has no dangling line. */}
    <div className={styles.thread}>
    {/* Before the tool trace: the looking happens first, and it is what the rest of the
        turn is reasoning from. */}
    {vision && <VisionNote pass={vision} />}

    {/* The chat shows what the turn did as its step checklist (PlanCard, below), not call by
        call: twenty rows of URLs buried the reply. Every call, its arguments, result and the
        broker's verdict, live in the Trace tab; a denied or failed call still shows as a
        failed step here. */}

    {delegations.length > 0 && (
      <div className={styles.tools}>
        {delegations.map((d, i) => (
          <DelegationCard
            actions={d.actions}
            agent={d.agent}
            key={`${d.agent}-${i}`}
            status={d.status}
            summary={d.summary}
            task={d.task}
            tier={d.tier}
          />
        ))}
      </div>
    )}

    {/* The steps the turn worked through: live while it runs, then the record once it ends
        (the server folds a finished turn's stored calls the same way, src/plan.ts). */}
    <PlanCard steps={plan} />

    {summary && (
      <>
        {weather && <WeatherCard card={weather} />}
        <AssistantMessage text={summary} />
        {sources && <Sources sources={sources} />}
        {runId !== undefined && !live && !error && (
          <ReplyActions contextUsed={contextUsed} projectId={projectId} runId={runId} starred={starred} />
        )}
        {(tier || turnWhere(served)) && (
          <div className={styles.footer}>
            {tier && <TierBadge reason={tierReason} tier={tier} />}
            {/* Where it ran (section 15, R10), from what the server recorded. */}
            {turnWhere(served) && <span className={styles.where}>{turnWhere(served)}</span>}
          </div>
        )}
      </>
    )}
    {error && <div className={styles.error}>{error}</div>}

    {/* After the reply, as a chat assistant asks: it says what it wants to do, then the
        buttons. Answering resumes the conversation with the result. */}
    {confirmations.map((c) => (
      <ApprovalCard
        confirmationId={c.id}
        key={c.id}
        onResolved={onConfirmationResolved}
        summary={c.summary}
        tool={c.tool}
      />
    ))}
    {notes.map((n) => describeRunNote(n)).filter((t): t is string => t !== null).map((text, i) => (
      <p className={styles.note} key={`${i}-${text}`}>
        {text}
      </p>
    ))}
    {live && !summary && !error && <ThinkingIndicator activity={describeActivity(toolCalls)} step={step} waitingBehind={waitingBehind} />}
    </div>
  </article>
  );
};

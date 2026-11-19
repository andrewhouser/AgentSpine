import type { Attachment, LiveToolCall, VisionPass } from "../../lib/types.ts";

import { describeActivity } from "../../lib/activity.ts";
import { recoveredCalls } from "../../lib/recovery.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AssistantMessage } from "../AssistantMessage/AssistantMessage.tsx";
import { DecisionNote } from "../DecisionNote/DecisionNote.tsx";
import { DelegationCard } from "../DelegationCard/DelegationCard.tsx";
import { ReplyActions } from "../ReplyActions/ReplyActions.tsx";
import { SpineCalls } from "../SpineCalls/SpineCalls.tsx";
import { ThinkingIndicator } from "../ThinkingIndicator/ThinkingIndicator.tsx";
import { TierBadge } from "../TierBadge/TierBadge.tsx";
import { ToolTrace } from "../ToolTrace/ToolTrace.tsx";
import { UserMessage } from "../UserMessage/UserMessage.tsx";
import { VisionNote } from "../VisionNote/VisionNote.tsx";
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
  onConfirmationResolved: () => void;
  /** Put the message back in the composer to change it. Offered only on a finished turn. */
  onEdit?: () => void;
  /** Send the message again as a new turn. Offered only on a finished turn. */
  onRetry?: () => void;
  projectId?: null | number;
  runId?: number;
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
 * one summary strip once the turn finishes (see ToolTrace), which keeps that promise
 * without making a twelve-step research turn twelve rows tall.
 */
export const Turn = ({
  attachments = [],
  confirmations,
  contextUsed = [],
  delegations = [],
  error,
  kind = null,
  live,
  onConfirmationResolved,
  onEdit,
  onRetry,
  projectId = null,
  runId,
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
  // A failure the turn went on to get past reads as a quiet step, not an alarm (lib/recovery.ts).
  const recovered = recoveredCalls(toolCalls, !!error);
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

    {/* Each call is a node on the spine. When one was denied or failed, the full trace opens
        instead (see ToolTrace): those are never incidental. Arguments and results for the rest
        live in the chat's Trace tab. */}
    {toolCalls.some((c, i) => c.status === "denied" || (c.status === "error" && !recovered[i])) ? (
      <ToolTrace calls={toolCalls} live={false} recovered={recovered} />
    ) : (
      <SpineCalls calls={toolCalls} recovered={recovered} />
    )}

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

    {summary && (
      <>
        <AssistantMessage text={summary} />
        {runId !== undefined && !live && !error && (
          <ReplyActions contextUsed={contextUsed} projectId={projectId} runId={runId} starred={starred} />
        )}
        {tier && (
          <div className={styles.footer}>
            <TierBadge reason={tierReason} tier={tier} />
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
    {live && !summary && !error && <ThinkingIndicator activity={describeActivity(toolCalls)} step={step} waitingBehind={waitingBehind} />}
    </div>
  </article>
  );
};

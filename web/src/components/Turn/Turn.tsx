import type { Attachment, LiveToolCall, VisionPass } from "../../lib/types.ts";

import { describeActivity } from "../../lib/activity.ts";
import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AssistantMessage } from "../AssistantMessage/AssistantMessage.tsx";
import { DelegationCard } from "../DelegationCard/DelegationCard.tsx";
import { ReplyActions } from "../ReplyActions/ReplyActions.tsx";
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
  live: boolean;
  onConfirmationResolved: () => void;
  projectId?: null | number;
  runId?: number;
  starred?: boolean;
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
  live,
  onConfirmationResolved,
  projectId = null,
  runId,
  starred = false,
  step,
  summary,
  task,
  tier,
  tierReason,
  toolCalls,
  vision = null,
  waitingBehind,
}: TurnProps) => (
  <article className={styles.turn}>
    <UserMessage attachments={attachments} text={task} />

    {/* Before the tool trace: the looking happens first, and it is what the rest of the
        turn is reasoning from. */}
    {vision && <VisionNote pass={vision} />}

    {/* The full trace lives in the chat's Trace tab. Only a denial or failure surfaces here,
        since those are never incidental. */}
    {toolCalls.some((c) => c.status === "denied" || c.status === "error") && (
      <ToolTrace calls={toolCalls} live={false} />
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

    {confirmations.map((c) => (
      <ApprovalCard
        confirmationId={c.id}
        key={c.id}
        onResolved={onConfirmationResolved}
        summary={c.summary}
        tool={c.tool}
      />
    ))}

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
    {live && !summary && !error && <ThinkingIndicator activity={describeActivity(toolCalls)} step={step} waitingBehind={waitingBehind} />}
  </article>
);

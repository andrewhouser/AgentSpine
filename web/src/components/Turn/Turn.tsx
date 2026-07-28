import type { LiveToolCall } from "../../lib/types.ts";

import { ApprovalCard } from "../ApprovalCard/ApprovalCard.tsx";
import { AssistantMessage } from "../AssistantMessage/AssistantMessage.tsx";
import { DelegationCard } from "../DelegationCard/DelegationCard.tsx";
import { ThinkingIndicator } from "../ThinkingIndicator/ThinkingIndicator.tsx";
import { TierBadge } from "../TierBadge/TierBadge.tsx";
import { ToolCallCard } from "../ToolCallCard/ToolCallCard.tsx";
import { UserMessage } from "../UserMessage/UserMessage.tsx";
import styles from "./Turn.module.css";

interface TurnProps {
  confirmations: { id: number; summary: string; tool: string }[];
  /** Units this turn delegated to, live or persisted. */
  delegations?: { actions?: LiveToolCall[]; agent: string; status: null | string; summary: null | string; task: null | string; tier: null | string }[];
  error: null | string;
  live: boolean;
  onConfirmationResolved: () => void;
  step: number;
  summary: null | string;
  task: string;
  tier?: null | string;
  tierReason?: string;
  toolCalls: LiveToolCall[];
  waitingBehind: number;
}

/**
 * One exchange, in the order it happened: what you asked, what it did to answer, anything
 * it needs you to approve, and what it concluded.
 *
 * Tool calls sit BEFORE the answer rather than being hidden behind it, because in this
 * system what it touched is part of the answer — an assistant that read your calendar to
 * reply is telling you something an assistant that guessed is not.
 */
export const Turn = ({
  confirmations,
  delegations = [],
  error,
  live,
  onConfirmationResolved,
  step,
  summary,
  task,
  tier,
  tierReason,
  toolCalls,
  waitingBehind,
}: TurnProps) => (
  <article className={styles.turn}>
    <UserMessage text={task} />

    {toolCalls.length > 0 && (
      <div className={styles.tools}>
        {toolCalls.map((call) => (
          <ToolCallCard call={call} key={call.callId} />
        ))}
      </div>
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
        {tier && (
          <div className={styles.footer}>
            <TierBadge reason={tierReason} tier={tier} />
          </div>
        )}
      </>
    )}
    {error && <div className={styles.error}>{error}</div>}
    {live && !summary && !error && <ThinkingIndicator step={step} waitingBehind={waitingBehind} />}
  </article>
);

import { useState } from "react";

import type { DueGroups, Person, PersonMoment, PersonOpenItem, PersonRow } from "../../lib/people.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { atLine, directionLabel, DUE_SECTIONS, dueOwnerLine, dueWhenLine, forTodayLabel, oneToOneLine, openCountLine } from "../../lib/people.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import own from "./PeopleView.module.css";

const NONE: PersonRow[] = [];
const NO_ONE: null | Person = null;
const NOTHING_DUE: DueGroups = { late: [], later: [], soon: [], undated: [] };

const day = (iso: null | string): string => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }) : "");
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const MomentLine = ({ moment }: { moment: null | PersonMoment }) =>
  moment ? (
    <div className={own.moment}>
      <q className={own.quote}>{moment.quote}</q>
      <span className={own.where}>
        {moment.meetingTitle}
        {moment.at && `, ${day(moment.at)}`}
        {atLine(moment.atMs) && ` · ${atLine(moment.atMs)}`}
      </span>
    </div>
  ) : null;

/**
 * One person (section 15, R7): what is open between you in both directions, what you have heard
 * lately, and your 1:1s, all from reviewed meeting claims. Swap corrects which way a promise runs.
 */
const PersonPage = ({ id, onBack }: { id: number; onBack: () => void }) => {
  const [person, reload, setPerson] = useResource(() => api.person(id).catch(() => NO_ONE), NO_ONE);
  const [error, setError] = useState("");

  if (!person) return <div className={styles.empty}>Loading…</div>;

  const swap = (o: PersonOpenItem): void => {
    setError("");
    // You owe them -> they owe you, and the other way round. A correction is a review, as on Knowledge.
    const body = o.direction === "you-owe" ? { owedTo: "me", owner: person.name, review: "accept" as const } : { owedTo: person.name, owner: "me", review: "accept" as const };
    void api
      .knowledgeReview(o.claimId, body)
      .then(reload)
      .catch((err: Error) => setError(err.message));
  };

  const section = (title: string, items: PersonOpenItem[]) =>
    items.length > 0 && (
      <section>
        <h2 className={own.subhead}>
          {title} ({items.length})
        </h2>
        {items.map((o) => (
          <div className={styles.card} key={o.claimId}>
            <div className={styles.body}>
              <div className={styles.title}>
                {o.text}
                {o.late && <span className={own.late}>late</span>}
              </div>
              {o.due && <div className={styles.meta}>due {day(o.due)}</div>}
              <MomentLine moment={o.moment} />
            </div>
            <button
              className={styles.button}
              onClick={() => swap(o)}
              title={o.inferred ? "Worked out from who spoke and who was there. Swap it if it is the other way round." : "Swap which way this runs."}
              type="button"
            >
              Swap
            </button>
          </div>
        ))}
      </section>
    );

  return (
    <div className={styles.page}>
      <PageHeader subtitle={[oneToOneLine(person.daysSince), person.nextOneToOne && `next: ${person.nextOneToOne.title}, ${when(person.nextOneToOne.at)}`].filter(Boolean).join(" · ")} title={person.name}>
        <button className={styles.button} onClick={onBack} type="button">
          All people
        </button>
        <button
          className={styles.button}
          onClick={() =>
            void api
              .setOnTeam(person.id, !person.onTeam)
              .then(setPerson)
              .catch((err: Error) => setError(err.message))
          }
          type="button"
        >
          {person.onTeam ? "Remove from my team" : "Add to my team"}
        </button>
      </PageHeader>
      {error && <div className={styles.error}>{error}</div>}
      {person.forToday.length > 0 && (
        <section>
          <h2 className={own.subhead}>For today</h2>
          <ol className={own.forToday}>
            {person.forToday.map((f) => (
              <li key={`${f.kind}-${f.claimId}`}>
                <span className={own.label}>{forTodayLabel(f.kind, person.name)}:</span> {f.text}
                {f.late && <span className={own.late}>late</span>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {person.open.length === 0 && <div className={styles.empty}>Nothing open between you.</div>}
      {section(directionLabel("you-owe", person.name), person.open.filter((o) => o.direction === "you-owe"))}
      {section(directionLabel("they-owe", person.name), person.open.filter((o) => o.direction === "they-owe"))}
      {person.heard.length > 0 && (
        <section>
          <h2 className={own.subhead}>Heard lately</h2>
          {person.heard.map((h) => (
            <div className={styles.card} key={h.claimId}>
              <div className={styles.body}>
                <div className={styles.title}>{h.text}</div>
                <div className={styles.meta}>{h.kind}</div>
                <MomentLine moment={h.moment} />
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

/**
 * People (section 15, R7): what is due and whose it is first (R12, Andrew's 2026-11-27 review: the
 * list of what is owed matters more than who), then everyone the knowledge store names, your team
 * first. Built from reviewed meeting claims only; nothing here collects anything about anyone.
 */
export const PeopleView = ({ initialId = null }: { initialId?: null | number }) => {
  const [people] = useResource(() => api.people().catch(() => NONE), NONE);
  const [due] = useResource(() => api.peopleDue().catch(() => NOTHING_DUE), NOTHING_DUE);
  const anyDue = DUE_SECTIONS.some((s) => due[s.key].length > 0);
  // Opened straight to someone from a 1:1 on Today's line (section 15, R9).
  const [open, setOpen] = useState<null | number>(initialId);

  if (open !== null) return <PersonPage id={open} key={open} onBack={() => setOpen(null)} />;

  return (
    <div className={styles.page}>
      <PageHeader subtitle="What is due and whose it is, then the people behind it. Built from meeting claims you reviewed." title="People" />
      <h2 className={own.subhead}>Due</h2>
      {!anyDue && <div className={styles.empty}>Nothing open either way.</div>}
      {DUE_SECTIONS.filter((s) => due[s.key].length > 0).map((s) => (
        <section key={s.key}>
          <h3 className={own.dueHead}>{s.label}</h3>
          {due[s.key].map((d) => (
            <button className={`${styles.card} ${styles.fullWidth}`} key={d.claimId} onClick={() => setOpen(d.personId)} type="button">
              <span className={styles.body}>
                <span className={styles.title}>{d.text}</span>
                <span className={styles.meta}>
                  {dueOwnerLine(d.direction, d.personName)}
                  {d.due && ` · ${dueWhenLine(d.due)}`}
                  {d.late && <span className={own.late}>late</span>}
                </span>
              </span>
            </button>
          ))}
        </section>
      ))}
      <h2 className={own.subhead}>People</h2>
      {people.length === 0 && <div className={styles.empty}>No one yet. People appear here as meetings are reviewed.</div>}
      {people.map((p) => (
        <button className={`${styles.card} ${styles.fullWidth}`} key={p.id} onClick={() => setOpen(p.id)} type="button">
          <span className={styles.body}>
            <span className={styles.title}>
              {p.name}
              {p.onTeam && <span className={own.team}>my team</span>}
            </span>
            <span className={styles.meta}>
              {openCountLine(p.youOwe, p.theyOwe)}
              {p.onTeam && ` · ${oneToOneLine(p.daysSince)}`}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
};

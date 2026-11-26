import type { KnowledgeEntity } from "../../lib/types.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

const NONE: KnowledgeEntity[] = [];

/**
 * People (PLAN-open-work section 15). For now, the people the knowledge store already names, from
 * meetings and claims you reviewed. A page for each person, with what is open between you, is R7;
 * until then this says so rather than pretending. Nothing here collects anything about anyone.
 */
export const PeopleView = () => {
  const [entities] = useResource(() => api.knowledgeEntities().catch(() => NONE), NONE);
  const people = entities.filter((e) => e.kind === "person").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={styles.page}>
      <PageHeader subtitle="The people your meetings and reviewed notes name. A page for each one, with what is open between you, comes next (section 15, R7)." title="People" />
      {people.length === 0 && <div className={styles.empty}>No one yet. People appear here as meetings are reviewed.</div>}
      {people.map((p) => (
        <div className={styles.card} key={p.id}>
          <div className={styles.body}>
            <div className={styles.title}>{p.name}</div>
            {p.aliases.length > 0 && <div className={styles.meta}>also {p.aliases.join(", ")}</div>}
          </div>
        </div>
      ))}
    </div>
  );
};

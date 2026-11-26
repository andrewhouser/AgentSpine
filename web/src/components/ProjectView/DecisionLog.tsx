import type { ProjectPage } from "../../lib/project-page.ts";

import { useResource } from "../../hooks/useResource.ts";
import { api } from "../../lib/api.ts";
import { raisedLine, riskLine, saidLine, waitingLine } from "../../lib/project-page.ts";
import list from "../ListPage/ListPage.module.css";
import { MomentLink } from "../Sources/Sources.tsx";
import styles from "./ProjectView.module.css";

const NONE: null | ProjectPage = null;

/**
 * A project's decision log (section 15, R8), from reviewed meeting claims only: what was decided and by
 * whom it was said, what keeps coming up unsettled, risks by who named them, and who is waiting on whom.
 * It never says anyone agreed: that is not recorded.
 */
export const DecisionLog = ({ projectId }: { projectId: number }) => {
  const [page] = useResource(() => api.projectPage(projectId).catch(() => NONE), NONE);
  if (!page) return <div className={list.empty}>Loading…</div>;
  const nothing = page.decided.length + page.open.length + page.risks.length + page.waiting.length === 0;
  return (
    <>
      {nothing && <div className={list.empty}>Nothing reviewed from this project's meetings yet.</div>}
      {page.decided.length > 0 && (
        <section>
          <h2 className={styles.subhead}>Decided ({page.decided.length})</h2>
          {page.decided.map((d) => (
            <div className={list.card} key={d.claimId}>
              <div className={list.body}>
                <div className={list.title}>{d.text}</div>
                <div className={list.meta}>{saidLine(d.saidBy, d.present)}</div>
                {d.moment && <MomentLink moment={d.moment} />}
              </div>
            </div>
          ))}
        </section>
      )}
      {page.open.length > 0 && (
        <section>
          <h2 className={styles.subhead}>Open ({page.open.length})</h2>
          {page.open.map((o) => (
            <div className={list.card} key={o.claimId}>
              <div className={list.body}>
                <div className={list.title}>{o.text}</div>
                <div className={list.meta}>{raisedLine(o.raisedIn)}</div>
                {o.last && <MomentLink moment={o.last} />}
              </div>
            </div>
          ))}
        </section>
      )}
      {page.risks.length > 0 && (
        <section>
          <h2 className={styles.subhead}>Risks ({page.risks.length})</h2>
          {page.risks.map((r) => (
            <div className={list.card} key={r.claimId}>
              <div className={list.body}>
                <div className={list.title}>{r.text}</div>
                <div className={list.meta}>{riskLine(r.times, r.namedBy)}</div>
              </div>
            </div>
          ))}
        </section>
      )}
      {page.waiting.length > 0 && (
        <section>
          <h2 className={styles.subhead}>Waiting ({page.waiting.length})</h2>
          {page.waiting.map((w) => (
            <div className={list.card} key={w.claimId}>
              <div className={list.body}>
                <div className={list.title}>{w.text}</div>
                <div className={list.meta}>
                  {waitingLine(w.direction, w.who)}
                  {w.due && ` · due ${new Date(w.due).toLocaleDateString([], { day: "numeric", month: "short" })}`}
                  {w.late && " · late"}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
};

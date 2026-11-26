import type { Project } from "../../lib/types.ts";

import styles from "../ListPage/ListPage.module.css";
import { PageHeader } from "../PageHeader/PageHeader.tsx";

interface ProjectsViewProps {
  onNewProject: () => void;
  onOpenProject: (id: number) => void;
  projects: Project[];
}

/**
 * Projects as a place (PLAN-open-work section 15). Each opens the project screen there is today;
 * the decision log, risks and who is waiting on whom are R8.
 */
export const ProjectsView = ({ onNewProject, onOpenProject, projects }: ProjectsViewProps) => (
  <div className={styles.page}>
    <PageHeader subtitle="Each one keeps its own conversations, sources and meetings, and runs inside it stay on the local model." title="Projects" />
    <div className={styles.toolbar}>
      <button className={`${styles.button} ${styles.primary}`} onClick={onNewProject} type="button">
        New project
      </button>
    </div>
    {projects.length === 0 && <div className={styles.empty}>No projects yet.</div>}
    {projects.map((p) => (
      <button className={`${styles.card} ${styles.fullWidth}`} key={p.id} onClick={() => onOpenProject(p.id)} type="button">
        <span className={styles.body}>
          <span className={styles.title}>{p.name}</span>
        </span>
      </button>
    ))}
  </div>
);

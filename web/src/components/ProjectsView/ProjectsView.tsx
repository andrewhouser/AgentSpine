import type { Project } from "../../lib/types.ts";

import styles from "../ListPage/ListPage.module.css";

interface ProjectsViewProps {
  onNewProject: () => void;
  onOpenProject: (id: number) => void;
  projects: Project[];
}

/**
 * Settings → Projects (a menu place until the 2026-11-27 review, section 15, R12). Each opens the
 * project's own screen, where it is renamed or deleted; a project thread's header links there too.
 */
export const ProjectsView = ({ onNewProject, onOpenProject, projects }: ProjectsViewProps) => (
  <section>
    <p className={styles.meta}>
      Each project keeps its own conversations, sources and meetings, and runs inside it stay on the local model.
    </p>
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
  </section>
);

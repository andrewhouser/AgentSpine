import type { ReactNode } from "react";

import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  children?: ReactNode;
  /** Inside a tab of another place (TabbedPlace): the place already has the title, so only the line under it shows. */
  compact?: boolean;
  subtitle?: string;
  title: string;
}

export const PageHeader = ({ children, compact, subtitle, title }: PageHeaderProps) =>
  compact ? (
    <header className={styles.compact}>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      {children}
    </header>
  ) : (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {children}
    </header>
  );

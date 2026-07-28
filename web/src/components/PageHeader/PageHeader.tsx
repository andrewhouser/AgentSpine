import type { ReactNode } from "react";

import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  children?: ReactNode;
  subtitle?: string;
  title: string;
}

export const PageHeader = ({ children, subtitle, title }: PageHeaderProps) => (
  <header className={styles.header}>
    <div>
      <h1 className={styles.title}>{title}</h1>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
    {children}
  </header>
);

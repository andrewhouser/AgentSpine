import type { ReactNode } from "react";

import { useState } from "react";

import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./TabbedPlace.module.css";

export interface PlaceTab {
  content: ReactNode;
  id: string;
  label: string;
}

/** The tab named in the address (?tab=add), so a refresh, a link or an old bookmark keeps its place. */
const tabFromUrl = (tabs: readonly PlaceTab[]): string => {
  const wanted = new URLSearchParams(window.location.search).get("tab");
  return tabs.find((t) => t.id === wanted)?.id ?? tabs[0].id;
};

/**
 * One menu place that holds two screens which used to be places of their own (the 2026-11-27 menu
 * review, PLAN-open-work section 15, R12): Heads-up holds the check-in, Knowledge holds the drop zone,
 * Activity holds the coding runs. Each screen keeps its own code and draws itself `embedded`.
 */
export const TabbedPlace = ({ subtitle, tabs, title }: { subtitle: string; tabs: readonly PlaceTab[]; title: string }) => {
  const [tab, setTab] = useState(() => tabFromUrl(tabs));

  const pick = (id: string): void => {
    setTab(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* the tab still switches; it just will not survive a refresh */
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader subtitle={subtitle} title={title} />
      <div aria-label={`${title} sections`} className={styles.tabs} role="tablist">
        {tabs.map((t) => (
          <button aria-selected={tab === t.id} className={styles.tab} key={t.id} onClick={() => pick(t.id)} role="tab" type="button">
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tabs.find((t) => t.id === tab)?.content}</div>
    </div>
  );
};

import { useMemo } from "react";

import { renderMarkdown } from "../../lib/markdown.ts";
import styles from "./Markdown.module.css";

interface MarkdownProps {
  text: string;
}

/**
 * The one place `dangerouslySetInnerHTML` is used, and it is safe for a specific reason:
 * `renderMarkdown` runs markdown-it with `html: false`, which escapes raw tags rather than
 * emitting them. See lib/markdown.ts — that setting is what makes this component sound,
 * and nothing else in the app should reach for this API.
 */
export const Markdown = ({ text }: MarkdownProps) => {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={styles.body} dangerouslySetInnerHTML={{ __html: html }} />;
};

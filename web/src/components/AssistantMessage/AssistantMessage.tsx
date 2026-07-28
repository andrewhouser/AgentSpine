import { Markdown } from "../Markdown/Markdown.tsx";
import styles from "./AssistantMessage.module.css";

interface AssistantMessageProps {
  text: string;
}

export const AssistantMessage = ({ text }: AssistantMessageProps) => (
  <div className={styles.row}>
    <Markdown text={text} />
  </div>
);

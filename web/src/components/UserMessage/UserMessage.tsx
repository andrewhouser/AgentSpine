import styles from "./UserMessage.module.css";

interface UserMessageProps {
  text: string;
}

export const UserMessage = ({ text }: UserMessageProps) => (
  <div className={styles.row}>
    <div className={styles.bubble}>{text}</div>
  </div>
);

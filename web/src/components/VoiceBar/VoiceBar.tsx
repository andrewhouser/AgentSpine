import type { VoiceSession } from "../../hooks/useVoiceSession.ts";
import type { VoiceStatus } from "../../lib/types.ts";
import type { VoiceSettings } from "../../lib/voiceSettings.ts";

import styles from "./VoiceBar.module.css";

interface VoiceBarProps {
  session: VoiceSession;
  settings: VoiceSettings;
  status: VoiceStatus;
}

/**
 * The state of hands-free mode, at a glance and from across a room.
 *
 * The one thing this must never do is be ambiguous about whether the microphone is live, so
 * the dot is lit in every state except off, and `off` names the reason when there is one
 * rather than showing a button that does nothing.
 */
export const VoiceBar = ({ session, settings, status }: VoiceBarProps) => {
  const { state } = session;
  const blocked = session.unavailable ?? (status.listenReady ? null : status.listenReason);

  const line = ((): string => {
    switch (state) {
      case "idle":
        return `Waiting for “${settings.wakeWord}”`;
      case "listening":
        if (session.userSpeaking) return "Hearing you…";
        return session.remaining === null ? "Listening…" : `Listening… closes in ${session.remaining}s`;
      case "speaking":
        return "Speaking…";
      case "thinking":
        return "Thinking…";
      default:
        return blocked ?? "Hands-free is off";
    }
  })();

  return (
    <div className={styles.bar}>
      <button
        aria-pressed={state !== "off"}
        className={`${styles.toggle} ${state !== "off" ? styles.toggleOn : ""}`}
        disabled={blocked !== null && state === "off"}
        onClick={() => (state === "off" ? void session.enable() : session.disable())}
        title={blocked ?? (state === "off" ? "Turn on hands-free listening" : "Turn off hands-free listening")}
        type="button"
      >
        <span className={`${styles.dot} ${styles[state]}`} />
        Hands-free
      </button>

      <span aria-live="polite" className={styles.line}>
        {line}
      </span>

      {state === "speaking" && (
        <button className={styles.stop} onClick={session.stopSpeaking} type="button">
          Stop
        </button>
      )}

      {state === "idle" && session.heard && <span className={styles.heard}>heard “{session.heard}”</span>}

      {state !== "off" && !status.speakReady && (
        <span className={styles.warn} title={status.speakReason}>
          replies won’t be spoken — {status.speakReason}
        </span>
      )}

      {session.error && <span className={styles.error}>{session.error}</span>}
    </div>
  );
};

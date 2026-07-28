import styles from "./TierPicker.module.css";

interface TierPickerProps {
  onChange: (tier: null | string) => void;
  /** The pinned tier for this thread, or null when the dispatcher decides each turn. */
  value: null | string;
}

/**
 * Pin a thread to one model, or leave it on automatic.
 *
 * The escape hatch, and it matters mostly in one direction: sizing is a regex and will not
 * recognise that *this particular* question is hard, so "use the good model for this whole
 * conversation" is a thing you occasionally need to say out loud. Pinning down to `fast` is
 * offered too, but is rarely worth it — the default model is a mixture-of-experts already
 * running within 20% of a small model's speed.
 */
const OPTIONS: { hint: string; label: string; value: null | string }[] = [
  { hint: "Size each turn automatically", label: "Auto", value: null },
  { hint: "Small local model — quick lookups", label: "Fast", value: "fast" },
  { hint: "Main local model", label: "Local", value: "standard" },
  { hint: "Cloud model — this leaves your machine", label: "Cloud", value: "deep" },
];

export const TierPicker = ({ onChange, value }: TierPickerProps) => (
  <div className={styles.picker}>
    {OPTIONS.map((o) => (
      <button
        className={`${styles.option} ${value === o.value ? styles.active : ""}`}
        key={o.label}
        onClick={() => onChange(o.value)}
        title={o.hint}
        type="button"
      >
        {o.label}
      </button>
    ))}
  </div>
);

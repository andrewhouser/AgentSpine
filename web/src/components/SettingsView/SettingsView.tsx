import { useEffect, useState } from "react";

import type { ThemeChoice } from "../../lib/preferences.ts";
import type { Memory, VoiceStatus } from "../../lib/types.ts";
import type { VoiceSettings } from "../../lib/voiceSettings.ts";

import { api } from "../../lib/api.ts";
import {
  readPreferences,
  savePreferences,
  SCALE_DEFAULT,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
} from "../../lib/preferences.ts";
import { resolveVoiceSettings, saveVoiceSettings, TIMEOUT_MAX, TIMEOUT_MIN } from "../../lib/voiceSettings.ts";
import { PageHeader } from "../PageHeader/PageHeader.tsx";
import styles from "./SettingsView.module.css";

const THEMES: { label: string; value: ThemeChoice }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export const SettingsView = () => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [policy, setPolicy] = useState<null | Record<string, unknown>>(null);
  const [query, setQuery] = useState("");
  // Read once, on mount. These live in localStorage rather than on the server because they
  // describe the screen you are reading on, not the assistant — see lib/preferences.ts.
  const [prefs, setPrefs] = useState(readPreferences);

  // Applied on every change rather than behind a Save button. There is nothing to validate
  // and nothing to fail, and seeing the result *is* the feedback — a preview that needed
  // confirming would just be a slower way to find out you had gone one step too far.
  const update = (next: Partial<typeof prefs>): void => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    savePreferences(merged);
  };

  useEffect(() => {
    void api.policy().then(setPolicy);
  }, []);

  // Voice: the server supplies the defaults and the live status; this browser's saved choice
  // wins over both. See lib/voiceSettings.ts.
  const [voiceStatus, setVoiceStatus] = useState<null | VoiceStatus>(null);
  const [voice, setVoice] = useState<null | VoiceSettings>(null);
  const [testing, setTesting] = useState(false);
  const [voiceError, setVoiceError] = useState<null | string>(null);

  useEffect(() => {
    void api
      .voiceStatus()
      .then((s) => {
        setVoiceStatus(s);
        setVoice(resolveVoiceSettings(s.defaults));
      })
      .catch(() => setVoiceStatus(null));
  }, []);

  const updateVoice = (next: Partial<VoiceSettings>): void => {
    if (!voice) return;
    const merged = { ...voice, ...next };
    setVoice(merged);
    saveVoiceSettings(merged);
  };

  const testVoice = (): void => {
    setTesting(true);
    setVoiceError(null);
    void api
      .speak(`Hello. You can call me ${voice?.wakeWord ?? "by name"}, and I will answer like this.`)
      .then(async (blob) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
      })
      .catch((err: Error) => setVoiceError(err.message))
      .finally(() => setTesting(false));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void api.listMemories(query || undefined).then(setMemories), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Retract one memory. Optimistic: drop it from the list immediately, and put it back if the
  // server rejects the delete, so a failed request doesn't silently look like a success.
  const forget = (id: number): void => {
    const prev = memories;
    setMemories((cur) => cur.filter((m) => m.id !== id));
    void api.deleteMemory(id).catch(() => setMemories(prev));
  };

  return (
    <div className={styles.page}>
      <PageHeader title="Settings" />

      <section>
        <h2 className={styles.subhead}>Appearance</h2>
        <p className={styles.note}>
          Kept in this browser rather than on the server, because these describe the screen
          you are reading on and not the assistant — the laptop and the monitor across the
          room are allowed different answers.
        </p>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Theme</span>
          <div aria-label="Theme" className={styles.segmented} role="group">
            {THEMES.map((option) => (
              <button
                aria-pressed={prefs.theme === option.value}
                className={`${styles.segment} ${prefs.theme === option.value ? styles.segmentOn : ""}`}
                key={option.value}
                onClick={() => update({ theme: option.value })}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className={styles.fieldHint}>
            {prefs.theme === "system"
              ? "Follows macOS, and switches with it while this page is open."
              : `Pinned to ${prefs.theme}, ignoring the system setting.`}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="ui-scale">
            Text size
          </label>
          <div className={styles.sliderRow}>
            <span className={styles.scaleMark}>A</span>
            <input
              className={styles.slider}
              id="ui-scale"
              max={SCALE_MAX}
              min={SCALE_MIN}
              onChange={(e) => update({ scale: Number(e.target.value) })}
              step={SCALE_STEP}
              type="range"
              value={prefs.scale}
            />
            <span className={styles.scaleMarkLarge}>A</span>
            <span className={styles.scaleValue}>{Math.round(prefs.scale * 100)}%</span>
            {prefs.scale !== SCALE_DEFAULT && (
              <button className={styles.reset} onClick={() => update({ scale: SCALE_DEFAULT })} type="button">
                Reset
              </button>
            )}
          </div>
          <span className={styles.fieldHint}>
            Scales text only — spacing and controls stay put, so the layout gets denser rather
            than merely larger. Starts from your browser's own font setting.
          </span>
        </div>
      </section>

      <section>
        <h2 className={styles.subhead}>Voice</h2>
        <p className={styles.note}>
          Hands-free mode on the chat page: say the wake word, talk, and hear the answer. Kept in this
          browser, like appearance — the wake word is a property of the room. The wake word is matched on
          what Whisper hears, so it can be any word, and the spellings below are how Whisper tends to
          write it.
        </p>

        {voiceStatus && voice && (
          <>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="voice-wake">
                Wake word
              </label>
              <input
                className={styles.search}
                id="voice-wake"
                onChange={(e) => {
                  // The spellings belong to a particular word. Left in place after the word
                  // changes they would keep waking it on the old name, silently — so changing the
                  // word drops them, and returning to the server's own word restores its list.
                  const word = e.target.value;
                  const home = word.trim().toLowerCase() === voiceStatus.defaults.wakeWord.toLowerCase();
                  updateVoice({ aliases: home ? voiceStatus.defaults.aliases.join(", ") : "", wakeWord: word });
                }}
                value={voice.wakeWord}
              />
              <span className={styles.fieldHint}>
                Only counts at the start or the very end of a sentence, so a name that comes up in passing
                does not wake it.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="voice-aliases">
                Also accept spellings
              </label>
              <input
                className={styles.search}
                id="voice-aliases"
                onChange={(e) => updateVoice({ aliases: e.target.value })}
                placeholder="Other spellings, separated by commas"
                value={voice.aliases}
              />
              <span className={styles.fieldHint}>
                If it ignores you, look at the “heard …” text beside the Hands-free button on the chat page
                and add whatever it wrote here.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.checkRow} htmlFor="voice-sounds">
                <input
                  checked={voice.soundsAlike}
                  id="voice-sounds"
                  onChange={(e) => updateVoice({ soundsAlike: e.target.checked })}
                  type="checkbox"
                />
                <span className={styles.fieldLabel}>Accept words that sound like it</span>
              </label>
              <span className={styles.fieldHint}>
                Whisper rarely spells a name the way you meant — “Gianna” comes back as “Jaina” or “Jayana”.
                On, it catches those, and also near-homophones like “Jane” or “Gina”. Off, only the spellings
                above count, and a name it writes differently is simply missed. A more distinctive wake
                word needs this far less.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="voice-timeout">
                Stay listening for
              </label>
              <div className={styles.sliderRow}>
                <input
                  className={styles.slider}
                  id="voice-timeout"
                  max={TIMEOUT_MAX}
                  min={TIMEOUT_MIN}
                  onChange={(e) => updateVoice({ timeoutSeconds: Number(e.target.value) })}
                  step={5}
                  type="range"
                  value={voice.timeoutSeconds}
                />
                <span className={styles.scaleValue}>{voice.timeoutSeconds}s</span>
              </div>
              <span className={styles.fieldHint}>
                How long it waits in silence after it finishes speaking before it goes back to waiting for
                the wake word. It does not run while the assistant is thinking or talking.
              </span>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Status</span>
              <span className={styles.fieldHint}>
                Listening: {voiceStatus.listenReady ? "ready" : voiceStatus.listenReason}.
                <br />
                Speaking ({voiceStatus.voice}): {voiceStatus.speakReady ? "ready" : voiceStatus.speakReason}.
              </span>
              <div className={styles.sliderRow}>
                <button
                  className={styles.segment}
                  disabled={!voiceStatus.speakReady || testing}
                  onClick={testVoice}
                  type="button"
                >
                  {testing ? "Speaking…" : "Test the voice"}
                </button>
                {voiceError && <span className={styles.fieldHint}>{voiceError}</span>}
              </div>
            </div>
          </>
        )}
        {!voiceStatus && <div className={styles.empty}>Voice status unavailable.</div>}
      </section>

      <section>
        <h2 className={styles.subhead}>Memory</h2>
        <p className={styles.note}>
          What it has learned about you. <code>reflection</code> memories are written automatically after
          each run; <code>preference</code> memories come from rejections you explained. Hover a row and
          click <code>×</code> to forget one that is wrong or stale. Standing facts you want it to always
          know belong in <code>profile.md</code>, which nothing automated writes to.
        </p>
        <input
          className={styles.search}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          value={query}
        />
        {memories.length === 0 && <div className={styles.empty}>No memories{query ? " match" : " yet"}.</div>}
        {memories.map((m) => (
          <div className={styles.memory} key={m.id}>
            <span className={styles.kind}>{m.kind}</span>
            <span className={styles.text}>{m.text}</span>
            <span className={styles.when}>{new Date(m.ts).toLocaleDateString()}</span>
            <button
              aria-label={`Forget: ${m.text}`}
              className={styles.forget}
              onClick={() => forget(m.id)}
              title="Forget this"
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2 className={styles.subhead}>Policy</h2>
        <p className={styles.note}>
          The security boundary — deny by default. Read-only here on purpose: this is the file that decides
          what the assistant may touch, so it is edited in <code>policy.json</code> on disk, not through a
          web form the agent's own API could reach. Changes take effect on the next run, no restart.
        </p>
        <pre className={styles.policy}>{policy ? JSON.stringify(policy, null, 2) : "Loading…"}</pre>
      </section>
    </div>
  );
};

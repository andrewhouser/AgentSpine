/**
 * Voice preferences — wake word, its spellings, and how long a conversation stays open.
 *
 * Kept in localStorage for the reason appearance is (see preferences.ts): these describe the
 * room you are sitting in. The wake word is the clearest case — the machine in the study and
 * the one in the kitchen can answer to different names without either having to know.
 *
 * What the server provides is only the *default* a browser with no saved choice starts from
 * (VOICE_* in .env). A saved value always wins, so editing .env never silently overrides what
 * someone set on the Settings page.
 */

export interface VoiceSettings {
  /** Other ways Whisper writes the wake word. It spells names creatively. */
  aliases: string;
  /** Also accept words that sound like the wake word. */
  soundsAlike: boolean;
  /** Seconds of silence after a reply before the conversation closes. */
  timeoutSeconds: number;
  wakeWord: string;
}

export interface VoiceDefaults {
  aliases: string[];
  soundsAlike: boolean;
  timeoutSeconds: number;
  wakeWord: string;
}

const KEY = "as_voice";

/**
 * Below 5s the window closes before you have finished thinking of the follow-up; above five
 * minutes it is an open microphone with extra steps.
 */
export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 300;

const clampTimeout = (value: number): number =>
  Number.isFinite(value) ? Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(value))) : 20;

export const resolveVoiceSettings = (defaults: VoiceDefaults): VoiceSettings => {
  const base: VoiceSettings = {
    aliases: defaults.aliases.join(", "),
    soundsAlike: defaults.soundsAlike,
    timeoutSeconds: clampTimeout(defaults.timeoutSeconds),
    wakeWord: defaults.wakeWord,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<VoiceSettings>;
    return {
      aliases: typeof saved.aliases === "string" ? saved.aliases : base.aliases,
      soundsAlike: typeof saved.soundsAlike === "boolean" ? saved.soundsAlike : base.soundsAlike,
      timeoutSeconds: saved.timeoutSeconds === undefined ? base.timeoutSeconds : clampTimeout(saved.timeoutSeconds),
      // An emptied wake word would mean nothing ever wakes the assistant and nothing says why.
      wakeWord: typeof saved.wakeWord === "string" && saved.wakeWord.trim() ? saved.wakeWord : base.wakeWord,
    };
  } catch {
    return base;
  }
};

export const saveVoiceSettings = (settings: VoiceSettings): void => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...settings, timeoutSeconds: clampTimeout(settings.timeoutSeconds) }),
    );
  } catch {
    // Unwritable storage: the choice lasts for this page load, which beats refusing it.
  }
};

export const splitAliases = (aliases: string): string[] =>
  aliases
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

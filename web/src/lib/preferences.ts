/**
 * Appearance preferences — theme and text scale.
 *
 * ## Why these live in localStorage and not on the server
 *
 * Everything else the dashboard shows is server state, so putting these next to it would be
 * the consistent-looking choice. It would also be wrong. Theme and text size are properties
 * of *the screen you are reading on*, not of the assistant: the 18-inch laptop and the
 * monitor across the room want different answers, and the same machine wants a different one
 * at midnight. A server-side preference would force one answer onto every viewer of a
 * dashboard that is explicitly designed to be opened from more than one.
 *
 * It also means no API surface, no migration, and no way for the agent's own API to change
 * how its dashboard looks.
 *
 * ## Why `system` resolves here rather than in CSS
 *
 * `global.css` used to carry `@media (prefers-color-scheme: dark)`. Supporting an explicit
 * override *and* keeping that media query needs four blocks — base light, media dark,
 * explicit light, explicit dark — which duplicates each palette. Resolving `system` to a
 * concrete `data-theme` attribute here leaves one copy of each. `index.html` runs the same
 * resolution inline before the first paint, so there is no flash of the wrong theme.
 */

export type ThemeChoice = "dark" | "light" | "system";

export interface Preferences {
  /** Multiplier on the root font size. 1 is the browser default. */
  scale: number;
  theme: ThemeChoice;
}

export const THEME_KEY = "as_theme";
export const SCALE_KEY = "as_scale";

/**
 * Scale bounds. Below 0.85 the 10px labels stop being legible and start being decoration;
 * above 1.4 the fixed padding around growing text gets genuinely cramped, which is the known
 * cost of scaling text without scaling spacing.
 */
export const SCALE_MIN = 0.85;
export const SCALE_MAX = 1.4;
export const SCALE_STEP = 0.05;
export const SCALE_DEFAULT = 1;

const clampScale = (value: number): number =>
  Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) : SCALE_DEFAULT;

const isTheme = (value: unknown): value is ThemeChoice =>
  value === "dark" || value === "light" || value === "system";

/** What is stored right now. Falls back to the defaults for anything unreadable. */
export const readPreferences = (): Preferences => {
  let theme: ThemeChoice = "system";
  let scale = SCALE_DEFAULT;
  try {
    const storedTheme = localStorage.getItem(THEME_KEY);
    if (isTheme(storedTheme)) theme = storedTheme;
    const storedScale = localStorage.getItem(SCALE_KEY);
    if (storedScale !== null) scale = clampScale(Number(storedScale));
  } catch {
    // Private browsing, or storage disabled. Defaults are a fine answer and this must never
    // be the reason the dashboard fails to load.
  }
  return { scale, theme };
};

/** The concrete theme a choice resolves to right now. */
export const resolveTheme = (choice: ThemeChoice): "dark" | "light" => {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

export const applyPreferences = ({ scale, theme }: Preferences): void => {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(theme);
  root.style.setProperty("--ui-scale", String(clampScale(scale)));
};

export const savePreferences = (prefs: Preferences): void => {
  try {
    localStorage.setItem(THEME_KEY, prefs.theme);
    localStorage.setItem(SCALE_KEY, String(clampScale(prefs.scale)));
  } catch {
    // Unwritable storage means the choice lasts for this session only, which is a much
    // better outcome than refusing to apply it.
  }
  applyPreferences(prefs);
};

/**
 * Follow the OS while the choice is `system`.
 *
 * Without this, picking `system` would only take effect on reload — and the case that
 * matters is the automatic light-to-dark switch at sunset happening while the dashboard is
 * open, which is precisely when nobody is going to reload it.
 *
 * Returns an unsubscribe function.
 */
export const watchSystemTheme = (getChoice: () => ThemeChoice): (() => void) => {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => {};
  const onChange = (): void => {
    if (getChoice() === "system") document.documentElement.dataset.theme = resolveTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

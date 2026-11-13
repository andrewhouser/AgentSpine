/** Limits and normalization mirrored from the server's `meetings/store.ts`, so what the UI shows is what gets stored. */
export const MAX_TAGS = 20;

/** Trimmed, lowercased, a leading "#" dropped, inner whitespace collapsed to "-". */
export const normalizeTag = (raw: string): string =>
  raw.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").slice(0, 40);

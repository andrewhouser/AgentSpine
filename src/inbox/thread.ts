/**
 * Pasted chats and email threads, parsed enough to keep who said what and when.
 *
 * Recognises the shapes people actually copy: `Priya: we ship Friday`, `[10:42] Priya: ...`, `10:42 Priya: ...`,
 * `Priya (10:42): ...`, and an email's `From:` and `Date:` header lines. Lines that fit none of them continue the
 * previous message. A paste with fewer than two recognised messages is plain text and is left exactly as it came.
 * Pure and dependency-free; nothing here reads or trusts what the thread says.
 */
export interface ThreadLine {
  speaker: null | string;
  text: string;
  ts: null | string;
}

export interface ParsedThread {
  author: null | string;
  docDate: null | string;
  lines: ThreadLine[];
  /** `Speaker [ts]: text`, one per message, or the original text when it is not a thread. */
  normalized: string;
  speakers: string[];
}

const TS = String.raw`\d{1,2}[:.]\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?`;
const LEADING_TS = new RegExp(String.raw`^\[?(${TS})\]?\s+([^:\n]{1,40}?):\s+(.*)$`);
const TRAILING_TS = new RegExp(String.raw`^([^:(\[\n]{1,40}?)\s*[\[(](${TS}[^\])]*)[\])]:\s*(.*)$`);
const PLAIN = /^([A-Z][\w.'’ -]{0,38}?):\s+(.*)$/;
// Words that start a line with a colon but are labels, not people.
const LABELS = new Set(["note", "notes", "subject", "re", "fwd", "to", "cc", "bcc", "date", "from", "sent", "todo", "action", "decision", "summary", "agenda", "http", "https"]);

const isoDate = (s: string): null | string => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};

export const parseThread = (raw: string): ParsedThread => {
  const text = raw.replace(/\r\n/g, "\n");
  let author: null | string = null;
  let docDate: null | string = null;
  const lines: ThreadLine[] = [];

  for (const line of text.split("\n")) {
    const header = /^(From|Date|Sent):\s*(.+)$/i.exec(line);
    if (header) {
      if (/^from$/i.test(header[1])) author ??= header[2].replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || null;
      else docDate ??= isoDate(header[2]);
      continue;
    }
    let m = LEADING_TS.exec(line);
    if (m) {
      lines.push({ speaker: m[2].trim(), text: m[3], ts: m[1] });
      continue;
    }
    m = TRAILING_TS.exec(line);
    if (m) {
      lines.push({ speaker: m[1].trim(), text: m[3], ts: m[2].trim() });
      continue;
    }
    m = PLAIN.exec(line);
    if (m && !LABELS.has(m[1].trim().toLowerCase())) {
      lines.push({ speaker: m[1].trim(), text: m[2], ts: null });
      continue;
    }
    // A continuation of the previous message, or a stray line before any.
    if (line.trim() && lines.length) lines[lines.length - 1].text += `\n${line.trim()}`;
    else if (line.trim()) lines.push({ speaker: null, text: line.trim(), ts: null });
  }

  const messages = lines.filter((l) => l.speaker);
  if (messages.length < 2) return { author, docDate, lines: [], normalized: raw.trim(), speakers: [] };
  const speakers = [...new Set(messages.map((l) => l.speaker as string))];
  const normalized = lines.map((l) => (l.speaker ? `${l.speaker}${l.ts ? ` [${l.ts}]` : ""}: ${l.text}` : l.text)).join("\n");
  return { author: author ?? speakers[0], docDate, lines, normalized, speakers };
};

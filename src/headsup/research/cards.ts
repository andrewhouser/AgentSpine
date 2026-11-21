/**
 * Research results ("cards") and the images that go with them.
 *
 * A card is structured data, not prose, so the web and iOS clients can draw it: a title, a price
 * if there is one, a thumbnail, and a link back to the page it came from. The model never writes
 * a card; code builds them from fetched pages (product.ts), which keeps a hostile page's words
 * out of anything that could act on them.
 *
 * Images are fetched and kept by the server, and the apps load them from the server. That keeps
 * a phone from contacting retailers directly (which tells each one your address and that you are
 * looking at gifts), and keeps hostile or broken image URLs away from the clients. What is kept is
 * decided by the bytes, never by the Content-Type the server claimed: only JPEG, PNG, GIF and WebP,
 * never SVG, which can carry script.
 */
import fs from "node:fs";
import path from "node:path";
import { ATTACHMENTS_DIR } from "../../config.ts";
import { rawDb } from "../../memory/store.ts";
import { safeGet } from "./net.ts";
import type { GetOpts } from "./net.ts";

export const IMAGE_MAX_BYTES = 1_500_000;
export const IMAGE_DIR = path.join(ATTACHMENTS_DIR, "headsup");

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS headsup_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    file TEXT NOT NULL,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS headsup_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headsup_id INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    host TEXT NOT NULL,
    image_id INTEGER,
    price_text TEXT,
    amount REAL,
    currency TEXT,
    note TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_headsup_cards_headsup ON headsup_cards (headsup_id, rank);
`);

/** The real format from the first bytes, or null. SVG and anything else is refused. */
export const sniffImage = (b: Buffer): null | { ext: string; mime: string } => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return { ext: "gif", mime: "image/gif" };
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
};

/** Download an image through the guarded fetcher and keep it. Returns its id, or null (never throws). */
export const cacheImage = async (url: string, getOpts: GetOpts = {}): Promise<null | number> => {
  const r = await safeGet(url, {
    accept: (ct) => ct.startsWith("image/") && !ct.includes("svg"),
    maxBytes: IMAGE_MAX_BYTES,
    onOverflow: "fail",
    timeoutMs: 10_000,
    ...getOpts,
  });
  if (!r.ok) return null;
  const kind = sniffImage(r.body);
  if (!kind) return null;
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const ins = rawDb
      .prepare("INSERT INTO headsup_images (source_url, mime, bytes, file, created) VALUES (?,?,?,?,?)")
      .run(url.slice(0, 2000), kind.mime, r.body.length, "pending", new Date().toISOString());
    const id = Number(ins.lastInsertRowid);
    const file = `${id}.${kind.ext}`;
    fs.writeFileSync(path.join(IMAGE_DIR, file), r.body);
    rawDb.prepare("UPDATE headsup_images SET file = ? WHERE id = ?").run(file, id);
    return id;
  } catch {
    return null;
  }
};

export interface ImageFile {
  bytes: Buffer;
  mime: string;
}

export const readImage = (id: number): ImageFile | null => {
  const row = rawDb.prepare("SELECT mime, file FROM headsup_images WHERE id = ?").get(id) as undefined | { file: string; mime: string };
  if (!row || row.file === "pending" || row.file !== path.basename(row.file)) return null;
  try {
    return { bytes: fs.readFileSync(path.join(IMAGE_DIR, row.file)), mime: row.mime };
  } catch {
    return null;
  }
};

export type CardKind = "gift" | "link" | "restaurant";

export interface NewCard {
  amount?: number;
  currency?: string;
  host: string;
  imageId?: null | number;
  kind: CardKind;
  note?: string;
  priceText?: string;
  title: string;
  url: string;
}

export interface CardRow {
  amount: null | number;
  currency: null | string;
  fetched_at: string;
  headsup_id: number;
  host: string;
  id: number;
  image_id: null | number;
  kind: CardKind;
  note: null | string;
  price_text: null | string;
  rank: number;
  title: string;
  url: string;
}

/** What a client sees: the image as a URL path the server serves, no internal ids beyond the card's. */
export interface CardView {
  amount: null | number;
  fetchedAt: string;
  host: string;
  id: number;
  imageUrl: null | string;
  kind: CardKind;
  note: null | string;
  priceText: null | string;
  title: string;
  url: string;
}

export const toCardView = (c: CardRow): CardView => ({
  amount: c.amount,
  fetchedAt: c.fetched_at,
  host: c.host,
  id: c.id,
  imageUrl: c.image_id ? `/api/headsups/images/${c.image_id}` : null,
  kind: c.kind,
  note: c.note,
  priceText: c.price_text,
  title: c.title,
  url: c.url,
});

export const cardsFor = (headsupId: number): CardRow[] =>
  rawDb.prepare("SELECT * FROM headsup_cards WHERE headsup_id = ? ORDER BY rank").all(headsupId) as unknown as CardRow[];

/** Remove a headsup's cards and the images only they used. Called before a re-run, and when the headsup goes. */
export const deleteCardsFor = (headsupId: number): void => {
  const imgs = rawDb.prepare("SELECT DISTINCT image_id AS id FROM headsup_cards WHERE headsup_id = ? AND image_id IS NOT NULL").all(headsupId) as unknown as { id: number }[];
  rawDb.prepare("DELETE FROM headsup_cards WHERE headsup_id = ?").run(headsupId);
  for (const { id } of imgs) {
    const row = rawDb.prepare("SELECT file FROM headsup_images WHERE id = ?").get(id) as undefined | { file: string };
    if (row && row.file === path.basename(row.file)) fs.rmSync(path.join(IMAGE_DIR, row.file), { force: true });
    rawDb.prepare("DELETE FROM headsup_images WHERE id = ?").run(id);
  }
};

/** Replace a headsup's cards with a fresh set, in the order given. */
export const replaceCards = (headsupId: number, cards: NewCard[], now: Date = new Date()): void => {
  deleteCardsFor(headsupId);
  const stmt = rawDb.prepare(
    "INSERT INTO headsup_cards (headsup_id, rank, kind, title, url, host, image_id, price_text, amount, currency, note, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  cards.forEach((c, i) =>
    stmt.run(headsupId, i, c.kind, c.title, c.url, c.host, c.imageId ?? null, c.priceText ?? null, c.amount ?? null, c.currency ?? null, c.note ?? null, now.toISOString()),
  );
};

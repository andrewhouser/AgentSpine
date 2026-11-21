/**
 * Retention for Heads-up (docs/archive/PLAN-heads-up-next.md workstream E).
 *
 * Research results were never cleaned up: `replaceCards` removes a heads-up's photos only when it
 * is researched AGAIN, so finished items kept up to six photos of up to 1.5 MB each forever.
 *
 * What goes, and when (measured from when the item ended, which is its `updated` stamp: every move
 * to done, expired or dismissed writes it):
 *
 *   - Cards and photos of a done, expired or dismissed heads-up: 30 days.
 *   - Ended watches: 30 days.
 *   - The ledger row itself, once it is done, expired or dismissed: 400 days. Long on purpose, so
 *     next year's birthday still knows it was answered or muted.
 *   - Image files with no row, and image rows with no file or no card: removed.
 *
 * What never goes: `headsup_mutes` and `headsup_dates`. Those are what you told it, not what it
 * found, and deleting one would quietly undo a "never" you said two years ago.
 *
 * Outcomes (workstream B's `headsup_outcomes`) are not pruned here because that table does not
 * exist yet; add it to this file when B lands, at 400 days.
 *
 * Never throws: a tidy-up that did not happen is not a reason to take the dashboard down.
 */
import fs from "node:fs";
import path from "node:path";
import { rawDb } from "../memory/store.ts";
import { deleteCardsFor, IMAGE_DIR } from "./research/cards.ts";

export const CARD_RETENTION_DAYS = 30;
export const WATCH_RETENTION_DAYS = 30;
export const LEDGER_RETENTION_DAYS = 400;

const ENDED = "('done','expired','dismissed')";

export interface HeadsupPruneResult {
  cardSets: number;
  ledger: number;
  orphanFiles: number;
  orphanImageRows: number;
  watches: number;
}

const ago = (now: Date, days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

export const pruneHeadsup = (now: Date = new Date()): HeadsupPruneResult => {
  const out: HeadsupPruneResult = { cardSets: 0, ledger: 0, orphanFiles: 0, orphanImageRows: 0, watches: 0 };
  try {
    // Cards and photos first, so a ledger row removed below never leaves them pointing at nothing.
    const cardIds = rawDb
      .prepare(
        `SELECT DISTINCT h.id FROM headsups h JOIN headsup_cards c ON c.headsup_id = h.id
          WHERE h.state IN ${ENDED} AND h.updated < ?`,
      )
      .all(ago(now, CARD_RETENTION_DAYS)) as unknown as { id: number }[];
    for (const { id } of cardIds) deleteCardsFor(id);
    out.cardSets = cardIds.length;

    out.watches = Number(
      rawDb.prepare("DELETE FROM headsup_watches WHERE ended_at IS NOT NULL AND ended_at < ?").run(ago(now, WATCH_RETENTION_DAYS)).changes,
    );

    const old = rawDb
      .prepare(`SELECT id FROM headsups WHERE state IN ${ENDED} AND updated < ?`)
      .all(ago(now, LEDGER_RETENTION_DAYS)) as unknown as { id: number }[];
    for (const { id } of old) {
      deleteCardsFor(id);
      rawDb.prepare("DELETE FROM headsup_watches WHERE headsup_id = ?").run(id);
      rawDb.prepare("DELETE FROM headsups WHERE id = ?").run(id);
    }
    out.ledger = old.length;

    // Image rows nothing points at, or whose file has gone.
    const images = rawDb.prepare("SELECT id, file FROM headsup_images").all() as unknown as { file: string; id: number }[];
    for (const img of images) {
      const used = rawDb.prepare("SELECT 1 AS x FROM headsup_cards WHERE image_id = ? LIMIT 1").get(img.id);
      const present = img.file === path.basename(img.file) && fs.existsSync(path.join(IMAGE_DIR, img.file));
      if (used && present) continue;
      if (present) fs.rmSync(path.join(IMAGE_DIR, img.file), { force: true });
      if (!present) rawDb.prepare("UPDATE headsup_cards SET image_id = NULL WHERE image_id = ?").run(img.id);
      rawDb.prepare("DELETE FROM headsup_images WHERE id = ?").run(img.id);
      out.orphanImageRows++;
    }
    // Files on disk no row knows about.
    if (fs.existsSync(IMAGE_DIR)) {
      const known = new Set((rawDb.prepare("SELECT file FROM headsup_images").all() as unknown as { file: string }[]).map((r) => r.file));
      for (const f of fs.readdirSync(IMAGE_DIR)) {
        if (known.has(f)) continue;
        fs.rmSync(path.join(IMAGE_DIR, f), { force: true });
        out.orphanFiles++;
      }
    }
  } catch (err) {
    console.warn(`[headsup] prune failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
};

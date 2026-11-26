import { useState } from "react";

import type { AroundLine, TurnSources } from "../../lib/moments.ts";
import type { PersonMoment } from "../../lib/people.ts";

import { api, meetingAudioUrl } from "../../lib/api.ts";
import { notFoundLine } from "../../lib/moments.ts";
import { atLine } from "../../lib/people.ts";
import styles from "./Sources.module.css";

/**
 * Where a moment was said, with the way back to it (section 15, R4 and R5): the transcript a minute
 * either side, always, and playback from that second while the recording is still kept. The quote
 * and transcript are other people's words: shown as text, never sent anywhere.
 */
export const MomentLink = ({ moment }: { moment: PersonMoment }) => {
  const [lines, setLines] = useState<AroundLine[] | null>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div className={styles.moment}>
      <q className={styles.quote}>{moment.quote}</q>
      <div className={styles.where}>
        <span>
          {moment.meetingTitle}
          {moment.speaker && ` · ${moment.speaker}`}
          {atLine(moment.atMs) && ` · ${atLine(moment.atMs)}`}
        </span>
        {moment.atMs !== null && (
          <button
            className={styles.link}
            onClick={() => (lines ? setLines(null) : void api.meetingAround(moment.meetingId, moment.atMs ?? 0).then(setLines).catch(() => setLines([])))}
            type="button"
          >
            {lines ? "Hide transcript" : "Transcript around it"}
          </button>
        )}
        {moment.audio && moment.atMs !== null && (
          <button className={styles.link} onClick={() => setPlaying((p) => !p)} type="button">
            {playing ? "Stop" : "Play from here"}
          </button>
        )}
      </div>
      {playing && (
        // The media fragment seeks to the second; the server answers Range requests, so the browser can.
        <audio autoPlay controls src={`${meetingAudioUrl(moment.meetingId)}#t=${Math.floor((moment.atMs ?? 0) / 1000)}`} />
      )}
      {lines && (
        <div className={styles.around}>
          {lines.length === 0 && <div className={styles.dim}>No transcript is kept for this moment.</div>}
          {lines.map((l) => (
            <p className={l.here ? styles.here : undefined} key={l.startMs}>
              <span className={styles.who}>{l.speaker ?? "?"}</span> {l.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};

/** A turn's sources: each claim with its moment, and the part nothing recorded. */
export const Sources = ({ sources }: { sources: TurnSources }) => (
  <div aria-label="Sources" className={styles.sources}>
    {sources.notFound.length > 0 && <div className={styles.notFound}>{notFoundLine(sources.notFound)}</div>}
    {sources.claims.map((c) => (
      <div className={styles.claim} key={c.claimId}>
        <div className={styles.text}>
          {c.text}
          {!c.reviewed && <span className={styles.lead}>lead, not reviewed</span>}
        </div>
        {c.moment && <MomentLink moment={c.moment} />}
      </div>
    ))}
  </div>
);

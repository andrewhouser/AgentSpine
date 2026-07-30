/**
 * Follow the live meeting stream.
 *
 * Unlike `useRunStream` this is not scoped to an id and never completes. There is one
 * microphone, so there is one stream, and it stays open across the gap between one meeting
 * ending and the next beginning — which is what lets the Record button reflect reality
 * without polling for it.
 *
 * Reconnection is by `seq`, same as runs: the hook remembers the last event it saw and
 * reopens with `?after=`, so a dropped connection resumes mid-meeting rather than losing
 * the words that arrived while it was down.
 */
import { useEffect, useRef, useState } from "react";

import type { CoachAnswer, ContextCards, MeetingEvent, MeetingStatus } from "../lib/types.ts";

import { meetingStreamUrl } from "../lib/api.ts";

export interface LiveLine {
  key: number;
  startMs: number;
  text: string;
}

export interface LiveMeeting {
  /** The most recent coaching answer, or null if the hotkey has not been pressed. */
  answer: CoachAnswer | null;
  /** Retrieved context for what is being said now. Null until the first refresh lands. */
  cards: ContextCards | null;
  /** True while the model is working on an answer. */
  coaching: boolean;
  /** The most recent error, or null. Transcription failing one chunk is not fatal. */
  error: null | string;
  lines: LiveLine[];
  meetingId: null | number;
  note: null | string;
  status: MeetingStatus | null;
}

const EMPTY: LiveMeeting = {
  answer: null,
  cards: null,
  coaching: false,
  error: null,
  lines: [],
  meetingId: null,
  note: null,
  status: null,
};

/**
 * Lines are capped. A three-hour meeting is thousands of segments and the browser only ever
 * shows the tail; the full transcript is in SQLite and is what the meeting page reads.
 */
const MAX_LINES = 400;

/**
 * @param onStatus called when a meeting starts, stops, finishes transcribing, or finishes
 * being extracted from. It receives the event, because those are four different things and
 * the extraction ones are about a meeting that may not be the one on screen.
 */
export const useMeetingStream = (onStatus?: (event: MeetingEvent) => void): LiveMeeting => {
  const [live, setLive] = useState<LiveMeeting>(EMPTY);
  const lastSeq = useRef(-1);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;

    const open = (): void => {
      source = new EventSource(meetingStreamUrl(lastSeq.current));

      source.onmessage = (message) => {
        const event = JSON.parse(message.data) as MeetingEvent;
        lastSeq.current = event.seq;

        setLive((prev) => {
          if (event.kind === "segment" && event.segment) {
            // A new meeting clears the previous one's words rather than appending to them.
            const lines =
              prev.meetingId === event.meetingId
                ? [...prev.lines, { key: event.seq, startMs: event.segment.startMs, text: event.segment.text }]
                : [{ key: event.seq, startMs: event.segment.startMs, text: event.segment.text }];
            return {
              ...prev,
              lines: lines.slice(-MAX_LINES),
              meetingId: event.meetingId,
            };
          }
          if (event.kind === "error") return { ...prev, error: event.note ?? "transcription error" };
          // Extraction belongs to a different lifecycle: it runs minutes after a meeting is
          // already `done`, so letting it write `note` and `status` here would overwrite
          // "final transcript: 412 segments" with progress about something else. It is
          // delivered to the subscriber below instead, and changes nothing on the deck.
          if (event.kind === "extraction") return prev;
          if (event.kind === "context") return { ...prev, cards: event.cards ?? null };
          if (event.kind === "coach")
            return {
              ...prev,
              // The previous answer stays up while the next generates. Blanking it would
              // clear the panel for exactly the five seconds you are most likely to be
              // reading it — a follow-up was asked, and the old notes are still the best
              // thing available until the new ones arrive.
              answer: event.answer ?? prev.answer,
              coaching: event.thinking === true,
            };
          return {
            // Cards and answers belong to the meeting that was being recorded; a new one
            // starts blank rather than showing what was retrieved during the last.
            answer: prev.meetingId === event.meetingId ? prev.answer : null,
            cards: prev.meetingId === event.meetingId ? prev.cards : null,
            coaching: prev.meetingId === event.meetingId ? prev.coaching : false,
            error: null,
            lines: prev.meetingId === event.meetingId ? prev.lines : [],
            meetingId: event.meetingId,
            note: event.note ?? null,
            status: event.status ?? prev.status,
          };
        });

        if (event.kind === "status" || event.kind === "extraction") onStatusRef.current?.(event);
      };

      // EventSource reconnects on its own but restarts from scratch; we want to resume from
      // `lastSeq`, so the connection is replaced by hand instead.
      source.onerror = () => {
        source?.close();
        if (!closed) retry = window.setTimeout(open, 1500);
      };
    };

    open();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);

  return live;
};

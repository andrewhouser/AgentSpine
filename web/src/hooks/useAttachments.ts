/**
 * Images staged in the composer, on their way to a message.
 *
 * ## Uploading happens on choosing, not on sending
 *
 * A photograph is megabytes and the server may convert it (HEIC comes off a phone and has to
 * become JPEG before anything can read it). Doing that when Send is pressed would put a
 * multi-second pause between the click and the turn appearing, which reads as the assistant
 * being slow rather than the file being large. So a file starts uploading the moment it is
 * chosen, while the question is still being typed, and Send only carries the ids.
 *
 * ## The preview is local, and it is shown immediately
 *
 * The thumbnail comes from `URL.createObjectURL` on the file in hand, not from the server
 * round-trip. Someone who pastes a screenshot sees it in the composer in the same frame, and
 * the upload finishing changes nothing they can see. Those object URLs are revoked when the
 * item goes away and when the component unmounts — a leaked one holds the whole image in
 * memory for the life of the tab, which for a thread full of photographs is real.
 *
 * ## Nothing is retried automatically
 *
 * An upload that fails leaves the item in place with its reason on it, and Send stays
 * available for the rest. A refused image is nearly always refused for a reason that will not
 * change on a second attempt — wrong format, too large, no `sips` to convert HEIC — and a
 * silent retry loop would turn a clear message into a spinner.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Attachment, VisionStatus } from "../lib/types.ts";

import { api } from "../lib/api.ts";

export interface PendingAttachment {
  /** The stored row, once the upload has landed. Null while it is still in flight. */
  attachment: Attachment | null;
  error: null | string;
  /** Stable local identity — the server id does not exist yet when this is first rendered. */
  key: string;
  name: string;
  previewUrl: string;
  status: "error" | "ready" | "uploading";
}

export interface UseAttachments {
  add: (files: File[]) => void;
  /** True when the endpoint that reads images is configured; false hides every affordance. */
  available: boolean;
  clear: () => void;
  items: PendingAttachment[];
  /** The images that actually landed, ready to be sent with a message. */
  ready: Attachment[];
  /** How many more images this message may carry. */
  remaining: number;
  remove: (key: string) => void;
  status: null | VisionStatus;
  uploading: boolean;
}

let counter = 0;
const nextKey = (): string => `att-${Date.now()}-${counter++}`;

export const useAttachments = (conversationId: number): UseAttachments => {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [status, setStatus] = useState<null | VisionStatus>(null);

  // Every object URL this hook has created, so unmount can revoke the ones still live.
  const urls = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api
      .visionStatus()
      .then((s) => !cancelled && setStatus(s))
      // A failure here means the attach button stays hidden, which is the safe direction:
      // better no button than a button that uploads into a server with no eyes.
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // Revoke on unmount only. Per-item revocation happens in `remove` and `clear`, where the
  // item is actually going away — doing it in an effect keyed on `items` would revoke a URL
  // that is still on screen during the render that added the next one.
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  const forget = useCallback((url: string): void => {
    if (!urls.current.has(url)) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  }, []);

  const remove = useCallback(
    (key: string): void => {
      setItems((current) => {
        const going = current.find((i) => i.key === key);
        if (going) forget(going.previewUrl);
        return current.filter((i) => i.key !== key);
      });
    },
    [forget],
  );

  const clear = useCallback((): void => {
    setItems((current) => {
      for (const i of current) forget(i.previewUrl);
      return [];
    });
  }, [forget]);

  const add = useCallback(
    (files: File[]): void => {
      const images = files.filter((f) => f.type.startsWith("image/") || /\.(hei[cf])$/i.test(f.name));
      if (!images.length) return;

      // The cap is the server's, read from /api/vision, so the two cannot disagree about how
      // many images a turn may carry.
      const max = status?.maxImages ?? 4;

      setItems((current) => {
        const room = Math.max(0, max - current.length);
        const taking = images.slice(0, room);

        const staged = taking.map((file): PendingAttachment => {
          const previewUrl = URL.createObjectURL(file);
          urls.current.add(previewUrl);
          const key = nextKey();

          void api
            .uploadAttachment(conversationId, file, file.name)
            .then((saved) =>
              setItems((list) =>
                list.map((i) => (i.key === key ? { ...i, attachment: saved, status: "ready" as const } : i)),
              ),
            )
            .catch((err: Error) =>
              setItems((list) =>
                list.map((i) => (i.key === key ? { ...i, error: err.message, status: "error" as const } : i)),
              ),
            );

          return { attachment: null, error: null, key, name: file.name, previewUrl, status: "uploading" };
        });

        return [...current, ...staged];
      });
    },
    [conversationId, status?.maxImages],
  );

  return {
    add,
    available: status?.configured === true,
    clear,
    items,
    ready: items.map((i) => i.attachment).filter((a): a is Attachment => a !== null),
    remaining: Math.max(0, (status?.maxImages ?? 4) - items.length),
    remove,
    status,
    uploading: items.some((i) => i.status === "uploading"),
  };
};

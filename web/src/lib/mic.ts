/**
 * Why this page cannot use the browser's microphone, or null when it can.
 *
 * `getUserMedia` is absent entirely outside a secure context, so this is a real check rather
 * than a guess: over plain HTTP from another machine on the LAN it is simply not there, and
 * no permission prompt will ever appear. Only HTTPS or localhost brings it back.
 */
export const browserMicReason = (): null | string =>
  typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined
    ? null
    : "this browser only allows microphone access over HTTPS or localhost";

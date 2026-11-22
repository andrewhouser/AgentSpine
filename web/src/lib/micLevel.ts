/**
 * One bar of the dictation waveform: a microphone level in decibels (0 is full scale) mapped to
 * 0..1. Below the floor is silence; the square root lifts quiet speech, which sits around -35 dB
 * and would otherwise draw as a flat line. The same rule as `MicLevel` in
 * `ios/AgentSpine/Core/TurnHelpers.swift`, tested against the same cases.
 */
export const MIC_FLOOR_DB = -50;

export const micLevel = (decibels: number): number => {
  if (!Number.isFinite(decibels) || decibels <= MIC_FLOOR_DB) return 0;
  return Math.min(1, Math.sqrt(1 - decibels / MIC_FLOOR_DB));
};

/** The level of one buffer of time-domain samples (-1..1), in decibels: 20·log10 of the RMS. */
export const rmsDecibels = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(sum / samples.length));
};

/** Keep the last `count` levels, newest last, so the waveform scrolls from right to left. */
export const pushLevel = (levels: readonly number[], level: number, count: number): number[] =>
  [...levels, level].slice(-count);

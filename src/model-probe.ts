/**
 * Is the model host answering, and how fast? Behind the Mac sidebar's "Model host connected
 * 14 ms" line (via /api/status).
 *
 * It asks `GET <base>/models`, the one route every OpenAI-compatible server (mlx_lm.server
 * included) answers without loading or running a model, so a probe costs nothing on the host.
 * The result is cached for ten seconds: several windows poll /api/status every thirty, and the
 * model host should not hear from each of them.
 *
 * A slow host is not a dead one, so the timeout is generous enough to ride out a busy prefill
 * on the M4 but short enough that /api/status, which the app also uses to decide the server
 * itself is reachable, never hangs behind it.
 */

export type ModelHostStatus = {
  /** Round trip in milliseconds; null when the host did not answer. */
  ms: null | number;
  ok: boolean;
};

const TIMEOUT_MS = 1500;
const CACHE_MS = 10_000;

const cache = new Map<string, { at: number; status: ModelHostStatus }>();

export const probeModelHost = async (
  baseURL: string,
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<ModelHostStatus> => {
  const now = opts.now ?? Date.now;
  const hit = cache.get(baseURL);
  if (hit && now() - hit.at < CACHE_MS) return hit.status;

  const started = now();
  let status: ModelHostStatus;
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    // Any HTTP answer means the host is up; a 401 or 404 is still a machine that replied.
    status = { ms: Math.max(1, now() - started), ok: res.status < 500 };
  } catch {
    status = { ms: null, ok: false };
  }
  cache.set(baseURL, { at: now(), status });
  return status;
};

/** For tests. */
export const clearModelProbeCache = (): void => cache.clear();

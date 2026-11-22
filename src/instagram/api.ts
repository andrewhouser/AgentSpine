/**
 * Meta's Instagram API with Instagram Login, the handful of calls this app needs.
 *
 * Written against the documentation as read on 2026-11-22 (developers.facebook.com,
 * instagram-platform: content-publishing, reference/me, reference/instagram-media and its
 * insights edge, reference/refresh_access_token, and the ig-user and ig-container pages).
 * The host is graph.instagram.com, the version is pinned in rules.ts, and no Facebook Page is
 * involved. Scopes: instagram_business_basic for everything read here,
 * instagram_business_content_publish for the two writes, instagram_business_manage_insights
 * for insights.
 *
 * There are exactly two writes, `createImageContainer` and `publishContainer`, and there is no
 * delete, no comment, no message and no profile edit. The request helper is typed to GET and
 * POST so that adding one is a visible change (test/architecture.test.mjs pins the method set
 * and the endpoints).
 *
 * The one idea every caller leans on is `ambiguous`. A request that timed out, lost its
 * connection or came back as a 5xx may or may not have been carried out. For a read that is
 * just a failure. For `publishContainer` it means "this may be on the grid already", and the
 * runner must find out before it does anything else. A 4xx with Meta's error object is the
 * opposite: a definite no.
 *
 * The token goes in an Authorization header, so it is never part of a URL that could end up
 * in a log. The refresh call is the exception Meta documents (the token is a query parameter
 * there), and its URL is never put in an error message.
 */
import { API_TIMEOUT_MS, GRAPH_HOST, GRAPH_VERSION } from "./rules.ts";

export interface FetchInit {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
}
export interface FetchResponse {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers?: { get(name: string): null | string };
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}
/** The slice of `fetch` used here, so a test can stand in for Meta. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export class InstagramApiError extends Error {
  /** The request may have been carried out. Never retry a write on this without reconciling. */
  ambiguous: boolean;
  code: null | number;
  httpStatus: null | number;
  subcode: null | number;
  constructor(message: string, o: { ambiguous: boolean; code?: null | number; httpStatus?: null | number; subcode?: null | number }) {
    super(message);
    this.name = "InstagramApiError";
    this.ambiguous = o.ambiguous;
    this.code = o.code ?? null;
    this.httpStatus = o.httpStatus ?? null;
    this.subcode = o.subcode ?? null;
  }
}

/** Codes from the error-codes reference that the runner treats specially. */
export const ERR = {
  /** code 9007 / subcode 2207027: the container is not ready to publish yet. */
  notReady: (e: InstagramApiError): boolean => e.code === 9007 || e.subcode === 2207027,
  /** code 24 / 2207008 and code -2 / 2207020: the container is gone or expired. Make a new one. */
  containerGone: (e: InstagramApiError): boolean => e.subcode === 2207008 || e.subcode === 2207020,
  /** code 9 / 2207042: the account's publishing quota is used up. */
  quota: (e: InstagramApiError): boolean => e.subcode === 2207042,
  /** code 10 on a story: "Not enough viewers for the media to show insights". */
  tooFewViewers: (e: InstagramApiError): boolean => e.code === 10,
};

export type ContainerStatus = "ERROR" | "EXPIRED" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";
const CONTAINER_STATUSES: readonly string[] = ["ERROR", "EXPIRED", "FINISHED", "IN_PROGRESS", "PUBLISHED"];

export interface Account {
  accountType: null | string;
  userId: string;
  username: string;
}
export interface MediaItem {
  id: string;
  mediaType: null | string;
  permalink: null | string;
  /** ISO 8601 UTC as Meta sends it ("2019-09-26T22:36:43+0000"), or null when not returned. */
  timestamp: null | string;
}
export interface PublishingLimit {
  durationSec: null | number;
  total: null | number;
  used: number;
}

export interface ClientOptions {
  fetch?: FetchLike;
  host?: string;
  timeoutMs?: number;
  /** Returns the bearer token, or null when there is none. Called per request, never cached here. */
  token: () => null | string;
  version?: string;
}

export interface InstagramClient {
  containerStatus(containerId: string): Promise<{ detail: null | string; statusCode: ContainerStatus }>;
  createImageContainer(igUserId: string, o: { caption?: string; imageUrl: string; story?: boolean }): Promise<string>;
  me(): Promise<Account>;
  media(mediaId: string): Promise<MediaItem>;
  mediaInsights(mediaId: string, metrics: readonly string[]): Promise<Record<string, null | number>>;
  publishContainer(igUserId: string, containerId: string): Promise<string>;
  publishingLimit(igUserId: string): Promise<PublishingLimit>;
  recentMedia(igUserId: string, sinceUnix: number): Promise<MediaItem[]>;
  recentStories(igUserId: string): Promise<MediaItem[]>;
  refreshToken(): Promise<{ accessToken: string; expiresInSec: null | number }>;
}

const ID = /^[A-Za-z0-9_]+$/;
const needId = (what: string, v: string): string => {
  if (!ID.test(String(v ?? ""))) throw new InstagramApiError(`${what} is not a valid id`, { ambiguous: false });
  return v;
};

const num = (v: unknown): null | number => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): null | string => (typeof v === "string" && v ? v : null);

export const createClient = (opts: ClientOptions): InstagramClient => {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<FetchResponse>);
  const base = `${opts.host ?? GRAPH_HOST}/${opts.version ?? GRAPH_VERSION}`;
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;

  /**
   * One request. `what` names the call for error text, since the URL may not be shown.
   * `tokenInQuery` exists for the refresh endpoint alone.
   */
  const call = async (
    method: "GET" | "POST",
    what: string,
    url: string,
    params: Record<string, string>,
    o: { tokenInQuery?: boolean } = {},
  ): Promise<any> => {
    const token = opts.token();
    if (!token) throw new InstagramApiError(`${what}: no Instagram token is stored`, { ambiguous: false });
    const headers: Record<string, string> = {};
    const query = new URLSearchParams(method === "GET" ? params : {});
    if (o.tokenInQuery) query.set("access_token", token);
    else headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params);
    }
    const qs = query.toString();

    let res: FetchResponse;
    let text: string;
    try {
      res = await doFetch(qs ? `${url}?${qs}` : url, { body, headers, method, signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (err) {
      // No answer at all. The reason is kept short and never includes the URL.
      const why = err instanceof Error && err.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : "the connection failed";
      throw new InstagramApiError(`${what}: ${why}`, { ambiguous: true });
    }

    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below: a body that is not JSON is not an answer */
    }
    const e = json?.error;
    if (e && typeof e === "object") {
      throw new InstagramApiError(`${what}: ${String(e.message ?? "error").slice(0, 300)}`, {
        // Meta answered with its own error object, so the call was refused, unless it is a server-side fault.
        ambiguous: res.status >= 500,
        code: num(e.code),
        httpStatus: res.status,
        subcode: num(e.error_subcode),
      });
    }
    if (!res.ok || json == null) {
      throw new InstagramApiError(`${what}: HTTP ${res.status} with no usable body`, {
        ambiguous: res.status >= 500 || json == null,
        httpStatus: res.status,
      });
    }
    return json;
  };

  /** The docs print some single objects inside `{"data":[...]}` and some bare. Accept both. */
  const one = (json: any): any => (Array.isArray(json?.data) ? (json.data[0] ?? {}) : json);

  const item = (m: any): MediaItem => ({
    id: String(m?.id ?? ""),
    mediaType: str(m?.media_type),
    permalink: str(m?.permalink),
    timestamp: str(m?.timestamp),
  });

  const MEDIA_FIELDS = "id,media_type,permalink,timestamp";

  /**
   * A listing, with each item's fields filled in. The reference shows the list edges returning
   * bare ids and documents fields on the media object itself, so when an item comes back
   * without a timestamp it is read one by one. Capped, because this only ever looks for a post
   * made in the last few minutes.
   */
  const listing = async (what: string, url: string, params: Record<string, string>): Promise<MediaItem[]> => {
    const json = await call("GET", what, url, { ...params, fields: MEDIA_FIELDS });
    const items = (Array.isArray(json?.data) ? json.data : []).slice(0, 10).map(item).filter((m: MediaItem) => m.id);
    const out: MediaItem[] = [];
    for (const m of items) out.push(m.timestamp ? m : await client.media(m.id));
    return out;
  };

  const client: InstagramClient = {
    me: async () => {
      const j = one(await call("GET", "account check", `${base}/me`, { fields: "user_id,username,account_type" }));
      const userId = str(j?.user_id) ?? (num(j?.user_id) != null ? String(j.user_id) : null);
      const username = str(j?.username);
      if (!userId || !username) throw new InstagramApiError("account check: the answer had no user_id or username", { ambiguous: false });
      return { accountType: str(j?.account_type), userId, username };
    },

    createImageContainer: async (igUserId, o) => {
      const params: Record<string, string> = { image_url: o.imageUrl };
      // Stories take no caption through the API ("Publishing stickers ... is not supported", and
      // no caption parameter is documented for them), so one is never sent.
      if (o.story) params.media_type = "STORIES";
      else if (o.caption) params.caption = o.caption;
      const j = await call("POST", "create container", `${base}/${needId("account id", igUserId)}/media`, params);
      const id = str(j?.id);
      if (!id) throw new InstagramApiError("create container: the answer had no id", { ambiguous: true });
      return id;
    },

    containerStatus: async (containerId) => {
      const j = await call("GET", "container status", `${base}/${needId("container id", containerId)}`, { fields: "status_code,status" });
      const code = String(j?.status_code ?? "");
      if (!CONTAINER_STATUSES.includes(code)) {
        throw new InstagramApiError(`container status: unknown status_code "${code.slice(0, 40)}"`, { ambiguous: true });
      }
      return { detail: str(j?.status), statusCode: code as ContainerStatus };
    },

    publishContainer: async (igUserId, containerId) => {
      const j = await call("POST", "publish", `${base}/${needId("account id", igUserId)}/media_publish`, {
        creation_id: needId("container id", containerId),
      });
      const id = str(j?.id);
      // A 200 with no id is not a refusal. Whether the post exists is unknown until reconciled.
      if (!id) throw new InstagramApiError("publish: the answer had no media id", { ambiguous: true });
      return id;
    },

    publishingLimit: async (igUserId) => {
      const j = one(
        await call("GET", "publishing limit", `${base}/${needId("account id", igUserId)}/content_publishing_limit`, {
          fields: "quota_usage,config",
        }),
      );
      return { durationSec: num(j?.config?.quota_duration), total: num(j?.config?.quota_total), used: num(j?.quota_usage) ?? 0 };
    },

    media: async (mediaId) =>
      item(await call("GET", "media lookup", `${base}/${needId("media id", mediaId)}`, { fields: MEDIA_FIELDS })),

    recentMedia: (igUserId, sinceUnix) =>
      listing("recent media", `${base}/${needId("account id", igUserId)}/media`, { since: String(Math.floor(sinceUnix)) }),

    // Documented for Facebook Login only as of 2026-11-22. Used solely to recover a story's media
    // id after an unknown publish outcome, and a failure here is survivable: the row is still
    // marked published, just without an id.
    recentStories: (igUserId) => listing("recent stories", `${base}/${needId("account id", igUserId)}/stories`, {}),

    mediaInsights: async (mediaId, metrics) => {
      const j = await call("GET", "media insights", `${base}/${needId("media id", mediaId)}/insights`, { metric: metrics.join(",") });
      const out: Record<string, null | number> = {};
      // "Missing data returns an empty data set, not 0": a metric that is not in the answer is
      // unknown, and it is stored as null so it can never be read as a real zero.
      for (const name of metrics) out[name] = null;
      for (const row of Array.isArray(j?.data) ? j.data : []) {
        const name = String(row?.name ?? "");
        if (!(name in out)) continue;
        out[name] = num(row?.values?.[0]?.value) ?? num(row?.total_value?.value);
      }
      return out;
    },

    refreshToken: async () => {
      const j = await call("GET", "token refresh", `${opts.host ?? GRAPH_HOST}/refresh_access_token`, { grant_type: "ig_refresh_token" }, { tokenInQuery: true });
      const accessToken = str(j?.access_token);
      if (!accessToken) throw new InstagramApiError("token refresh: the answer had no token", { ambiguous: false });
      return { accessToken, expiresInSec: num(j?.expires_in) };
    },
  };
  return client;
};

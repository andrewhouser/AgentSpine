/**
 * The Meta client (src/instagram/api.ts), with Meta played by a function.
 *
 * What matters here is not that a URL is assembled but three properties the runner leans on:
 *
 *   1. The requests are the documented ones (host, version, path, parameters), so a change to
 *      any of them is a failing test and not a surprise on a Friday.
 *   2. `ambiguous` is right. A timeout, a dropped connection, a 5xx or a 200 with no id means
 *      "this may have happened"; a 4xx with Meta's error object means "this did not". The
 *      no-duplicate rule is built on that one bit.
 *   3. The token never appears in a URL or an error message, the refresh call's query excepted.
 *
 * Run with `node test/instagram-api.test.mjs`. No network.
 */
import { checker, isolate } from "./instagram-fixtures.mjs";

isolate("ig-api");
const { ERR, InstagramApiError, createClient } = await import("../src/instagram/api.ts");
const { check, done } = checker(70);

const TOKEN = "IGAAsecret-token-value";

/** A fetch that answers from a script and remembers what it was asked. */
const meta = (answer) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {}, method: init?.method, url });
    const a = typeof answer === "function" ? answer(url, init, calls.length) : answer;
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  f.calls = calls;
  return f;
};
const client = (f, token = TOKEN) => createClient({ fetch: f, token: () => token });
const caught = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

console.log("\ninstagram api client\n");

console.log("verify the account");
{
  const f = meta({ body: { data: [{ account_type: "Business", user_id: "1784", username: "djhouserlive" }] }, status: 200 });
  const me = await client(f).me();
  check("GET graph.instagram.com/v27.0/me with the three fields", f.calls[0].url, "https://graph.instagram.com/v27.0/me?fields=user_id%2Cusername%2Caccount_type");
  check("method is GET", f.calls[0].method, "GET");
  check("the token rides in the Authorization header", f.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  check("and never in the URL", f.calls[0].url.includes(TOKEN), false);
  check("the wrapped answer the docs print is read", me, { accountType: "Business", userId: "1784", username: "djhouserlive" });
  const flat = await client(meta({ body: { user_id: 1784, username: "djhouserlive" }, status: 200 })).me();
  check("a bare object is read too, numeric id included", [flat.userId, flat.accountType], ["1784", null]);
  const none = await caught(client(meta({ body: { data: [{}] }, status: 200 })).me());
  check("an answer with no username is an error, not a blank account", none instanceof InstagramApiError, true);
}

console.log("\ncreate a container");
{
  const f = meta({ body: { id: "C100" }, status: 200 });
  const id = await client(f).createImageContainer("1784", { caption: "Hello\n#breaks", imageUrl: "https://media.example.test/a.jpg" });
  check("returns the container id", id, "C100");
  check("POST /{ig-id}/media", [f.calls[0].method, f.calls[0].url], ["POST", "https://graph.instagram.com/v27.0/1784/media"]);
  check("body is image_url and caption, verbatim", f.calls[0].body, { image_url: "https://media.example.test/a.jpg", caption: "Hello\n#breaks" });
  check("JSON content type", f.calls[0].headers["Content-Type"], "application/json");
  const s = meta({ body: { id: "C101" }, status: 200 });
  await client(s).createImageContainer("1784", { caption: "ignored", imageUrl: "https://media.example.test/s.jpg", story: true });
  check("a Story sends media_type STORIES and no caption", s.calls[0].body, { image_url: "https://media.example.test/s.jpg", media_type: "STORIES" });
  const bad = meta({ body: { id: "C1" }, status: 200 });
  const e = await caught(client(bad).createImageContainer("1784/../me", { imageUrl: "https://x.test/a.jpg" }));
  check("an account id that is not an id is refused before any request", [e instanceof InstagramApiError, bad.calls.length], [true, 0]);
}

console.log("\ncontainer status");
{
  for (const code of ["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]) {
    const f = meta({ body: { id: "C1", status_code: code }, status: 200 });
    check(`reads ${code}`, (await client(f).containerStatus("C1")).statusCode, code);
  }
  const f = meta({ body: { id: "C1", status_code: "FINISHED" }, status: 200 });
  await client(f).containerStatus("C1");
  check("GET /{container-id}?fields=status_code,status", f.calls[0].url, "https://graph.instagram.com/v27.0/C1?fields=status_code%2Cstatus");
  const odd = await caught(client(meta({ body: { status_code: "SOMETHING_NEW" }, status: 200 })).containerStatus("C1"));
  check("a status this code does not know is not guessed at", [odd instanceof InstagramApiError, odd?.ambiguous], [true, true]);
}

console.log("\npublish");
{
  const f = meta({ body: { id: "M500" }, status: 200 });
  check("returns the media id", await client(f).publishContainer("1784", "C100"), "M500");
  check("POST /{ig-id}/media_publish with creation_id", [f.calls[0].method, f.calls[0].url, f.calls[0].body], ["POST", "https://graph.instagram.com/v27.0/1784/media_publish", { creation_id: "C100" }]);
}

console.log("\nambiguous or definite: the bit the runner retries on");
{
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const cases = [
    ["a timeout", timeout, true],
    ["a dropped connection", new Error("ECONNRESET"), true],
    ["a 500 with Meta's error object", { body: { error: { code: 2, message: "Service temporarily unavailable" } }, status: 500 }, true],
    ["a 502 with an HTML body", { body: "<html>bad gateway</html>", status: 502 }, true],
    ["a 200 with no id", { body: {}, status: 200 }, true],
    ["a 200 that is not JSON", { body: "ok", status: 200 }, true],
    ["a 400 with Meta's error object", { body: { error: { code: 9, error_subcode: 2207042, message: "limit reached" } }, status: 400 }, false],
    ["a 200 carrying an error object", { body: { error: { code: 100, message: "bad param" } }, status: 200 }, false],
  ];
  for (const [label, answer, ambiguous] of cases) {
    const e = await caught(client(meta(answer)).publishContainer("1784", "C100"));
    check(`${label} is ${ambiguous ? "AMBIGUOUS" : "a definite no"}`, [e instanceof InstagramApiError, e?.ambiguous], [true, ambiguous]);
  }
  const e = await caught(client(meta({ body: { error: { code: 9007, error_subcode: 2207027, message: "Media ID is not available" } }, status: 400 })).publishContainer("1784", "C1"));
  check("code and subcode are kept", [e.code, e.subcode, e.httpStatus], [9007, 2207027, 400]);
  check("9007 / 2207027 reads as not ready", ERR.notReady(e), true);
  const gone = await caught(client(meta({ body: { error: { code: 24, error_subcode: 2207008, message: "gone" } }, status: 400 })).publishContainer("1784", "C1"));
  check("24 / 2207008 reads as container gone", ERR.containerGone(gone), true);
  const quota = await caught(client(meta({ body: { error: { code: 9, error_subcode: 2207042, message: "limit" } }, status: 400 })).publishContainer("1784", "C1"));
  check("9 / 2207042 reads as quota used up", ERR.quota(quota), true);
}

console.log("\nthe token stays out of sight");
{
  const noToken = meta({ body: { id: "x" }, status: 200 });
  const e = await caught(client(noToken, null).me());
  check("no token: an error, and no request at all", [e instanceof InstagramApiError, e?.ambiguous, noToken.calls.length], [true, false, 0]);
  const leak = await caught(client(meta({ body: { error: { code: 190, message: `Invalid OAuth access token ${"x".repeat(400)}` } }, status: 400 })).me());
  check("Meta's message is cut to a sane length", leak.message.length < 340, true);
  const f = meta({ body: { access_token: "IGAAnew", expires_in: 5183944, token_type: "bearer" }, status: 200 });
  const r = await client(f).refreshToken();
  check("refresh returns the new token and its lifetime", r, { accessToken: "IGAAnew", expiresInSec: 5183944 });
  check("refresh is GET /refresh_access_token?grant_type=ig_refresh_token (no version)", f.calls[0].url.startsWith("https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token="), true);
  check("refresh sends no Authorization header, as documented", f.calls[0].headers.Authorization, undefined);
  const failed = await caught(client(meta(new Error(`connect failed for https://graph.instagram.com/refresh_access_token?access_token=${TOKEN}`))).refreshToken());
  check("a failed refresh does not put the URL or token in its message", failed.message.includes(TOKEN) || failed.message.includes("http"), false);
}

console.log("\npublishing limit and recent media");
{
  const f = meta({ body: { data: [{ config: { quota_duration: 86400, quota_total: 50 }, quota_usage: 2 }] }, status: 200 });
  check("quota is read from data[0]", await client(f).publishingLimit("1784"), { durationSec: 86400, total: 50, used: 2 });
  check("GET /{ig-id}/content_publishing_limit", f.calls[0].url, "https://graph.instagram.com/v27.0/1784/content_publishing_limit?fields=quota_usage%2Cconfig");

  const listed = meta({ body: { data: [{ id: "M1", media_type: "IMAGE", permalink: "https://www.instagram.com/p/a/", timestamp: "2026-12-01T17:00:05+0000" }] }, status: 200 });
  const items = await client(listed).recentMedia("1784", 1796144400.9);
  check("recent media asks with since and the fields", listed.calls[0].url, "https://graph.instagram.com/v27.0/1784/media?since=1796144400&fields=id%2Cmedia_type%2Cpermalink%2Ctimestamp");
  check("and returns id, type, link and time", items, [{ id: "M1", mediaType: "IMAGE", permalink: "https://www.instagram.com/p/a/", timestamp: "2026-12-01T17:00:05+0000" }]);

  // The reference shows list edges returning bare ids. Then each id is read on its own.
  const bare = meta((url) =>
    url.includes("/1784/media")
      ? { body: { data: [{ id: "M7" }] }, status: 200 }
      : { body: { id: "M7", media_type: "IMAGE", permalink: "https://www.instagram.com/p/b/", timestamp: "2026-12-01T17:00:09+0000" }, status: 200 },
  );
  const filled = await client(bare).recentMedia("1784", 0);
  check("a list of bare ids is filled in one by one", [bare.calls.length, filled[0].timestamp], [2, "2026-12-01T17:00:09+0000"]);
  check("the per-item read is GET /{media-id} with fields", bare.calls[1].url, "https://graph.instagram.com/v27.0/M7?fields=id%2Cmedia_type%2Cpermalink%2Ctimestamp");
}

console.log("\ninsights");
{
  const f = meta({
    body: {
      data: [
        { name: "reach", period: "lifetime", values: [{ value: 120 }] },
        { name: "views", period: "lifetime", values: [{ value: 0 }] },
        { name: "shares", total_value: { value: 3 } },
        { name: "something_else", values: [{ value: 9 }] },
      ],
    },
    status: 200,
  });
  const m = await client(f).mediaInsights("M1", ["reach", "views", "saved", "shares", "comments"]);
  check("GET /{media-id}/insights?metric=...", f.calls[0].url, "https://graph.instagram.com/v27.0/M1/insights?metric=reach%2Cviews%2Csaved%2Cshares%2Ccomments");
  check("returned values are kept, a real zero included", [m.reach, m.views, m.shares], [120, 0, 3]);
  check("a metric Meta left out is null, never 0", [m.saved, m.comments], [null, null]);
  check("a metric that was not asked for is ignored", "something_else" in m, false);
  const few = await caught(client(meta({ body: { error: { code: 10, message: "(#10) Not enough viewers for the media to show insights" } }, status: 400 })).mediaInsights("M1", ["reach"]));
  check("code 10 reads as too few viewers", ERR.tooFewViewers(few), true);
}

done();

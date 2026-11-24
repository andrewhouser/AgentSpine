# Instagram publishing

Scheduled image posts to one Instagram professional account, with results reported once a week.
Built 2026-11-22 for one show's account (written here as @exampleshow). The content comes from a
marketing kit you keep in your own repo (a folder of images plus a weekly plan).

**Status: built and tested against a mocked API. It has never called Meta.** No Meta app exists,
no token is stored, no image is hosted, and nothing has been published. It is off until
`policy.json` gains an `instagram` section, and even then it is a dry run until that section says
`"publish": true`.

## The decision this records

Until now the write frontier was draft-not-send (SPEC section 5). This is the first capability
that puts something in front of the public, and a post cannot be taken back from the people who
saw it. So:

- **Dry run is the default.** `instagram.enabled` switches on the queue, the dry run, account
  checks and insights. `instagram.publish` must be exactly `true` to post. Anything else, a
  missing key included, reports what would be posted and posts nothing. The global
  `autoExecute.dryRun` overrides it.
- **A person approves the exact post.** Approval is bound to a digest of the account, surface,
  caption, image URL, image bytes and timing. Re-seed with an edited caption or a re-rendered
  image and the approval is void.
- **The model chooses no content.** The tools take a row id. No argument carries a caption, a
  URL or a time.
- **Approving and publishing are irreversible-tier and queue even from a scheduled run**
  (`confirmWhenUnattended`), for the reason `schedule.ts` gives: an approved row is standing
  work an unattended runner will act on. Taking an approval back is reversible and immediate.
- **The runner is code only.** No model is in the publish path. It runs on the server's clock.
- **The token** is 0600 in `~/.config/agentspine/instagram-token.json`, named only by
  `src/instagram/token.ts`. It is never in `policy.json`, the database, a queue row or a log.
- **There are exactly two writes** in the API client: create a container, publish a container.
  No delete, comment, message or profile call exists.
- **A project run does not inherit Instagram.** `narrowPolicy` switches it off unless the
  project's overlay opts in.

`test/architecture.test.mjs` pins the token, the two writes and the claim-before-publish order.

## How it works

| Piece | File | What it does |
|---|---|---|
| Numbers | `src/instagram/rules.ts` | API version, lead time, windows, ceilings, insight ages |
| API client | `src/instagram/api.ts` | The Meta calls, and whether a failure is ambiguous or definite |
| Token | `src/instagram/token.ts` | The only reader and writer of the token file |
| Queue | `src/instagram/queue.ts` | Tables, seeding, approval, compare-and-set status changes |
| Runner | `src/instagram/runner.ts` | The publish pipeline and the reconcile rule |
| Results | `src/instagram/insights.ts` | Insight pulls and the weekly digest |
| Clock | `src/instagram/index.ts` | What `server.ts` calls each minute; token refresh and storing |
| CLI | `src/instagram/cli.ts` | `npm run instagram -- <command>` |
| Tools | `src/tools/instagram.ts` | `instagram_status`, `instagram_approve`, `instagram_publish`, `instagram_insights` |

### The queue

One row per dated occurrence: a post on one surface (feed or Story) at one moment. The row id is
slot, post and surface, for example `2026-11-27T12:00/S14/feed`. A row holds the post id, caption,
image path, public image URL, image sha256, publish time (the local text, its zone, and the UTC
instant), the window end, the approval, the status, the container id and the published media id.
Tables `instagram_posts` and `instagram_insights` live in `spine.db`.

Statuses: `pending`, `container` (a container exists on Meta's side), `publishing` (a publish was
sent and its outcome is not recorded), `published`, `skipped`, `failed`.

Seeding reads the kit's `instagram-posts.json` and a plan of dated occurrences
(`instagram-plan.json`, next to it). Every row arrives unapproved: the `approved` field in the
kit's JSON is ignored. Seeding checks each image (JPEG, under 8 MB, feed aspect 4:5 to 1.91:1)
and each caption (2200 characters, 30 hashtags, 20 mentions), and a row with a problem cannot be
approved. Seeding never rewrites a row that has left `pending`.

### The runner

Each minute, for approved rows only:

1. Five minutes before the slot it checks that the token belongs to the account in `policy.json`,
   that Meta's publishing quota and this install's own ceiling (6 a day) have room, and that the
   file at the public URL is byte for byte the approved image. Then it creates the container.
   Containers expire after 24 hours, which is why they are not made when a week is staged.
2. At the slot it reads the container's status and, if `FINISHED`, claims the row as `publishing`
   and writes the attempt time, then sends the publish.
3. A row past its window is marked `skipped`. It is never published late.

**The retry rule.** A publish whose outcome is unknown (timeout, dropped connection, 5xx, a crash
between the claim and the answer) is never sent again until it is reconciled. Reconciling asks
Meta for the container's `status_code`: `PUBLISHED` means it went out, so it is recorded and left;
`FINISHED` means it did not, and the same container is published again after a two minute wait;
`EXPIRED` or `ERROR` means it never will, and only then may a new container be made. If Meta
cannot be asked, the row stays `publishing` and nothing is sent, for as long as that lasts. The
worst case is one post, late. It is never two.

**Windows.** Countdown posts get 4 hours, show-day posts 3, dated flyers 24, everything else 12,
unless the plan gives `expires` or `window_minutes`. The plan sets "one hour out" to 45 minutes
and the dated flyers to end at show time.

**Live now.** A row with `require_live` gets no early container and is held until
`instagram.liveStatusUrl` answers with `status.state == "live"`. `starting_soon`, an error, or no
URL configured are all a no. If the stream never comes up the row is skipped when its window ends.
Note that DJLive's `forceLive` feature flag makes that page say live.

**Holds.** A problem that needs you (wrong account, no token, hosted image differs, quota) leaves
the row where it is and pushes one notification per row per reason. Expected holds (the stream is
not live yet) and skips do not push; they are in the digest.

### Results

Feed posts are sampled at about 24 hours and about 7 days: reach, views, saves, shares, comments.
A Story is sampled once at about 20 hours (reach, views, shares), because Meta keeps Story metrics
for 24 hours only. Each snapshot stores the age it was really taken at. A value Meta does not
return is stored as null and shown as `n/a`, never as 0. One digest goes out through `notify` on
Sunday at 5pm (the server's local time): what was posted with its numbers, what was not and why,
what next week still needs approved, and a warning when the token is within 10 days of expiring.

## Setup: what is left for you

Nothing below has been done. In order:

1. **Confirm the account type.** @exampleshow (your account) must be a professional account (Business or
   Creator). No Facebook Page is needed for this API.
2. **Create the Meta app.** At developers.facebook.com create an app of type Business, add the
   Instagram product, and open "API setup with Instagram business login". Add your account to
   the app there (the Dashboard walks through it). Permissions:
   `instagram_business_basic`, `instagram_business_content_publish`,
   `instagram_business_manage_insights`. Standard Access covers an account you own, so no App
   Review.
3. **Host the images.** Upload the JPEGs to a public https location, keeping the kit's paths
   under one base URL, so that `<base>/images/show/S01-new-here.jpg` resolves. The R2 bucket
   DJLive already uses is the obvious place, under its own prefix. Serve them as `image/jpeg`
   and unmodified: a CDN that resizes or re-encodes changes the bytes, and the runner will hold
   the post because the sha256 no longer matches. Stories need `images/show/stories/` (and a stories folder for any
   other product you post about) too.
4. **Deploy and enable, without publishing.** On the Mini run `./update.sh`, then add to
   `policy.json`:

   ```json
   "instagram": {
     "enabled": true,
     "account": "exampleshow",
     "liveStatusUrl": "https://example.com/api/status"
   }
   ```

   The policy is read each minute, so no restart is needed for this edit.
5. **Store the token.** In the App Dashboard press "Generate token" next to the account, copy it,
   and on the Mini run `pbpaste | npm run instagram -- token`. It checks the token is for the
   account in `policy.json` before writing it, and refuses otherwise. Then
   `npm run instagram -- verify`. The token lasts 60 days and is refreshed by the runner at 30
   as long as the service is running.
6. **Seed the queue** from the djlive checkout:

   ```
   npm run instagram -- seed --posts <djlive>/docs/marketing/instagram-posts.json \
     --plan <djlive>/docs/marketing/instagram-plan.json --base-url https://<host>/<prefix>/
   ```

7. **Read the dry run.** `npm run instagram -- dry-run --limit 5` prints the exact image, caption,
   account and due time for the next rows and what the runner would do with each. Add
   `--at "2026-11-27 18:00"` to move the clock.
8. **One test post.** Approve a single row (`npm run instagram -- approve <id>`), set
   `"publish": true` in the `instagram` section, and watch it go out at its slot. Check it on
   Instagram and with `npm run instagram -- list`.
9. **Then a week at a time.** Approve the rows you have read. Approval is per row, so enabling
   publishing never makes an unread draft publishable. To stop everything at once, remove
   `"publish": true`.

Each week after that: render the new dated flyer in djlive, add its occurrences to
`instagram-plan.json`, upload the image, seed again, approve.

## Commands

```
npm run instagram -- dry-run [--limit N] [--at "YYYY-MM-DD HH:mm"]
npm run instagram -- seed --posts <file> --plan <file> [--base-url https://...]
npm run instagram -- list | show <id> | approve <id...> | revoke <id...> | skip <id> [reason]
npm run instagram -- token      (reads the token from stdin)
npm run instagram -- verify
node test/instagram-api.test.mjs      (also -queue, -runner, -insights, -tool)
```

## What Meta's documentation said (read 2026-11-22)

Host `graph.instagram.com`, version `v27.0`.

| Call | Request |
|---|---|
| Verify account | `GET /me?fields=user_id,username,account_type` |
| Create container | `POST /{ig-id}/media` with `image_url`, `caption`; a Story adds `media_type=STORIES` and takes no caption |
| Container status | `GET /{container-id}?fields=status_code,status`: `EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS`, `PUBLISHED` |
| Publish | `POST /{ig-id}/media_publish` with `creation_id` |
| Quota | `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` |
| Insights | `GET /{media-id}/insights?metric=reach,views,saved,shares,comments` |
| Refresh token | `GET /refresh_access_token?grant_type=ig_refresh_token` (token at least 24 hours old) |

Things to know:

- JPEG is the only image format. 8 MB. The image URL must be public; Meta fetches it.
- Stories cannot carry link, poll or location stickers through the API. The calendar's "Live now
  with a link sticker" therefore stays a by-hand post unless you accept it without the sticker.
- The docs disagree with themselves on the publishing limit (50 in three places, 100 in one). The
  runner reads the live `quota_total` and also has its own ceiling.
- `impressions` is deprecated for media made after 2 July 2024; `views` replaces it.
- Insight data can lag by up to 48 hours. A Story with fewer than five viewers returns error 10
  in place of numbers; that is stored as "too few viewers".

## Not verified against the live API

These could not be settled from the documentation and only matter for one thing: recovering a
media id after a publish whose answer was lost. Each fails safe (the post is still recorded as
published, without an id, and so without insights).

- Whether `GET /{ig-id}/media` accepts `fields=` inline. If it returns bare ids the client reads
  each one separately.
- `GET /{ig-id}/stories` is documented for Facebook Login only.
- Whether `/me` answers bare or wrapped in `data`. The client accepts both.

## Known gaps

- No dashboard or phone screen for the queue. Approval is the CLI or the confirmation queue.
- Nothing pins a post. S01, S02 and C01 are marked "Pin it" in the plan as a reminder.
- Release conditions such as "only if the show is confirmed" are shown at approval and enforced
  by your approval, not by code. Code enforces the window and the live gate.
- Account-level numbers (follows, profile visits) and app download clicks are not collected.
- The plan is a file you extend each week. Nothing rotates posts automatically.

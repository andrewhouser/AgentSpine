# AgentSpine for iPhone

A native app that starts tasks, watches them run, approves what the broker queues, keeps an
eye on what runs on a clock, and — the actual reason it exists — gets AgentSpine's
notifications their own icon on your home screen instead of a share of ntfy's.

It talks to the dashboard API over your tailnet and is never submitted to the App Store.
You install it on your own phone from Xcode, where it lasts a year before it needs
re-signing.

```
Threads        the conversation list — rename, archive, delete — and a composer
Thread         turns live: every tool call with its verdict, your photos, markdown replies;
               under each reply: star, save to file, and the context it was written from
Approvals      the queue, showing the whole proposed action — not a summary
Schedules      jobs that run on a clock: pause, edit, run now, and how the last few went
Tasks          to-dos and follow-ups, with due times; the Mac pushes when one falls due
Files          everything the assistant has saved for you, with a preview
Clients        light client list, next actions, and where the last 30 days of time went
Search         every thread — your questions and its answers
Activity       every run, scheduled and watcher ones included; open one for its full trace
Settings       the two settings, and the answer to "why didn't it buzz"
```

The app is deliberately a subset of the dashboard. [ROADMAP.md](ROADMAP.md) records what it
covers, what it does not, and why — along with the notes worth having before you add to it.

---

## Why a paid Apple Developer account is required

Not for distribution — for one entitlement.

**Push Notifications is the one capability a free Apple ID cannot have.** A free personal
team can sideload an app, but it cannot sign one that carries `aps-environment`, so iOS will
never issue the app a device token and the server has nothing to push to. The fallbacks are
worse than they sound: `BGAppRefreshTask` is scheduled at the system's discretion and is
routinely tens of minutes late or skipped entirely, which is not a notification system — it
is a lottery.

The membership buys a second thing worth having here: a development provisioning profile
valid for **a year** instead of the free tier's **seven days**. Re-signing an app you depend
on every Monday morning gets old by the second Monday.

$99/year at [developer.apple.com/programs](https://developer.apple.com/programs/). The rest
of this assumes you have it.

---

## Setup

Six steps. Four are on Apple's website, two are here. Budget half an hour the first time.

### 1. Register an App ID

[developer.apple.com/account](https://developer.apple.com/account) → Certificates, IDs &
Profiles → Identifiers → **+** → App IDs → App.

- **Bundle ID**: explicit, something you control reversed — `com.yourdomain.AgentSpine`.
- **Capabilities**: tick **Push Notifications**.

Write the bundle id down. It has to match in two more places and a mismatch is rejected by
APNs as `TopicDisallowed`.

### 2. Create an APNs key

Same site → Keys → **+**.

- Name it anything; tick **Apple Push Notifications service (APNs)**.
- Download the `.p8`.

**Apple lets you download it exactly once.** There is no second copy, and losing it means
revoking the key and issuing a new one. It is also not scoped to one app — it can push to
everything in your team — so treat it like an SSH key:

```bash
mkdir -p ~/.config/agentspine
mv ~/Downloads/AuthKey_ABCD123456.p8 ~/.config/agentspine/
chmod 600 ~/.config/agentspine/AuthKey_ABCD123456.p8
```

Note the **Key ID** (the `ABCD123456` in the filename) and your **Team ID** (Membership
details, top right of the account page). Both are 10 characters.

### 3. Tell AgentSpine about it

In the repo's `.env`:

```bash
APNS_KEY_PATH=/Users/you/.config/agentspine/AuthKey_ABCD123456.p8
APNS_KEY_ID=ABCD123456
APNS_TEAM_ID=YOURTEAMID
APNS_BUNDLE_ID=com.yourdomain.AgentSpine     # exactly what you registered in step 1
```

Restart the dashboard. It will say `push: APNs + ntfy` on startup once both are configured.

You can leave `NTFY_TOPIC` set while you learn to trust the app — the two transports run
**together**, not as a fallback chain, so a push that silently fails on one still reaches
you on the other. Unset it when you stop needing the belt.

### 4. Set your bundle id and team

Edit [`Supporting/Local.xcconfig`](Supporting/Local.xcconfig) — two lines, nothing else:

```
AGENTSPINE_BUNDLE_ID = com.yourdomain.AgentSpine
DEVELOPMENT_TEAM = YOURTEAMID
```

### 5. Build and install

```bash
open ios/AgentSpine.xcodeproj
```

- Plug the iPhone in (or pair it over Wi-Fi: Window → Devices and Simulators).
- Pick it as the run destination, top of the window.
- Press ⌘R.

First run only, on the phone: **Settings → General → VPN & Device Management → your
developer certificate → Trust**. iOS will not launch a development-signed app until you do,
and the error it shows instead does not say so clearly.

### 6. Point it at the Mini

Open the app — it starts on Settings, since nothing is configured yet.

- **Server**: `http://your-machine.your-tailnet.ts.net:8787`
- **Dashboard token**: `DASHBOARD_TOKEN` from the repo's `.env`

Tap **Test connection**. That hits `/api/status`, which proves the address, the tunnel and
the token in one request. Then **Allow notifications**, then **Send a test push**.

Finally, the one step no code can do for you: **iOS Settings → Notifications → AgentSpine →
Time Sensitive Notifications**, on. Without it, a priority 4–5 approval will not break
through a Focus mode, which is the one time you most want it to.

---

## How push actually gets to you

```
broker queues an irreversible action
  └── notify()                                  src/notify.ts
        ├── APNs ──► api.push.apple.com ──► your iPhone
        │              src/push/apns.ts
        ├── ntfy  ──► ntfy.sh (if NTFY_TOPIC is set)
        └── Mac banner, only if neither delivered
```

The app registers its APNs device token with `POST /api/devices` on every launch, because a
device token is not stable — iOS reissues it on reinstall, on restore from backup, and
sometimes for its own reasons. The server upserts on the token, so re-registering is free and
is the only way to be certain it holds a current one.

**Notifications reach you over Apple's network, not over Tailscale.** So a push arrives on
cellular, on someone else's Wi-Fi, anywhere. Tapping it to read the thread does need the
tailnet — but the alert itself does not, which is the right way round.

### Approving from the lock screen

An approval notification carries Approve and Reject buttons. They are declared by the app
under the `CONFIRMATION` category; the payload only names the category. So nothing that
travels through Apple's servers can add a button or change what one does, and an older build
of the app shows the notification with no buttons rather than breaking.

Approve is marked `authenticationRequired` — Face ID before it fires. It is a button that
lets an agent send mail or delete a file, reached from a screen anyone holding the phone can
see.

The credential in the payload is the **approval token**, not the dashboard token: scoped to
one confirmation, single use, no other route. The reasoning is written out above
`confirmationActions` in [`src/notify.ts`](../src/notify.ts). Worst case for a leaked
approval token is that someone answers one question you were about to be asked anyway.

---

## When it doesn't buzz

Every failure here is silent from the phone's side, which is why Settings is mostly
diagnostics. Work down this list.

| Symptom | Where to look |
|---|---|
| **Test connection fails** | Tailscale connected on *both* ends? `npm run dashboard` running? Try the same URL in Safari on the phone. |
| **"The server rejected the dashboard token"** | It is `DASHBOARD_TOKEN` in `.env`, not the ntfy token. |
| **Device token says "not issued"** | Permission not granted, or the App ID is missing the Push Notifications capability. Check `registrationNote` under it — a signing problem says so there. |
| **Test push: "no registered devices"** | The app never reached step 6. Open it, Test connection, then the push button again. |
| **Test push: `BadDeviceToken`** | Normally self-healing — the server flips the device's environment and retries once, then remembers. Twice in a row means the token really is dead; delete the row and relaunch the app. |
| **Test push: `InvalidProviderToken`** | `APNS_KEY_ID` or `APNS_TEAM_ID` is wrong, or `APNS_KEY_PATH` points at a different key than `APNS_KEY_ID` names. |
| **Test push: `TopicDisallowed`** | `APNS_BUNDLE_ID` ≠ the app's actual bundle id. Check it against `Local.xcconfig`. |
| **Test push: `Unregistered`** | The app was deleted from the phone. The server retires the row; reinstall and relaunch. |
| **Pushes arrive but never interrupt** | Time Sensitive Notifications, in iOS Settings. See step 6. |
| **App dies after a week** | You built with a free Apple ID. See the top of this file. |

`POST /api/push/test` returns the verbatim APNs reason per device, which is what turns "it
didn't buzz" into one of the rows above.

---

## Notes on the build

**Plain HTTP over Tailscale.** `Supporting/Info.plist` carries an ATS exception scoped to
`ts.net` — not a global `NSAllowsArbitraryLoads`. Inside the tunnel the transport is already
encrypted by WireGuard and a second TLS layer buys nothing, but the narrow exception means a
bug or a mistyped URL cannot send your dashboard token in the clear over a café network.

If you would rather have no exception at all, run `tailscale serve --bg 8787` on the Mini.
Tailscale then terminates real Let's Encrypt TLS on your `*.ts.net` name, you point the app
at `https://your-machine.your-tailnet.ts.net` with no port, and you can delete the whole
`NSAppTransportSecurity` block.

**Swift 5 language mode**, set deliberately in the project. Swift 6's strict concurrency
checking has opinions about `@Observable` classes and `deinit` that are worth adopting
on purpose, not by accident, in an app you maintain by hand.

**No dependencies**, on either side. The server's APNs client is `node:http2` and
`node:crypto`; the app is SwiftUI and `URLSession`. Nothing to audit, nothing to update.

**Annual re-signing.** The provisioning profile expires after a year and the app stops
launching. Open the project, press ⌘R, done — it takes a minute, but put a reminder in
AgentSpine's own scheduler so it is the thing that tells you.

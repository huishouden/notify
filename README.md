# notify

Sends Huishouden reminders as phone and tablet notifications. One Cloudflare Worker, run every
5 minutes on Cloudflare's free plan, serves every household in the Huishouden Firebase project the
same way: no household sets anything up, and no maintainer's machine has to be on.

Apps write reminders with `@huishouden/pwa-kit/reminders` and let people turn notifications on with
`@huishouden/pwa-kit/push`. This Worker is the part that runs on a schedule, which Firebase's free
plan can't.

## How it works

Every 5 minutes:

1. Gets an access token for its Google service account (a JWT signed in the Worker, exchanged at
   Google's token endpoint), which may read and write Firestore and nothing else.
2. Asks Firestore for reminders across all households that are unsent and due (collection group
   `reminders`, `sent == false`, `at <= now`): the 50 oldest, and only when those fill the window,
   the 50 newest too. One household's backlog can fill the oldest 50 on its own; the newest 50
   still reach everyone else. A window that isn't full already holds everything due, so the second
   query (billed a read even when empty) is skipped. While the newest-first index is missing or
   building, the run logs one line and uses the oldest 50 alone. Alongside the first, a query reads
   the 50 oldest due `personalReminders` (reminders for named members only, pwa-kit `./audience`:
   Health's medicine reminders); they join the same pool. While its index is missing, the run logs
   one line and sends the shared ones.
3. Shares the run fairly between households: each household's due reminders oldest first, the
   households in order of their oldest due reminder, then round by round, every household's first
   reminder before any household's second. At most 10 per household per run; the rest are counted
   as `capped` and wait for the next run.
4. Going down that order, reads each household's members, roles, `pushSubscriptions` and `notificationPrefs` (once per
   household) and works out the devices: `recipients: 'all'` means every member, a list means
   those listed who are still members. For each person, the devices where they turned
   notifications on in the reminder's app, or all their devices when they did that only in other
   apps. A device shared by two recipients (the household tablet) gets one notification. A private
   reminder (`private` not `false`, or from Spending or Bills) goes only to admins and members,
   never to helpers or kids (huishouden/rules README "Roles"). A personal reminder goes only to
   its recipients who are members, named in its `audience` and not kids, whatever its `private` flag.
   Nobody gets a reminder from an app they muted for themselves (`notificationPrefs/{email}`
   `muted`, @huishouden/pwa-kit/push `setAppMuted`).

   With the household, in the same go, one `batchGet` reads every record its due reminders name in
   their `source` (pwa-kit `ReminderSource`: a bill, a task, a dose), each record once. A reminder
   whose source says it is done (a bill paid or skipped, a task ticked, a dose marked, its record
   removed) is not sent but deleted, in step 5's `batchWrite`, so paying a bill from the portal's
   To-do list or the connector stops its reminders without Bills being opened. The kit's
   `@huishouden/pwa-kit/reminder-source` decides it, the same code the apps write sources with: a
   source names only its app's own collections and the fields that say a record is done
   (`REMINDER_SOURCES`), and counts only when its writer (`by`, which the rules make the signed-in
   writer) is still a member whose role may read those records, for Health records one of the
   person's `readers` (that person's document is read in the same `batchGet`). So a source never
   tells anyone more than they could see in the app. Reminders without a source, with one that
   doesn't count, or whose read fails (one log line) are sent as before.

   A reminder is taken only when all of its devices fit in what is left of the run's 45
   requests; the rest wait for the next run, and a household's later reminders wait behind an
   earlier one that didn't fit. A reminder with more devices than any run allows, when it is
   the first in line, goes to as many as fit.
5. Marks the chosen reminders sent, and deletes those no longer due, in one Firestore
   `batchWrite`, each on the condition that it hasn't changed since step 2
   (`currentDocument.updateTime`), and pushes only those whose write succeeded. Overlapping runs, or a member editing or deleting the reminder meanwhile, can't cause
   a second notification; those count as `raced`.
6. Sends a Web Push message to each device: encrypted for that device (RFC 8291, aes128gcm) and
   signed with the Huishouden VAPID key (RFC 8292). No Firebase Cloud Messaging or other push
   account is involved.
7. Deletes subscriptions the push service reports gone (404 or 410: the app was uninstalled or
   notifications were turned off).

Reminders more than 12 hours overdue (after an outage, say) are marked sent without a
notification, so nobody gets a pile of stale medicine reminders at once (`late`), and so are
malformed ones (`invalid`), in the same `batchWrite` as the claims.

Each run logs one line of counts (`due`, `sent`, `pushed`, `failed`, `removed`, `late`,
`invalid`, `raced`, `noDevices`, `capped`, `done`: deleted unsent because their source is done,
`deferred`: something due was left for a later
run, and `reads`: the Firestore reads the run was billed).

The push message is JSON the kit's service worker shows: `{ title, body, url, tag, app }`;
tapping it opens `url` in the app. Each device gets it in its own language: when the reminder has
`texts` (the same title and body in `en`, `es` and `nl`) and the device's subscription has `lang`,
that entry is sent; otherwise the reminder's own `title` and `body`.

| File | Does |
|---|---|
| `src/index.ts` | The Worker: the cron handler, and a one-line page for any HTTP request |
| `src/redact.ts` | Error messages without addresses or document paths, for logs and the heartbeat |
| `src/heartbeat.ts` | One `NotifyRun` event per run to New Relic, for the "silent" and "failing" alerts |
| `src/send.ts` | One run: query, fair order, recipients, claim, send, clean up |
| `src/webpush.ts` | Web Push encryption and VAPID with WebCrypto only |
| `src/google.ts` | Service account token |
| `src/firestore.ts` | The Firestore REST calls (query, read, `batchGet`, `batchWrite`, delete) and value decoding |
| `scripts/vapid.ts` | `bun run vapid`: a new VAPID key pair |

## Limits

- **5-minute granularity.** A reminder due at 08:00 arrives between 08:00 and about 08:05.
- **Cloudflare free plan**: 100,000 requests a day (the schedule uses 288), 50 outgoing requests
  per run and 10 ms of CPU per run. A run uses one request for the token, two or three for the queries,
  three per household (four when its due reminders have a source), one `batchWrite` and one per device, plus deletes of dropped subscriptions
  when requests are left, and stays within 45; whatever didn't fit goes out 5 minutes later.
  The encryption is done by the runtime's native WebCrypto, well inside the CPU limit for the
  number of devices a run can reach.
- **Firestore reads**: the project's free 50,000 a day are shared with every app and the other
  Workers, and once they are gone every app's reads fail until midnight Pacific. Firestore bills
  each document a query returns and at least one read per query, even an empty one, and each
  document a `get` or `batchGet` asks for. A quiet run makes two queries: **2 reads, 576 a day**
  (three queries and 864 a day before the newest-first query became conditional). A run with
  something due adds the due reminders (at most 150), and per household its document, its
  subscriptions and notification preferences (at least one read each) and the records its
  reminders name as their source. Each run counts what it was billed (`reads` in the log line and
  the `NotifyRun` event).

  `FIRESTORE_NOTIFY_READS` (`wrangler.toml`, 3,000 a day) caps the household reads. The Worker
  keeps no state between runs, so the cap is spent per run: 1/288 of it (the cron's runs a day),
  10 reads with 3,000, about one household's members, subscriptions and preferences. Past it,
  further households wait for a later run, unsent and unmarked; the first household of a run is
  always read, so a cap set too low slows sending rather than stopping it. With several households
  due in the same 5 minutes, the later ones go out up to 5 minutes later each. The due-reminder
  queries come on top and always run: 576 a day when quiet, up to 150 a run under a backlog of 50
  or more (the newest-first window is what lets other households past one household's backlog).
  So the Worker's day is at most about 576 + 3,000 reads outside a backlog. Unset or 0: no cap.
  Any other value that isn't a whole number (digits only, such as 3000) makes every run throw (the
  `NotifyRun` error alert fires).
- **iPhone and iPad** only show notifications for an app added to the Home Screen (Share > Add to
  Home Screen), on iOS/iPadOS 16.4 or later. In Safari tabs, and on older versions, there is no Web
  Push. `pushSupport()` in the kit says which case a device is in, so the app can explain.
- **Delivery isn't guaranteed.** Push services hold a message for up to 4 hours (`TTL`) while a
  device is offline, then drop it. Phones in battery saver may delay it.
- **One VAPID key for all apps and households.** Subscriptions are tied to it; replacing it means
  every device turns notifications on again.

## One-time setup

Done once, by whoever runs the Huishouden Firebase project. None of it is per household.

### 1. Cloudflare

1. Create a free account at https://dash.cloudflare.com/sign-up (no card needed for Workers Free).
2. In this repo: `bun install`, then `bunx wrangler login` (opens the browser to allow Wrangler).

### 2. VAPID keys

```sh
bun run vapid
```

It prints a public and a private key and writes neither to disk.

1. Put the public key in `wrangler.toml` as `VAPID_PUBLIC_KEY = "..."` and commit it (it is public).
2. Give it to every app's build, as the repo variable `VITE_VAPID_PUBLIC_KEY`:
   `gh variable set VITE_VAPID_PUBLIC_KEY --repo huishouden/<app> --body <public key>` for each app,
   or add `VAPID_PUBLIC_KEY=<public key>` to the pwa-kit bootstrap's `apps.conf` and re-run
   `infra/bootstrap.sh apps.conf`, which sets it on every app repo.
3. Store the private key in the Worker: `bunx wrangler secret put VAPID_PRIVATE_KEY` and paste it.
   Then clear the terminal. Keep no other copy; if it is lost, make a new pair and devices
   turn notifications on again.

### 3. Google service account (Firestore access only)

```sh
gcloud iam service-accounts create notify-sender --project huishouden-piekstra \
  --display-name "Huishouden notify (Cloudflare Worker)"
gcloud projects add-iam-policy-binding huishouden-piekstra \
  --member serviceAccount:notify-sender@huishouden-piekstra.iam.gserviceaccount.com \
  --role roles/datastore.user --condition None
# The key goes straight into the Worker secret; the temporary file is overwritten and deleted.
umask 077; key=$(mktemp)
gcloud iam service-accounts keys create "$key" \
  --iam-account notify-sender@huishouden-piekstra.iam.gserviceaccount.com
bunx wrangler secret put GOOGLE_SERVICE_ACCOUNT < "$key"
rm -P "$key"   # on Linux: shred -u "$key"
```

`roles/datastore.user` reads and writes Firestore documents and nothing else (no rules, no
indexes, no other Google services). If key creation fails with
`constraints/iam.disableServiceAccountKeyCreation`, the project is under an organization policy that
blocks keys; turn that constraint off for this project in the Cloud console (IAM > Organization
policies), since a Worker outside Google Cloud has no keyless way in.

The Firestore indexes the queries need (`reminders`, collection group, `sent` then `at`, one
ascending and one descending) are in huishouden/rules' `firestore.indexes.json`, deployed with the
rules.

### 4. Deploy

```sh
bunx wrangler deploy
bunx wrangler tail          # live logs: one line of counts per run
```

`LINK_HOSTS` in `wrangler.toml` lists where a notification may lead (space-separated, `*` for one
name part): the suite's one site, where every app lives under its own path, and the old per-app
addresses, which redirect there. A reminder linking anywhere else opens the app's home instead.

`FIREBASE_PROJECT_ID` in `wrangler.toml` names the project (public, like the apps' web config). To
try a run locally: put the two secrets in `.dev.vars` (git-ignored), `bun run dev`, then open
`http://localhost:8787/__scheduled`.

### Monitoring

Each run sends one `NotifyRun` event (the run's counts, the Firestore `reads` it was billed, its duration and, if it threw, the error
message; never reminder text, households or addresses) to New Relic's Event API, where alerts fire
when no run arrives for 20 minutes, a run throws, or more than 5 pushes fail in an hour (the
`failed` count; pwa-kit `docs/observability.md`). A heartbeat that can't be sent is logged. It uses one of
the subrequests a run keeps spare. Without these two settings nothing is sent:

```sh
# wrangler.toml [vars] has NEW_RELIC_ACCOUNT_ID (public). The ingest key is a secret:
bunx wrangler secret put NEW_RELIC_LICENSE_KEY   # paste a New Relic license (ingest) key
```

Cloudflare's own Workers Observability (`[observability]` in `wrangler.toml`) keeps the logs:
`bunx wrangler tail`, or the dashboard's Workers > huishouden-notify > Logs.

### Deploy from GitHub Actions (optional)

CI deploys on every push to `main` once these secrets of the `production` environment exist
(its deployment branches are `main` alone, so no other branch's run can read them); until then
the deploy job runs but deploys nothing, with a notice. Repository secrets of the same names also reach the job; once the environment holds the values, delete them (`gh secret delete CLOUDFLARE_API_TOKEN -R huishouden/notify`, and the account id). The environment itself (Settings > Environments > `production`, deployment branches: `main`) exists already.

1. Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers"
   template, limited to your account. Copy the token.
2. `hh ops secret set notify CLOUDFLARE_API_TOKEN --env production` and
   `hh ops secret set notify CLOUDFLARE_ACCOUNT_ID --env production`, each value on stdin (the
   account id: Workers & Pages overview, right-hand side).

The Worker's own secrets stay in Cloudflare; CI never sees them.

## Development

```sh
bun install
bun run lint
bun test        # Web Push against the RFC 8291 test vectors, token, and run logic with fetch stubbed
```

Test data is invented (`example.com` addresses, demo project ids); the only real keys in the tests
are the published RFC 8291 example keys. Never commit a service account key or VAPID private key:
the pre-commit hook (`.githooks/pre-commit`, enabled by `bun install`) and CI scan for them, and
GitHub push protection is on.

## License

Source available under [PolyForm Shield 1.0.0](LICENSE): you may use, study and modify this code
for any purpose except providing a product that competes with Huishouden.

Huishouden and its logo are the project's brand; please don't use them for other products.

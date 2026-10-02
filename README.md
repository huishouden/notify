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
2. Asks Firestore for reminders across all households that are unsent and due:
   collection group `reminders`, `sent == false`, `at <= now`, oldest first, 50 at a time.
3. For each household involved, reads its members and its `pushSubscriptions`.
4. Works out the devices: `recipients: 'all'` means every member, a list means those listed who are
   still members. For each person, the devices where they turned notifications on in the
   reminder's app, or all their devices when they did that only in other apps. A device shared by
   two recipients (the household tablet) gets one notification.
5. Marks the reminder sent, on the condition that it hasn't changed since step 2 (Firestore
   `currentDocument.updateTime`). Overlapping runs, or a member editing the reminder meanwhile,
   can't cause a second notification.
6. Sends a Web Push message to each device: encrypted for that device (RFC 8291, aes128gcm) and
   signed with the Huishouden VAPID key (RFC 8292). No Firebase Cloud Messaging or other push
   account is involved.
7. Deletes subscriptions the push service reports gone (404 or 410: the app was uninstalled or
   notifications were turned off).

Reminders more than 12 hours overdue (after an outage, say) are marked sent without a
notification, so nobody gets a pile of stale medicine reminders at once.

The push message is JSON the kit's service worker shows: `{ title, body, url, tag, app }`;
tapping it opens `url` in the app.

| File | Does |
|---|---|
| `src/index.ts` | The Worker: the cron handler, and a one-line page for any HTTP request |
| `src/heartbeat.ts` | One `NotifyRun` event per run to New Relic, for the "silent" and "failing" alerts |
| `src/send.ts` | One run: query, recipients, claim, send, clean up |
| `src/webpush.ts` | Web Push encryption and VAPID with WebCrypto only |
| `src/google.ts` | Service account token |
| `src/firestore.ts` | The Firestore REST calls and value decoding |
| `scripts/vapid.ts` | `bun run vapid`: a new VAPID key pair |

## Limits

- **5-minute granularity.** A reminder due at 08:00 arrives between 08:00 and about 08:05.
- **Cloudflare free plan**: 100,000 requests a day (the schedule uses 288), 50 outgoing requests
  per run and 10 ms of CPU per run. A run uses one request for the query, two per household, one
  per reminder and one per device, and stops at 45; whatever didn't fit goes out 5 minutes later.
  The encryption is done by the runtime's native WebCrypto, well inside the CPU limit for the
  number of devices a run can reach.
- **Firestore free tier**: each run reads the due reminders plus each involved household and its
  subscriptions, and an empty run costs one read; about 300 reads a day when idle, against 50,000.
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

The Firestore index the query needs (`reminders`, collection group, `sent` then `at`) is in the
tasks repo's `firestore.indexes.json`, deployed with the rules.

### 4. Deploy

```sh
bunx wrangler deploy
bunx wrangler tail          # live logs: one line of counts per run
```

`FIREBASE_PROJECT_ID` in `wrangler.toml` names the project (public, like the apps' web config). To
try a run locally: put the two secrets in `.dev.vars` (git-ignored), `bun run dev`, then open
`http://localhost:8787/__scheduled`.

### Monitoring

Each run sends one `NotifyRun` event (the run's counts, its duration and, if it threw, the error
message; never reminder text, households or addresses) to New Relic's Event API, where alerts fire
when no run arrives for 20 minutes or a run fails (pwa-kit `docs/observability.md`). It uses one of
the subrequests a run keeps spare. Without these two settings nothing is sent:

```sh
# wrangler.toml [vars] has NEW_RELIC_ACCOUNT_ID (public). The ingest key is a secret:
bunx wrangler secret put NEW_RELIC_LICENSE_KEY   # paste a New Relic license (ingest) key
```

Cloudflare's own Workers Observability (`[observability]` in `wrangler.toml`) keeps the logs:
`bunx wrangler tail`, or the dashboard's Workers > huishouden-notify > Logs.

### Deploy from GitHub Actions (optional)

CI deploys on every push to `main` once these repository secrets exist; until then the deploy
job is skipped with a notice.

1. Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers"
   template, limited to your account. Copy the token.
2. `gh secret set CLOUDFLARE_API_TOKEN --repo huishouden/notify` (paste the token), and
   `gh secret set CLOUDFLARE_ACCOUNT_ID --repo huishouden/notify --body <account id>` (Workers &
   Pages overview, right-hand side).

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

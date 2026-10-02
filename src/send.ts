import { accessToken, parseServiceAccount, type Fetch } from './google';
import { decodeFields, documentPath, Firestore, type RestDocument, type WriteOutcome } from './firestore';
import { loadVapid, pushRequest, type SubscriptionKeys, type Vapid } from './webpush';

export interface Env {
  FIREBASE_PROJECT_ID: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  /** Secret: the service account key JSON. */
  GOOGLE_SERVICE_ACCOUNT: string;
  /** Secret: the VAPID private key (base64url P-256 scalar). */
  VAPID_PRIVATE_KEY: string;
}

/** Reminders further overdue than this are marked sent without a notification (after an outage). */
export const MAX_LATE_MS = 12 * 3600_000;
/** Reminders read per run by each of the two windows (oldest first, newest first). */
export const BATCH = 50;
/** Reminders sent per household per run, so one household's backlog can't take a whole run. */
export const PER_HOUSEHOLD_CAP = 10;
/**
 * Outgoing requests per run. Cloudflare's free plan allows 50 subrequests per invocation; a few are
 * kept spare, one of them for the heartbeat (`HEARTBEAT_SUBREQUESTS` in ./heartbeat). Whatever doesn't fit waits for the next run, five minutes later.
 */
export const SUBREQUEST_BUDGET = 45;

export interface Reminder {
  id: string;
  householdId: string;
  app: string;
  title: string;
  body: string;
  at: number;
  url: string;
  recipients: 'all' | string[];
  /**
   * For admins and members only: marked private, from Spending or Bills, or written before the
   * flag existed (the rules treat that as private to helpers and kids too).
   */
  private: boolean;
  doc: RestDocument;
}

/** Apps whose reminders are money, never sent to helpers or kids (pwa-kit `MONEY_APPS`). */
const MONEY_APPS = ['spending', 'bills'];

export interface Subscription {
  name: string;
  email: string;
  app: string;
  endpoint: string;
  keys: SubscriptionKeys;
}

export interface RunStats {
  due: number;
  sent: number;
  pushed: number;
  failed: number;
  removed: number;
  late: number;
  invalid: number;
  raced: number;
  noDevices: number;
  /** Held back by `PER_HOUSEHOLD_CAP`, for a later run. */
  capped: number;
  /**
   * True when something due was left for a later run: held back by the per-household cap or the
   * subrequest budget, or possibly beyond both read windows.
   */
  deferred: boolean;
}

class BudgetExhausted extends Error {}

/** Wraps fetch so a run never goes past its subrequest allowance. */
export function budgeted(fetchImpl: Fetch, limit: number) {
  let used = 0;
  const f: Fetch = (input, init) => {
    if (used >= limit) return Promise.reject(new BudgetExhausted());
    used++;
    return fetchImpl(input, init);
  };
  return { fetch: f, remaining: () => limit - used };
}

export function toReminder(doc: RestDocument): Reminder | null {
  const path = documentPath(doc.name);
  if (path.length !== 4 || path[0] !== 'households' || path[2] !== 'reminders') return null;
  const d = decodeFields(doc.fields);
  if (typeof d.title !== 'string' || !d.title || typeof d.at !== 'number' || typeof d.app !== 'string') return null;
  const recipients = d.recipients === 'all' ? 'all' : Array.isArray(d.recipients) ? d.recipients.map((e) => String(e).toLowerCase()) : null;
  if (!recipients) return null;
  const url = typeof d.url === 'string' && /^https:\/\//.test(d.url) ? d.url : '/';
  const isPrivate = d.private !== false || MONEY_APPS.includes(d.app);
  return { id: path[3], householdId: path[1], app: d.app, title: d.title, body: typeof d.body === 'string' ? d.body : '', at: d.at, url, recipients, private: isPrivate, doc };
}

export function toSubscription(doc: RestDocument): Subscription | null {
  const d = decodeFields(doc.fields) as { email?: unknown; app?: unknown; endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof d.email !== 'string' || typeof d.endpoint !== 'string' || !/^https:\/\//.test(d.endpoint)) return null;
  if (typeof d.keys?.p256dh !== 'string' || typeof d.keys?.auth !== 'string') return null;
  return {
    name: doc.name,
    email: d.email.toLowerCase(),
    app: typeof d.app === 'string' ? d.app : '',
    endpoint: d.endpoint,
    keys: { p256dh: d.keys.p256dh, auth: d.keys.auth },
  };
}

/**
 * A member's role as the rules work it out (huishouden/rules README "Roles"): named in `roles`, or
 * else a member, except the creator (first in `members`), an admin.
 */
export function roleOf(email: string, members: string[], roles: Record<string, unknown> = {}): string {
  const r = roles[email];
  if (typeof r === 'string') return r;
  return members[0]?.toLowerCase() === email ? 'admin' : 'member';
}

/**
 * Where one reminder goes: each recipient who is still a member, on the devices where they turned
 * notifications on in the reminder's own app, or on all their devices when they did so only in
 * other apps. A device shared by two recipients (the household tablet) gets it once. A private
 * reminder goes only to admins and members: helpers and kids can't read it in the app either.
 */
export function targets(reminder: Reminder, members: string[], subscriptions: Subscription[], roles: Record<string, unknown> = {}): Subscription[] {
  const memberSet = new Set(members.map((m) => m.toLowerCase()));
  const everyone = reminder.recipients === 'all' ? [...memberSet] : reminder.recipients.filter((e) => memberSet.has(e));
  const people = reminder.private ? everyone.filter((e) => ['admin', 'member'].includes(roleOf(e, members, roles))) : everyone;
  const chosen = new Map<string, Subscription>();
  for (const email of people) {
    const theirs = subscriptions.filter((s) => s.email === email);
    const inApp = theirs.filter((s) => s.app === reminder.app);
    for (const s of inApp.length ? inApp : theirs) if (!chosen.has(s.endpoint)) chosen.set(s.endpoint, s);
  }
  return [...chosen.values()];
}

export function payload(reminder: Reminder): string {
  return JSON.stringify({ title: reminder.title, body: reminder.body, url: reminder.url, tag: reminder.id, app: reminder.app });
}

interface Household {
  members: string[];
  roles: Record<string, unknown>;
  subscriptions: Subscription[];
}

const byAt = (a: Reminder, b: Reminder) => a.at - b.at || (a.doc.name < b.doc.name ? -1 : a.doc.name > b.doc.name ? 1 : 0);

/**
 * The order a run considers reminders in: round-robin across households, each household's oldest
 * first, households ordered by their oldest due reminder, at most `cap` per household. Round 0
 * gives every household its first reminder before any household gets a second.
 */
export function fairOrder(reminders: Reminder[], cap = PER_HOUSEHOLD_CAP): { order: Reminder[]; capped: number } {
  const groups = new Map<string, Reminder[]>();
  for (const r of [...reminders].sort(byAt)) {
    const group = groups.get(r.householdId);
    if (group) group.push(r);
    else groups.set(r.householdId, [r]);
  }
  const order: Reminder[] = [];
  let capped = 0;
  for (let round = 0; round < cap; round++) for (const group of groups.values()) if (round < group.length) order.push(group[round]);
  for (const group of groups.values()) capped += Math.max(0, group.length - cap);
  return { order, capped };
}

async function loadHousehold(db: Firestore, id: string): Promise<Household> {
  const [home, subs] = await Promise.all([db.get(`households/${id}`), db.list(`households/${id}/pushSubscriptions`)]);
  const fields = home ? decodeFields(home.fields) : {};
  const { members, roles } = fields;
  return {
    members: Array.isArray(members) ? members.map(String) : [],
    roles: roles && typeof roles === 'object' && !Array.isArray(roles) ? (roles as Record<string, unknown>) : {},
    subscriptions: subs.map(toSubscription).filter((s): s is Subscription => !!s),
  };
}

/**
 * One run: read what is due, choose fairly what fits in the subrequest budget, mark it sent, send
 * it, forget subscriptions the push service has dropped.
 */
export async function run(env: Env, now: number, fetchImpl: Fetch, log: (line: string) => void = console.log): Promise<RunStats> {
  const stats: RunStats = { due: 0, sent: 0, pushed: 0, failed: 0, removed: 0, late: 0, invalid: 0, raced: 0, noDevices: 0, capped: 0, deferred: false };
  if (!env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID is not set (wrangler.toml [vars]).');
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PUBLIC_KEY (wrangler.toml) and VAPID_PRIVATE_KEY (secret) must both be set.');
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
  const vapid: Vapid = await loadVapid(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT || 'https://github.com/huishouden/notify');
  const budget = budgeted(fetchImpl, SUBREQUEST_BUDGET);
  // Both queries start together; sharing the pending token keeps that to one token request.
  let token: Promise<string> | undefined;
  const db = new Firestore(env.FIREBASE_PROJECT_ID, () => (token ??= accessToken(sa, budget.fetch, now)), budget.fetch);

  try {
    // Oldest first alone can be filled by one household's backlog; newest first reaches the rest.
    const [oldest, newest] = await Promise.all([
      db.dueReminders(now, BATCH, 'ASCENDING'),
      db.dueReminders(now, BATCH, 'DESCENDING').catch((error: unknown) => {
        if (error instanceof BudgetExhausted) throw error;
        log(`newest-first query failed, using the oldest-first window only: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
        return null;
      }),
    ]);
    const docs = new Map<string, RestDocument>();
    for (const doc of [...oldest, ...(newest ?? [])]) docs.set(doc.name, doc);
    stats.due = docs.size;
    // Windows that overlap cover everything due between them.
    const unread = oldest.length >= BATCH && (!newest || docs.size === oldest.length + newest.length);

    const marks: { doc: RestDocument; kind: 'late' | 'invalid' }[] = [];
    const sendable: Reminder[] = [];
    for (const doc of docs.values()) {
      const reminder = toReminder(doc);
      // Malformed: marked so it isn't read again every five minutes.
      if (!reminder) marks.push({ doc, kind: 'invalid' });
      else if (now - reminder.at > MAX_LATE_MS) marks.push({ doc, kind: 'late' });
      else sendable.push(reminder);
    }
    const { order, capped } = fairOrder(sendable);
    stats.capped = capped;

    // Choose what fits: household reads, then every push of each chosen reminder, keeping one
    // request for the batchWrite that marks and claims them all.
    const households = new Map<string, Household>();
    const blocked = new Set<string>();
    const chosen: { reminder: Reminder; to: Subscription[] }[] = [];
    let pushes = 0;
    let left = 0;
    for (const reminder of order) {
      if (blocked.has(reminder.householdId)) {
        left++;
        continue;
      }
      let spare = budget.remaining() - 1 - pushes;
      let household = households.get(reminder.householdId);
      if (!household) {
        if (spare < 3) {
          left++;
          continue;
        }
        household = await loadHousehold(db, reminder.householdId);
        households.set(reminder.householdId, household);
        spare -= 2;
      }
      let to = targets(reminder, household.members, household.subscriptions, household.roles);
      // Claimed only when every push fits in this run: never sent twice, never half.
      if (to.length > spare) {
        if (chosen.length > 0 || spare < 1) {
          // Keeps a household's reminders in order: nothing newer goes out ahead of this one.
          blocked.add(reminder.householdId);
          left++;
          continue;
        }
        // Too many devices for any single run: reach as many as one run allows rather than none.
        log(`reminder has ${to.length} devices; sending to ${spare}`);
        to = to.slice(0, spare);
      }
      chosen.push({ reminder, to });
      pushes += to.length;
    }
    stats.deferred = left > 0 || capped > 0 || unread;

    const outcomes = await db.markSent([...marks.map((m) => m.doc), ...chosen.map((c) => c.reminder.doc)], now);
    const errors: string[] = [];
    const count = (outcome: WriteOutcome, ok: () => void) => {
      if (outcome.ok) ok();
      else if (outcome.raced) stats.raced++;
      else errors.push(outcome.error);
    };
    marks.forEach((m, i) => count(outcomes[i], () => stats[m.kind]++));
    const claimed = chosen.filter((c, i) => {
      let ok = false;
      count(outcomes[marks.length + i], () => (ok = true));
      return ok;
    });

    stats.sent = claimed.length;
    const deliveries = claimed.flatMap(({ reminder, to }) => {
      if (to.length === 0) stats.noDevices++;
      const body = payload(reminder);
      return to.map((sub) => ({ sub, body }));
    });
    const results = await Promise.all(
      deliveries.map(async ({ sub, body }) => {
        try {
          const req = await pushRequest(sub, body, vapid, { nowSeconds: Math.floor(now / 1000) });
          const res = await budget.fetch(req.url, req.init);
          return { sub, status: res.status };
        } catch (error) {
          if (error instanceof BudgetExhausted) throw error;
          return { sub, status: 0 };
        }
      }),
    );
    const gone = new Map<string, Subscription>();
    for (const { sub, status } of results) {
      if (status >= 200 && status < 300) stats.pushed++;
      else {
        stats.failed++;
        if (status === 404 || status === 410) gone.set(sub.name, sub);
        else log(`push to ${new URL(sub.endpoint).host} failed: ${status}`);
      }
    }
    // Spare budget only; a dropped subscription answers 410 again next time.
    const removable = [...gone.values()].slice(0, Math.max(0, budget.remaining()));
    await Promise.all(
      removable.map(async (sub) => {
        await db.delete(sub.name);
        stats.removed++;
      }),
    );

    if (errors.length) throw new Error(`Firestore batchWrite: ${errors.length} of ${outcomes.length} writes failed (${errors[0]})`);
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    stats.deferred = true;
  }
  return stats;
}

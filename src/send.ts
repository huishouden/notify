import { accessToken, parseServiceAccount, type Fetch } from './google';
import { decodeFields, documentPath, Firestore, type RestDocument } from './firestore';
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
/** Reminders read per run. */
export const BATCH = 50;
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
  /** True when the subrequest budget ran out before every due reminder was handled. */
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

/** One run: send what is due, mark it sent, forget subscriptions the push service has dropped. */
export async function run(env: Env, now: number, fetchImpl: Fetch, log: (line: string) => void = console.log): Promise<RunStats> {
  const stats: RunStats = { due: 0, sent: 0, pushed: 0, failed: 0, removed: 0, late: 0, invalid: 0, raced: 0, noDevices: 0, deferred: false };
  if (!env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID is not set (wrangler.toml [vars]).');
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PUBLIC_KEY (wrangler.toml) and VAPID_PRIVATE_KEY (secret) must both be set.');
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT);
  const vapid: Vapid = await loadVapid(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT || 'https://github.com/huishouden/notify');
  const budget = budgeted(fetchImpl, SUBREQUEST_BUDGET);
  const db = new Firestore(env.FIREBASE_PROJECT_ID, () => accessToken(sa, budget.fetch, now), budget.fetch);
  const households = new Map<string, Household>();
  let handled = 0;

  try {
    const docs = await db.dueReminders(now, BATCH);
    stats.due = docs.length;
    for (const doc of docs) {
      const reminder = toReminder(doc);
      if (!reminder) {
        // Malformed: mark it so it isn't read again every five minutes.
        if (await db.markSent(doc, now)) stats.invalid++;
        continue;
      }
      if (now - reminder.at > MAX_LATE_MS) {
        if (await db.markSent(doc, now)) stats.late++;
        else stats.raced++;
        continue;
      }
      let household = households.get(reminder.householdId);
      if (!household) {
        // Two reads per household, plus a claim; leave room so a household is never half-read.
        if (budget.remaining() < 3) throw new BudgetExhausted();
        const [home, subs] = await Promise.all([
          db.get(`households/${reminder.householdId}`),
          db.list(`households/${reminder.householdId}/pushSubscriptions`),
        ]);
        const fields = home ? decodeFields(home.fields) : {};
        const members = fields.members;
        const roles = fields.roles;
        household = {
          members: Array.isArray(members) ? members.map(String) : [],
          roles: roles && typeof roles === 'object' && !Array.isArray(roles) ? (roles as Record<string, unknown>) : {},
          subscriptions: subs.map(toSubscription).filter((s): s is Subscription => !!s),
        };
        households.set(reminder.householdId, household);
      }
      let to = targets(reminder, household.members, household.subscriptions, household.roles);
      // Claim before sending, and only when every push fits in this run: never send twice, never half.
      if (budget.remaining() < 1 + to.length) {
        if (handled > 0) throw new BudgetExhausted();
        // Too many devices for any single run: reach as many as one run allows rather than none.
        log(`reminder has ${to.length} devices; sending to ${budget.remaining() - 1}`);
        to = to.slice(0, Math.max(0, budget.remaining() - 1));
      }
      if (!(await db.markSent(doc, now))) {
        stats.raced++;
        continue;
      }
      stats.sent++;
      handled++;
      if (to.length === 0) {
        stats.noDevices++;
        continue;
      }
      const body = payload(reminder);
      const results = await Promise.all(
        to.map(async (sub) => {
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
      const gone: Subscription[] = [];
      for (const { sub, status } of results) {
        if (status >= 200 && status < 300) stats.pushed++;
        else {
          stats.failed++;
          if (status === 404 || status === 410) gone.push(sub);
          else log(`push to ${new URL(sub.endpoint).host} failed: ${status}`);
        }
      }
      for (const sub of gone) {
        // Spare budget only; a dropped subscription answers 410 again next time.
        if (budget.remaining() < 1) break;
        await db.delete(sub.name);
        household.subscriptions = household.subscriptions.filter((s) => s.name !== sub.name);
        stats.removed++;
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    stats.deferred = true;
  }
  return stats;
}

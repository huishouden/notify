import { beforeEach, describe, expect, test } from 'bun:test';
import { fromB64url, type Bytes } from '../src/b64';
import { importKeyPair, deriveKeys } from '../src/webpush';
import { resetTokenCache } from '../src/google';
import { fairOrder, readsPerRun, sourceDone, linkHosts, payload, toTexts, PER_HOUSEHOLD_CAP, roleOf, run, safeLink, SUBREQUEST_BUDGET, targets, toMuted, toReminder, toSubscription, type Subscription } from '../src/send';
import due from './fixtures/due-reminders.json';
import household from './fixtures/household-h1.json';
import subscriptions from './fixtures/subscriptions-h1.json';
import tokenResponse from './fixtures/token-response.json';
import batchWrite from './fixtures/batch-write-response.json';
import indexMissing from './fixtures/index-missing.json';
import personalDue from './fixtures/personal-reminders.json';
import v from './fixtures/rfc8291.json';
import sourceDue from './fixtures/source-reminders.json';
import batchGetBills from './fixtures/batch-get-bills.json';
import { json, stubFetch, testEnv, type Call, type Route } from './helpers';

const NOW = 1_767_268_800_000;
const DOCS = 'https://firestore.googleapis.com/v1/projects/demo-huishouden/databases/(default)/documents';
const quiet = () => {};

const isPush = (c: Call) => !c.url.startsWith('https://firestore.googleapis.com') && !c.url.startsWith('https://oauth2.');

type Entry = { document?: { name: string; fields?: Record<string, unknown>; updateTime: string } };
type Outcome = 'ok' | 'precondition' | 'notFound' | 'aborted' | 'internal';
const OUTCOME = { ok: 0, precondition: 1, notFound: 2, aborted: 3, internal: 4 } as const;

/** A batchWrite response giving each write the outcome `outcome` picks for its document. */
type Write = { update?: { name: string }; delete?: string };
const writeName = (w: Write) => w.update?.name ?? w.delete ?? '';

function batchWriteResponse(writes: Write[], outcome: (name: string) => Outcome | undefined) {
  const picks = writes.map((w) => OUTCOME[outcome(writeName(w)) ?? 'ok']);
  return { writeResults: picks.map((i) => batchWrite.writeResults[i]), status: picks.map((i) => batchWrite.status[i]) };
}

const collectionOf = (c: Call) => (c.body as { structuredQuery: { from: { collectionId: string }[] } }).structuredQuery.from[0].collectionId;
const directionOf = (c: Call) => (c.body as { structuredQuery: { orderBy: { direction: string }[] } }).structuredQuery.orderBy[0].direction;

/**
 * Firestore, push services and Google's token endpoint. `due` is everything due, oldest first; each
 * query answers with its 50-reminder window of it. Households other than h1 have one member device.
 */
function routes(over: { batchGet?: Route; prefs?: (household: string) => unknown; personal?: (c: Call) => Response | undefined; due?: Entry[]; newest?: (c: Call) => Response | undefined; write?: (name: string) => Outcome | undefined; batchWrite?: Route; subs?: (household: string) => unknown; push?: Route } = {}): Route[] {
  const docs = (over.due ?? due).filter((e) => e.document);
  return [
    (c) => (c.url === 'https://oauth2.googleapis.com/token' ? json(tokenResponse) : undefined),
    (c) => {
      if (c.url !== `${DOCS}:runQuery`) return undefined;
      if (collectionOf(c) === 'personalReminders') return over.personal?.(c) ?? json([{ readTime: '2026-01-01T12:00:00.000000Z' }]);
      if (directionOf(c) === 'ASCENDING') return json([...docs.slice(0, 50), { readTime: '2026-01-01T12:00:00.000000Z' }]);
      return over.newest?.(c) ?? json([...docs.slice(-50).reverse(), { readTime: '2026-01-01T12:00:00.000000Z' }]);
    },
    (c) => (c.url === `${DOCS}:batchWrite` ? (over.batchWrite?.(c) ?? json(batchWriteResponse((c.body as { writes: Write[] }).writes, over.write ?? (() => 'ok')))) : undefined),
    (c) => (c.url === `${DOCS}:batchGet` ? (over.batchGet?.(c) ?? json(batchGetAnswer(c))) : undefined),
    (c) => {
      const m = c.method === 'GET' && c.url.match(/\/households\/([^/?]+)(\/pushSubscriptions\?pageSize=300)?$/);
      if (!m) return undefined;
      const [, id, subsPath] = m;
      if (!subsPath) return json(id === 'h1' ? household : { ...household, name: household.name.replace('/h1', `/${id}`) });
      return json(over.subs?.(id) ?? (id === 'h1' ? subscriptions : oneDevice(id)));
    },
    (c) => {
      const m = c.method === 'GET' && c.url.match(/\/households\/([^/?]+)\/notificationPrefs\?pageSize=300$/);
      return m ? json(over.prefs?.(m[1]) ?? {}) : undefined;
    },
    (c) => (c.method === 'DELETE' ? json({}) : undefined),
    (c) => (isPush(c) ? (over.push?.(c) ?? new Response(null, { status: c.url.includes('gone.example.org') ? 410 : 201 })) : undefined),
  ];
}

/** The fixture's documents that a batchGet asked for, in the order asked; any other is missing. */
function batchGetAnswer(c: Call) {
  const asked = (c.body as { documents: string[] }).documents;
  return asked.map(
    (name) =>
      batchGetBills.responses.find((r) => (r.found?.name ?? r.missing) === name) ?? { missing: name, readTime: '2026-01-01T12:00:00.000000Z' },
  );
}

/** A household's subscriptions: Sam's tablet only, at an endpoint of its own. */
function oneDevice(householdId: string) {
  const tablet = structuredClone(subscriptions.documents[2]);
  tablet.name = tablet.name.replace('/h1/', `/${householdId}/`);
  tablet.fields.endpoint.stringValue = `https://push.example.net/${householdId}-tablet`;
  return { documents: [tablet] };
}

/** `count` devices for Sam in household h1. */
function manyDevices(count: number) {
  return {
    documents: Array.from({ length: count }, (_, i) => {
      const d = structuredClone(subscriptions.documents[2]);
      d.name = d.name.replace('sam-tasks-tablet', `sam-device-${i}`);
      d.fields.endpoint.stringValue = `https://push.example.net/device-${i}`;
      return d;
    }),
  };
}

/** A due reminder like the pet one in the fixture, in another household, at another time. */
function dueDoc(householdId: string, id: string, at: number): Entry {
  const entry = structuredClone(due[0]) as Entry & { document: { fields: { at: { integerValue: string } } } };
  entry.document.name = entry.document.name.replace('/h1/reminders/pet-c1-20260101-1155', `/${householdId}/reminders/${id}`);
  entry.document.fields.at.integerValue = String(at);
  return entry;
}

/** `count` reminders for one household, a minute apart, the newest at `newest`. */
const backlog = (householdId: string, count: number, newest: number) =>
  Array.from({ length: count }, (_, i) => dueDoc(householdId, `r${i}`, newest - (count - 1 - i) * 60_000));

const byAt = (entries: Entry[]) => entries.filter((e) => e.document).sort((a, b) => Number((a.document!.fields!.at as { integerValue: string }).integerValue) - Number((b.document!.fields!.at as { integerValue: string }).integerValue));

const writesOf = (calls: Call[]) =>
  calls.filter((c) => c.url === `${DOCS}:batchWrite`).map((c) => (c.body as { writes: { update: { name: string; fields: unknown }; updateMask: unknown; currentDocument: unknown }[] }).writes);
const deletesOf = (calls: Call[]) =>
  calls.filter((c) => c.url === `${DOCS}:batchWrite`).flatMap((c) => (c.body as { writes: { delete?: string; currentDocument: unknown }[] }).writes.filter((w) => w.delete));
const shortName = (name: string) => name.split('/documents/')[1];

async function decryptPush(body: Bytes): Promise<Record<string, unknown>> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const ua = await importKeyPair(v.ua_public, v.ua_private, 'ECDH');
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const { cek, nonce } = await deriveKeys(secret, fromB64url(v.ua_shared), fromB64url(v.ua_public), asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

const subs = (subscriptions.documents as Parameters<typeof toSubscription>[0][]).map((d) => toSubscription(d)!) as Subscription[];
const reminders = due.filter((r) => r.document).map((r) => toReminder(r.document as never)!);

beforeEach(resetTokenCache);

describe('targets', () => {
  const members = ['alex@example.com', 'sam@example.com'];

  test("'all' reaches every member; the reminder's own app is preferred, else all their devices", () => {
    // Pet reminder: Alex turned notifications on in Pet; Sam only in Tasks.
    expect(targets(reminders[0], members, subs).map((s) => s.endpoint)).toEqual([
      'https://push.example.net/alex-phone-pet',
      'https://push.example.net/tablet-tasks',
      'https://gone.example.org/sam-old-laptop',
    ]);
  });

  test('a device two recipients share gets it once', () => {
    const tasks = { ...reminders[0], app: 'tasks' };
    expect(targets(tasks, members, subs).map((s) => s.endpoint)).toEqual([
      'https://push.example.net/alex-phone-tasks',
      'https://push.example.net/tablet-tasks',
      'https://gone.example.org/sam-old-laptop',
    ]);
  });

  test('a list reaches only those listed who are still members, whatever the case of their email', () => {
    expect(reminders[1].recipients).toEqual(['sam@example.com', 'mallory@example.com']);
    expect(targets(reminders[1], members, subs).map((s) => s.name.split('/').pop())).toEqual(['sam-tasks-tablet', 'sam-tasks-old']);
    expect(targets(reminders[1], ['alex@example.com'], subs)).toEqual([]);
  });
});

describe('muted apps', () => {
  const members = ['alex@example.com', 'sam@example.com'];

  test("a member who muted the reminder's app gets none of its reminders; other apps still reach them", () => {
    const muted = new Map([['sam@example.com', ['pet']]]);
    expect(targets(reminders[0], members, subs, {}, muted).map((s) => s.email)).toEqual(['alex@example.com']);
    expect(targets({ ...reminders[0], app: 'tasks' }, members, subs, {}, muted).map((s) => s.email)).toContain('sam@example.com');
  });

  test('a run reads the preferences and skips the muted member', async () => {
    const prefs = { documents: [{ name: `${DOCS}/households/h1/notificationPrefs/sam@example.com`, fields: { muted: { arrayValue: { values: [{ stringValue: 'pet' }] } }, updatedAt: { integerValue: '1' } } }] };
    const { fetchImpl, calls } = stubFetch(routes({ due: [due[0]], prefs: (h) => (h === 'h1' ? prefs : undefined) }));
    await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(calls.filter(isPush).map((c) => c.url)).toEqual(['https://push.example.net/alex-phone-pet']);
  });

  test('toMuted reads the email from the document name', () => {
    expect(toMuted({ name: `${DOCS}/households/h1/notificationPrefs/Sam@example.com`, fields: { muted: { arrayValue: { values: [{ stringValue: 'bills' }, { integerValue: '3' }] } } } } as never)).toEqual(['sam@example.com', ['bills']]);
  });
});

describe('roles', () => {
  const members = ['alex@example.com', 'sam@example.com'];
  const roles = { 'sam@example.com': 'helper' };

  test('a private reminder skips helpers and kids; an open one reaches everyone', () => {
    const open = { ...reminders[0], private: false };
    const secret = { ...reminders[0], private: true };
    expect(targets(open, members, subs, roles).map((s) => s.email)).toContain('sam@example.com');
    expect(targets(secret, members, subs, roles).map((s) => s.email)).toEqual(['alex@example.com']);
    expect(targets(secret, members, subs, { 'sam@example.com': 'kid' }).map((s) => s.email)).toEqual(['alex@example.com']);
    // Without roles, everyone is an admin or member.
    expect(targets(secret, members, subs).map((s) => s.email)).toContain('sam@example.com');
  });

  test('money reminders and ones written before the flag are private; open ones say so', () => {
    const doc = (fields: Record<string, unknown>) => ({ ...(reminders[0].doc as object), fields: { ...(reminders[0].doc as { fields: object }).fields, ...fields } });
    expect(toReminder(doc({}) as never)!.private).toBe(true);
    expect(toReminder(doc({ private: { booleanValue: false } }) as never)!.private).toBe(false);
    expect(toReminder(doc({ private: { booleanValue: false }, app: { stringValue: 'bills' } }) as never)!.private).toBe(true);
    expect(roleOf('alex@example.com', members)).toBe('admin');
    expect(roleOf('sam@example.com', members)).toBe('member');
  });
});

describe('toReminder', () => {
  test('reads the household and reminder ids from the document path', () => {
    expect(reminders[0]).toMatchObject({ id: 'pet-c1-20260101-1155', householdId: 'h1', app: 'pet', at: NOW - 60_000, recipients: 'all' });
  });

  test('drops a non-https link rather than sending it', () => {
    const doc = structuredClone(due[0].document!) as never as Parameters<typeof toReminder>[0];
    doc.fields!.url = { stringValue: 'javascript:alert(1)' };
    expect(toReminder(doc)!.url).toBe('/');
  });

  test('with LINK_HOSTS, only links to those hosts are sent', () => {
    const hosts = linkHosts('example-family.web.app example-*.web.app');
    const doc = structuredClone(due[0].document!) as never as Parameters<typeof toReminder>[0];
    const linkOf = (url: string) => {
      doc.fields!.url = { stringValue: url };
      return toReminder(doc, hosts)!.url;
    };
    expect(linkOf('https://example-family.web.app/pet/meds/c1')).toBe('https://example-family.web.app/pet/meds/c1');
    expect(linkOf('https://example-pet.web.app/?tab=care')).toBe('https://example-pet.web.app/?tab=care');
    expect(linkOf('https://evil.example.com/')).toBe('/');
    expect(linkOf('https://example-family.web.app.evil.example.com/')).toBe('/');
    expect(linkOf('https://x.example-pet.web.app/')).toBe('/');
    expect(linkOf('http://example-family.web.app/')).toBe('/');
  });

  test('safeLink without hosts keeps any https link', () => {
    expect(safeLink('https://anything.example.org/x')).toBe('https://anything.example.org/x');
    expect(safeLink(42)).toBe('/');
  });

  test('payload is what the kit service worker reads', () => {
    expect(JSON.parse(payload(reminders[0]))).toEqual({
      title: 'Biscuit: 1 tablet',
      body: 'Example-ol 25 mg, with food',
      url: 'https://example-pet.web.app/meds/c1',
      tag: 'pet-c1-20260101-1155',
      app: 'pet',
    });
  });
});

describe('each device in its own language', () => {
  const base = due.find((e) => e.document)!.document as unknown as Parameters<typeof toReminder>[0];
  const str = (v: string) => ({ stringValue: v });
  const text = (title: string, body: string) => ({ mapValue: { fields: { title: str(title), body: str(body) } } });
  const withTexts = { ...base, fields: { ...base.fields, texts: { mapValue: { fields: { es: text('Biscuit: 1 tableta', 'Example-ol 25 mg, con comida'), nl: text('Biscuit: 1 tablet', 'Example-ol 25 mg, met eten'), fr: text('x', 'y') } } } } } as Parameters<typeof toReminder>[0];

  test('a reminder keeps its texts in known languages', () => {
    const r = toReminder(withTexts)!;
    expect(Object.keys(r.texts).sort()).toEqual(['es', 'nl']);
    expect(toTexts({ es: { title: '', body: 'x' }, nl: { title: 'Hoi' }, en: 'no' })).toEqual({ nl: { title: 'Hoi', body: '' } });
    expect(toTexts(null)).toEqual({});
    expect(toReminder(base)!.texts).toEqual({});
  });

  test('the payload is in the device language, else the reminder title and body', () => {
    const r = toReminder(withTexts)!;
    expect(JSON.parse(payload(r, 'es'))).toMatchObject({ title: 'Biscuit: 1 tableta', body: 'Example-ol 25 mg, con comida' });
    expect(JSON.parse(payload(r, 'en')).title).toBe(r.title);
    expect(JSON.parse(payload(r)).title).toBe(r.title);
    expect(JSON.parse(payload(toReminder(base)!, 'nl')).title).toBe(r.title);
  });

  test('a subscription carries its language when it has a known one', () => {
    const sub = subscriptions.documents[0] as unknown as Parameters<typeof toSubscription>[0];
    expect(toSubscription(sub)!.lang).toBeUndefined();
    expect(toSubscription({ ...sub, fields: { ...sub.fields, lang: str('nl') } } as typeof sub)!.lang).toBe('nl');
    expect(toSubscription({ ...sub, fields: { ...sub.fields, lang: str('fr') } } as typeof sub)!.lang).toBeUndefined();
  });

  test('a run sends each device its own language', async () => {
    const subs = structuredClone(subscriptions);
    for (const d of subs.documents) (d.fields as Record<string, unknown>).lang = str('es');
    const reminderDue = due.map((e) => (e.document && e.document.name === base.name ? { ...e, document: withTexts } : e)) as typeof due;
    const { fetchImpl, calls } = stubFetch(routes({ due: reminderDue as never, subs: (id) => (id === 'h1' ? subs : oneDevice(id)) }));
    await run(await testEnv(), NOW, fetchImpl as never, quiet);
    expect(calls.filter(isPush).length).toBeGreaterThan(0);
  });
});

describe('reminders for named members only', () => {
  const doc = personalDue[0].document as unknown as Parameters<typeof toReminder>[0];
  const withFields = (fields: Record<string, unknown>) => ({ ...doc, fields: { ...doc.fields, ...fields } }) as Parameters<typeof toReminder>[0];

  test('reads a personalReminders document with its audience', () => {
    const r = toReminder(doc)!;
    expect(r).toMatchObject({ householdId: 'h1', app: 'health', personal: true, audience: ['alex@example.com', 'sam@example.com'], recipients: ['sam@example.com', 'outsider@example.com'] });
    expect(toReminder(withFields({ recipients: { stringValue: 'all' } }))).toBeNull();
    expect(toReminder(withFields({ audience: { arrayValue: {} } }))).toBeNull();
  });

  test('goes only to recipients who are members, in the audience and not kids, private or not', () => {
    const r = toReminder(doc)!;
    const subs = (subscriptions.documents as unknown as Parameters<typeof toSubscription>[0][]).map(toSubscription).filter((s): s is Subscription => !!s);
    const members = ['alex@example.com', 'sam@example.com', 'kid@example.com'];
    expect([...new Set(targets(r, members, subs).map((s) => s.email))]).toEqual(['sam@example.com']);
    // Sam as a helper still gets it: the audience, not the private flag, decides.
    expect([...new Set(targets(r, members, subs, { 'sam@example.com': 'helper' }).map((s) => s.email))]).toEqual(['sam@example.com']);
    expect(targets(r, members, subs, { 'sam@example.com': 'kid' })).toEqual([]);
    // A recipient left out of the audience gets nothing.
    expect(targets({ ...r, audience: ['alex@example.com'] }, members, subs)).toEqual([]);
  });
});

describe('fairOrder', () => {
  test('round-robin across households, ordered by their oldest due reminder, at most the cap each', () => {
    const r = (h: string, id: string, at: number) => toReminder(dueDoc(h, id, at).document as never)!;
    const mixed = [r('x', 'x1', NOW - 10), r('y', 'y1', NOW - 30), r('z', 'z1', NOW - 20), r('y', 'y2', NOW - 5), r('z', 'z2', NOW - 1), r('y', 'y3', NOW)];
    const { order, capped } = fairOrder(mixed, 2);
    expect(order.map((x) => x.id)).toEqual(['y1', 'z1', 'x1', 'y2', 'z2']);
    expect(capped).toBe(1);
  });
});

describe('readsPerRun', () => {
  test('1/288 of the day, at least one; unset or zero: no limit; anything else throws', () => {
    expect(readsPerRun('3000')).toBe(10);
    expect(readsPerRun('100')).toBe(1);
    for (const v of [undefined, '', '0']) expect(readsPerRun(v)).toBe(Infinity);
    for (const v of ['-5', 'lots', '3,000', '3k']) expect(() => readsPerRun(v)).toThrow('FIRESTORE_NOTIFY_READS');
  });
});

describe('run', () => {
  test('sends what is due, marks it sent, removes subscriptions the push service dropped', async () => {
    const { fetchImpl, calls } = stubFetch(routes());
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    // Both reminders reach the dropped laptop; it is deleted once.
    // Reads: 3 due and the empty personal query (1), the household (1), its 5 subscriptions and no prefs (1).
    expect(stats).toEqual({ due: 3, sent: 2, pushed: 3, failed: 2, removed: 1, late: 1, invalid: 0, raced: 0, noDevices: 0, capped: 0, done: 0, deferred: false, reads: 11 });

    // The oldest-first window isn't full, so it holds everything due: no newest-first query.
    const queries = calls.filter((c) => c.url.endsWith(':runQuery'));
    expect(queries.map((q) => `${collectionOf(q)} ${directionOf(q)}`)).toEqual(['reminders ASCENDING', 'personalReminders ASCENDING']);
    expect(queries[0].body).toEqual({
      structuredQuery: {
        from: [{ collectionId: 'reminders', allDescendants: true }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'sent' }, op: 'EQUAL', value: { booleanValue: false } } },
              { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(NOW) } } },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
        limit: 50,
      },
    });
    // One token request serves both queries.
    expect(calls.filter((c) => c.url.startsWith('https://oauth2.'))).toHaveLength(1);

    // One batchWrite marks the stale reminder and claims the others, each conditional on the version
    // that was read, setting only sent and sentAt.
    const [writes, ...more] = writesOf(calls);
    expect(more).toHaveLength(0);
    expect(writes.map((w) => shortName(w.update.name))).toEqual(['households/h2/reminders/pet-stale', 'households/h1/reminders/pet-c1-20260101-1155', 'households/h1/reminders/tasks-bins']);
    expect(writes[1]).toEqual({
      update: { name: due[0].document!.name, fields: { sent: { booleanValue: true }, sentAt: { integerValue: String(NOW) } } },
      updateMask: { fieldPaths: ['sent', 'sentAt'] },
      currentDocument: { updateTime: '2026-01-01T00:00:01.000001Z' },
    });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    // The stale reminder (13 hours late, household h2) is marked without reading its household or pushing.
    expect(calls.some((c) => c.url.includes('/households/h2') && c.method === 'GET')).toBe(false);
    // Household h1 is read once for both of its reminders.
    expect(calls.filter((c) => c.method === 'GET' && c.url === `${DOCS}/households/h1`)).toHaveLength(1);

    // Pushes go out together, after the claim, so their order is not fixed.
    const pushes = calls.filter(isPush);
    expect(pushes.map((c) => c.url).sort()).toEqual([
      'https://gone.example.org/sam-old-laptop',
      'https://gone.example.org/sam-old-laptop',
      'https://push.example.net/alex-phone-pet',
      'https://push.example.net/tablet-tasks',
      'https://push.example.net/tablet-tasks',
    ]);
    const claim = calls.findIndex((c) => c.url.endsWith(':batchWrite'));
    for (const p of pushes) expect(calls.indexOf(p)).toBeGreaterThan(claim);
    const sent = await Promise.all(pushes.map((p) => decryptPush(p.body as Bytes)));
    expect(sent.filter((m) => m.tag === 'pet-c1-20260101-1155')).toEqual(Array(3).fill(JSON.parse(payload(reminders[0]))));
    expect(sent.filter((m) => m.tag === 'tasks-bins')).toEqual(Array(2).fill(expect.objectContaining({ title: 'Bins out tonight', app: 'tasks' })));

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual([`${DOCS}/households/h1/pushSubscriptions/sam-tasks-old`]);
  });

  test('a reminder changed or claimed since it was read is not sent', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ write: (name) => (name.includes('pet-c1') ? 'precondition' : undefined) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ sent: 1, raced: 1, pushed: 1, late: 1 });
    expect(calls.filter(isPush).map((c) => c.url).sort()).toEqual(['https://gone.example.org/sam-old-laptop', 'https://push.example.net/tablet-tasks']);
  });

  test('send-once: deleted or contended claims are raced too, and nothing of theirs is pushed', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ write: (name) => (name.includes('pet-c1') ? 'notFound' : name.includes('tasks-bins') ? 'aborted' : undefined) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ sent: 0, raced: 2, pushed: 0, late: 1 });
    expect(calls.filter(isPush)).toHaveLength(0);
  });

  test('a batchWrite that fails outright stops the run before any push', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ batchWrite: () => json({ error: { code: 500, message: 'boom', status: 'INTERNAL' } }, 500) }));
    await expect(run(await testEnv(), NOW, fetchImpl, quiet)).rejects.toThrow('[500] Firestore batchWrite: INTERNAL boom');
    expect(calls.filter(isPush)).toHaveLength(0);
  });

  test('a write failing for another reason is not pushed; the rest go out, then the run fails', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ write: (name) => (name.includes('pet-c1') ? 'internal' : undefined) }));
    await expect(run(await testEnv(), NOW, fetchImpl, quiet)).rejects.toThrow('Firestore batchWrite: 1 of 3 writes failed (code 13: Internal error encountered.)');
    expect(calls.filter(isPush).map((c) => c.url).sort()).toEqual(['https://gone.example.org/sam-old-laptop', 'https://push.example.net/tablet-tasks']);
  });

  test('late and malformed reminders are marked in the same single batchWrite; raced marks are counted', async () => {
    const late = backlog('h3', 4, NOW - 13 * 3600_000);
    const broken = structuredClone(dueDoc('h4', 'no-title', NOW - 1000));
    delete broken.document!.fields!.title;
    const { fetchImpl, calls } = stubFetch(
      routes({ due: byAt([...late, broken, ...due]), write: (name) => (name.endsWith('/h3/reminders/r0') ? 'precondition' : name.endsWith('/no-title') ? 'notFound' : undefined) }),
    );
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ due: 8, late: 4, invalid: 0, raced: 2, sent: 2 });
    const batches = writesOf(calls);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((w) => shortName(w.update.name))).toEqual([
      'households/h3/reminders/r0',
      'households/h3/reminders/r1',
      'households/h3/reminders/r2',
      'households/h2/reminders/pet-stale',
      'households/h3/reminders/r3',
      'households/h4/reminders/no-title',
      'households/h1/reminders/pet-c1-20260101-1155',
      'households/h1/reminders/tasks-bins',
    ]);
    expect(calls.some((c) => c.method === 'GET' && /households\/h[34]/.test(c.url))).toBe(false);

    const ok = stubFetch(routes({ due: byAt([broken, ...due]) }));
    expect(await run(await testEnv(), NOW, ok.fetchImpl, quiet)).toMatchObject({ invalid: 1, late: 1, raced: 0 });
  });

  test('a failed push is counted and logged; the subscription stays', async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = stubFetch(routes({ push: (c) => (c.url.includes('alex-phone-pet') ? new Response(null, { status: 503 }) : undefined) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    expect(stats).toMatchObject({ pushed: 2, failed: 3, removed: 1 });
    expect(lines).toEqual(['push to push.example.net failed: 503']);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  test('one household with a backlog shares the run: round-robin, at most the cap, the rest counted as capped', async () => {
    // Household a: 40 due, oldest first. Household b: one, the newest.
    const a = backlog('a', 40, NOW - 60_000);
    const b = dueDoc('b', 'only', NOW - 1000);
    const { fetchImpl, calls } = stubFetch(routes({ due: [...a, b] }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ due: 41, sent: PER_HOUSEHOLD_CAP + 1, pushed: PER_HOUSEHOLD_CAP + 1, capped: 40 - PER_HOUSEHOLD_CAP, deferred: true });
    const [claims] = writesOf(calls);
    expect(claims.map((w) => shortName(w.update.name).replace('households/', ''))).toEqual([
      'a/reminders/r0',
      'b/reminders/only',
      ...Array.from({ length: PER_HOUSEHOLD_CAP - 1 }, (_, i) => `a/reminders/r${i + 1}`),
    ]);
    expect(calls.filter(isPush).map((c) => c.url)).toContain('https://push.example.net/b-tablet');
  });

  test('a backlog that fills the whole oldest-first window still lets the newest household through', async () => {
    const a = backlog('a', 60, NOW - 60_000);
    const b = dueDoc('b', 'only', NOW - 1000);
    const { fetchImpl, calls } = stubFetch(routes({ due: [...a, b] }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    const [oldest] = calls.filter((c) => c.url.endsWith(':runQuery'));
    expect(oldest.body).toMatchObject({ structuredQuery: { limit: 50 } });
    // The oldest-first window is all household a; b comes from the newest-first one.
    expect(stats).toMatchObject({ due: 61, sent: PER_HOUSEHOLD_CAP + 1, capped: 50, deferred: true });
    expect(writesOf(calls)[0].map((w) => shortName(w.update.name))).toContain('households/b/reminders/only');
  });

  test('falls back to the oldest-first window, with one log line, while the newest-first index is missing', async () => {
    const lines: string[] = [];
    // A full oldest-first window, so the newest-first query is asked for.
    const { fetchImpl } = stubFetch(routes({ due: backlog('h1', 50, NOW - 1000), newest: () => json(indexMissing, 400) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    expect(stats).toMatchObject({ due: 50, sent: PER_HOUSEHOLD_CAP, deferred: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('newest-first query failed, using the oldest-first window only: [400] Firestore runQuery: FAILED_PRECONDITION The query requires an index.');
  });

  test('the newest-first query runs only when the oldest-first window is full', async () => {
    const run49 = stubFetch(routes({ due: backlog('h1', 49, NOW - 1000) }));
    await run(await testEnv(), NOW, run49.fetchImpl, quiet);
    expect(run49.calls.filter((c) => c.url.endsWith(':runQuery')).map(directionOf)).toEqual(['ASCENDING', 'ASCENDING']);
    resetTokenCache();
    const run50 = stubFetch(routes({ due: backlog('h1', 50, NOW - 1000) }));
    await run(await testEnv(), NOW, run50.fetchImpl, quiet);
    expect(run50.calls.filter((c) => c.url.endsWith(':runQuery')).map((c) => `${collectionOf(c)} ${directionOf(c)}`)).toEqual([
      'reminders ASCENDING',
      'personalReminders ASCENDING',
      'reminders DESCENDING',
    ]);
  });

  test('a quiet run is billed two reads: the two empty queries', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ due: [] }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ due: 0, sent: 0, reads: 2, deferred: false });
    expect(calls.filter((c) => c.url.startsWith('https://firestore.googleapis.com'))).toHaveLength(2);
  });

  test('FIRESTORE_NOTIFY_READS: households past the run\'s share wait for a later run, unsent and unmarked', async () => {
    const dueBoth = byAt([dueDoc('h1', 'a', NOW - 2000), dueDoc('h2', 'b', NOW - 1000)]);
    // 2,880 a day is 10 a run: the queries (3) and h1 (1 + 5 subscriptions + 1) use 10, so h2 waits.
    const tight = stubFetch(routes({ due: dueBoth }));
    const stats = await run({ ...(await testEnv()), FIRESTORE_NOTIFY_READS: '2880' }, NOW, tight.fetchImpl, quiet);
    expect(stats).toMatchObject({ due: 2, sent: 1, deferred: true, reads: 10 });
    expect(writesOf(tight.calls)[0].map((w) => shortName(w.update.name))).toEqual(['households/h1/reminders/a']);
    expect(tight.calls.some((c) => c.url.includes('/households/h2'))).toBe(false);
    // Unset: both go.
    resetTokenCache();
    const open = stubFetch(routes({ due: dueBoth }));
    expect(await run(await testEnv(), NOW, open.fetchImpl, quiet)).toMatchObject({ sent: 2, deferred: false });
  });

  test("a full oldest-first window still asks for the newest-first one past the run's share", async () => {
    const { fetchImpl, calls } = stubFetch(routes({ due: [...backlog('h1', 60, NOW - 60_000), dueDoc('h2', 'only', NOW - 1000)] }));
    const stats = await run({ ...(await testEnv()), FIRESTORE_NOTIFY_READS: '2880' }, NOW, fetchImpl, quiet);
    expect(calls.filter((c) => c.url.endsWith(':runQuery')).map(directionOf)).toEqual(['ASCENDING', 'ASCENDING', 'DESCENDING']);
    // The share is spent on the queries: the first household in order is read, the other waits.
    expect(stats).toMatchObject({ sent: PER_HOUSEHOLD_CAP, deferred: true });
  });

  test('a budget too small for any household still sends the first one each run', async () => {
    const { fetchImpl } = stubFetch(routes({ due: [dueDoc('h1', 'a', NOW - 1000)] }));
    expect(await run({ ...(await testEnv()), FIRESTORE_NOTIFY_READS: '1' }, NOW, fetchImpl, quiet)).toMatchObject({ sent: 1 });
  });

  test('stops within the subrequest budget, never claiming a reminder it cannot finish', async () => {
    // Household h1: 50 reminders of 3 devices each, one of them dropped. Token, three queries, three
    // household reads and the batchWrite (8), then 3 pushes for each of the 10 the cap allows, and
    // the one 410 delete.
    const many = backlog('h1', 50, NOW - 1000);
    const { fetchImpl, calls } = stubFetch(routes({ due: many }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ sent: 10, pushed: 20, failed: 10, removed: 1, capped: 40, deferred: true });
    expect(calls).toHaveLength(8 + 30 + 1);
  });

  test('many households: every run fits in the budget, and each claimed reminder gets all its pushes', async () => {
    const scenarios: { name: string; due: Entry[]; subs?: (h: string) => unknown }[] = [
      { name: '30 households of 2, one device each', due: byAt(Array.from({ length: 30 }, (_, h) => backlog(`h${h + 10}`, 2, NOW - h * 1000)).flat()) },
      { name: '20 households of 5, three devices each, one dropped', due: byAt(Array.from({ length: 20 }, (_, h) => backlog(`h${h + 10}`, 5, NOW - h * 1000)).flat()), subs: () => subscriptions },
      { name: 'one household of 2, plus 49 late', due: byAt([...backlog('late', 49, NOW - 13 * 3600_000), ...backlog('h5', 2, NOW)]) },
      { name: 'one reminder, 12 devices, and 40 households', due: byAt([dueDoc('h1', 'big', NOW - 3_600_000), ...Array.from({ length: 40 }, (_, h) => dueDoc(`h${h + 10}`, 'r', NOW - h * 1000))]), subs: (h) => (h === 'h1' ? manyDevices(12) : undefined) },
    ];
    for (const s of scenarios) {
      resetTokenCache();
      const { fetchImpl, calls } = stubFetch(routes({ due: s.due, subs: s.subs }));
      const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
      expect({ name: s.name, within: calls.length <= SUBREQUEST_BUDGET }).toEqual({ name: s.name, within: true });
      // Each claimed reminder went to all of its devices: the budget never cut a reminder short.
      const claims = writesOf(calls)[0].filter((w) => !w.update.name.includes('/late/'));
      const perReminder = s.subs?.('h10') === subscriptions ? 3 : 1;
      const devices = claims.reduce((n, w) => n + (w.update.name.includes('/big') ? 12 : perReminder), 0);
      expect({ name: s.name, pushes: calls.filter(isPush).length }).toEqual({ name: s.name, pushes: devices });
      expect(stats.sent).toBe(claims.length);
      expect(stats.deferred).toBe(s.name.includes('late') ? false : true);
    }
  });

  test('a reminder with more devices than any run allows reaches as many as fit', async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = stubFetch(routes({ due: [due[0]], subs: () => manyDevices(60) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    // Token, two queries, three household reads and the batchWrite leave 38.
    expect(stats).toMatchObject({ sent: 1, pushed: 38 });
    expect(lines).toEqual(['reminder has 60 devices; sending to 38']);
    expect(calls).toHaveLength(SUBREQUEST_BUDGET);
  });

  test('sends due personal reminders from the same run, marked in the same batchWrite', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ personal: () => json(personalDue) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats.sent).toBe(3);
    const [writes] = writesOf(calls);
    expect(writes.map((w) => shortName(w.update.name))).toContain('households/h1/personalReminders/health-dose-p1-0800');
    // Only Sam's two devices on top of the shared run (Alex is in the audience but not a recipient;
    // the outsider isn't a member).
    resetTokenCache();
    const shared = stubFetch(routes());
    await run(await testEnv(), NOW, shared.fetchImpl, quiet);
    expect(calls.filter(isPush).length - shared.calls.filter(isPush).length).toBe(2);
  });

  test('a missing personalReminders index leaves the shared reminders going out', async () => {
    const lines: string[] = [];
    const { fetchImpl } = stubFetch(routes({ personal: () => json(indexMissing, 400) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    expect(stats.sent).toBe(2);
    expect(lines.some((l) => l.startsWith('personal reminders query failed'))).toBe(true);
  });

  test('says which setting is missing', async () => {
    const env = await testEnv();
    await expect(run({ ...env, VAPID_PRIVATE_KEY: '' }, NOW, stubFetch([]).fetchImpl)).rejects.toThrow(/VAPID_PRIVATE_KEY/);
    await expect(run({ ...env, GOOGLE_SERVICE_ACCOUNT: '' }, NOW, stubFetch([]).fetchImpl)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT/);
  });
});

describe('reminders with a source', () => {
  // Rent was paid from the portal's To-do list, Water is still due, Phone's bill was removed; a
  // second Rent reminder names the same bill.
  const entries = sourceDue as Entry[];
  const asked = (calls: Call[]) => calls.filter((c) => c.url === `${DOCS}:batchGet`).map((c) => (c.body as { documents: string[] }).documents.map(shortName));

  test('a paid bill is deleted unsent, an unpaid one sent, a removed one deleted: one read for the household', async () => {
    const { fetchImpl, calls } = stubFetch(routes({ due: entries }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ due: 4, sent: 1, done: 3, raced: 0 });
    // One batchGet, each bill once.
    expect(asked(calls)).toEqual([['households/h1/bills/rent', 'households/h1/bills/water', 'households/h1/bills/phone']]);
    const [writes] = writesOf(calls);
    expect(writes.filter((w) => w.update).map((w) => shortName(w.update.name))).toEqual(['households/h1/reminders/bills-water-due']);
    // Deleted in the same batchWrite, each only if unchanged since it was read.
    expect(deletesOf(calls).map((w) => [shortName(w.delete!), w.currentDocument])).toEqual([
      ['households/h1/reminders/bills-rent-due', { updateTime: '2026-01-01T00:00:03.000003Z' }],
      ['households/h1/reminders/bills-phone-due', { updateTime: '2026-01-01T00:00:05.000005Z' }],
      ['households/h1/reminders/bills-rent-again', { updateTime: '2026-01-01T00:00:06.000006Z' }],
    ]);
    expect(calls.filter((c) => c.method === 'DELETE' && c.url.includes('/reminders/'))).toHaveLength(0);
    const pushed = await Promise.all(calls.filter(isPush).filter((c) => c.url.includes('push.example.net')).map((c) => decryptPush(c.body as Bytes).catch(() => null)));
    expect(pushed.filter(Boolean).map((p) => p!.title)).not.toContain('Rent due today');
  });

  test('a reminder edited since it was read is not deleted: raced', async () => {
    const { fetchImpl } = stubFetch(routes({ due: entries, write: (name) => (name.endsWith('/bills-rent-due') ? 'precondition' : undefined) }));
    expect(await run(await testEnv(), NOW, fetchImpl, quiet)).toMatchObject({ sent: 1, done: 2, raced: 1 });
  });

  test('a source read that fails sends the reminders as before, with one log line', async () => {
    const lines: string[] = [];
    const { fetchImpl } = stubFetch(routes({ due: entries, batchGet: () => json({ error: { status: 'PERMISSION_DENIED', message: 'no' } }, 403) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    expect(stats).toMatchObject({ sent: 4, done: 0 });
    expect(lines).toEqual(['source read failed, sending without it: [403] Firestore batchGet: PERMISSION_DENIED no']);
  });

  test('without sources nothing extra is read', async () => {
    const { calls } = await (async () => {
      const s = stubFetch(routes());
      await run(await testEnv(), NOW, s.fetchImpl, quiet);
      return s;
    })();
    expect(asked(calls)).toEqual([]);
  });

  test("a source naming another app's records is ignored: the reminder is sent and nothing is read", async () => {
    const odd = structuredClone(entries[0]);
    const check = (odd.document!.fields!.source as { mapValue: { fields: { checks: { arrayValue: { values: { mapValue: { fields: { doc: { stringValue: string } } } }[] } } } } }).mapValue.fields.checks.arrayValue.values[0];
    check.mapValue.fields.doc.stringValue = 'spendingTransactions/t1';
    const { fetchImpl, calls } = stubFetch(routes({ due: [odd] }));
    expect(await run(await testEnv(), NOW, fetchImpl, quiet)).toMatchObject({ sent: 1, done: 0 });
    expect(asked(calls)).toEqual([]);
  });

  test("only a source its writer may use counts: a current member whose role may read those records", () => {
    const rent = toReminder(entries[0].document as never)!;
    const paid = new Map([['bills/rent', { status: 'paid', due: '2026-01-01' }]]);
    const home = { members: ['alex@example.com', 'sam@example.com'], roles: {} };
    expect(sourceDone(rent, home, paid)).toBe(true);
    // A helper can't see bills, so a helper's bill source is ignored and the reminder goes out.
    expect(sourceDone({ ...rent, by: 'sam@example.com' }, { ...home, roles: { 'sam@example.com': 'helper' } }, paid)).toBe(false);
    expect(sourceDone({ ...rent, by: 'mallory@example.com' }, home, paid)).toBe(false);
    expect(sourceDone({ ...rent, by: '' }, home, paid)).toBe(false);
    // Health: only one of the person's readers.
    const dose = { ...rent, app: 'health', personal: true, source: { checks: [{ doc: 'healthPeople/p1/doses/m1_0800', absent: true as const }] } };
    const given = (readers: string[]) => new Map<string, Record<string, unknown> | null>([['healthPeople/p1/doses/m1_0800', { status: 'given' }], ['healthPeople/p1', { readers }]]);
    expect(sourceDone({ ...dose, by: 'sam@example.com' }, home, given(['sam@example.com']))).toBe(true);
    // On a shared reminder, which every member reads, a Health source doesn't count.
    expect(sourceDone({ ...dose, personal: false, by: 'sam@example.com' }, home, given(['sam@example.com']))).toBe(false);
    expect(sourceDone({ ...dose, by: 'sam@example.com' }, home, given(['alex@example.com']))).toBe(false);
  });

  test("a writer who isn't a member any more: the source is ignored and the reminder sent", async () => {
    const gone = structuredClone(entries[0]);
    (gone.document!.fields!.by as { stringValue: string }).stringValue = 'mallory@example.com';
    const { fetchImpl } = stubFetch(routes({ due: [gone] }));
    expect(await run(await testEnv(), NOW, fetchImpl, quiet)).toMatchObject({ sent: 1, done: 0 });
  });

  test('a household with sources costs one more request, and still fits the budget', async () => {
    const plain = stubFetch(routes({ due: [due[0]] }));
    await run(await testEnv(), NOW, plain.fetchImpl, quiet);
    resetTokenCache();
    const one = stubFetch(routes({ due: [entries[1]] }));
    const stats = await run(await testEnv(), NOW, one.fetchImpl, quiet);
    expect(stats).toMatchObject({ sent: 1, done: 0 });
    const firestore = (calls: Call[]) => calls.filter((c) => c.url.startsWith('https://firestore.googleapis.com')).length;
    expect(firestore(one.calls)).toBe(firestore(plain.calls) + 1);

    // Many households, each with a sourced reminder: every run stays within the budget.
    resetTokenCache();
    const many = Array.from({ length: 30 }, (_, h) => {
      const e = structuredClone(entries[1]);
      e.document!.name = e.document!.name.replace('/h1/', `/h${h + 10}/`);
      return e;
    });
    // Each household's Water bill is still due.
    const water = batchGetBills.responses[1].found!;
    const unpaid: Route = (c) => json((c.body as { documents: string[] }).documents.map((name) => ({ found: { ...water, name }, readTime: '2026-01-01T12:00:00.000000Z' })));
    const crowd = stubFetch(routes({ due: many, batchGet: unpaid }));
    const crowdStats = await run(await testEnv(), NOW, crowd.fetchImpl, quiet);
    expect(crowd.calls.length).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(crowdStats).toMatchObject({ deferred: true, done: 0 });
    expect(crowdStats.sent).toBeGreaterThan(0);
  });
});

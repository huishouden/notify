import { beforeEach, describe, expect, test } from 'bun:test';
import { fromB64url, type Bytes } from '../src/b64';
import { importKeyPair, deriveKeys } from '../src/webpush';
import { resetTokenCache } from '../src/google';
import { payload, roleOf, run, SUBREQUEST_BUDGET, targets, toReminder, toSubscription, type Subscription } from '../src/send';
import due from './fixtures/due-reminders.json';
import household from './fixtures/household-h1.json';
import subscriptions from './fixtures/subscriptions-h1.json';
import tokenResponse from './fixtures/token-response.json';
import preconditionFailed from './fixtures/precondition-failed.json';
import v from './fixtures/rfc8291.json';
import { json, stubFetch, testEnv, type Call, type Route } from './helpers';

const NOW = 1_767_268_800_000;
const DOCS = 'https://firestore.googleapis.com/v1/projects/demo-huishouden/databases/(default)/documents';
const quiet = () => {};

const isPush = (c: Call) => !c.url.startsWith('https://firestore.googleapis.com') && !c.url.startsWith('https://oauth2.');

function routes(over: { due?: unknown; patch?: Route; push?: Route } = {}): Route[] {
  return [
    (c) => (c.url === 'https://oauth2.googleapis.com/token' ? json(tokenResponse) : undefined),
    (c) => (c.url === `${DOCS}:runQuery` ? json(over.due ?? due) : undefined),
    (c) => (c.method === 'GET' && c.url === `${DOCS}/households/h1` ? json(household) : undefined),
    (c) => (c.method === 'GET' && c.url === `${DOCS}/households/h1/pushSubscriptions?pageSize=300` ? json(subscriptions) : undefined),
    (c) => (c.method === 'PATCH' ? (over.patch?.(c) ?? json({})) : undefined),
    (c) => (c.method === 'DELETE' ? json({}) : undefined),
    (c) => (isPush(c) ? (over.push?.(c) ?? new Response(null, { status: c.url.includes('gone.example.org') ? 410 : 201 })) : undefined),
  ];
}

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

describe('run', () => {
  test('sends what is due, marks it sent, removes subscriptions the push service dropped', async () => {
    const { fetchImpl, calls } = stubFetch(routes());
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toEqual({ due: 3, sent: 2, pushed: 3, failed: 1, removed: 1, late: 1, invalid: 0, raced: 0, noDevices: 0, deferred: false });

    expect(calls.find((c) => c.url.endsWith(':runQuery'))!.body).toEqual({
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

    // Each claim is conditional on the version that was read, and sets only sent and sentAt.
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(3);
    const first = new URL(patches[0].url);
    expect(first.pathname).toEndWith('/households/h1/reminders/pet-c1-20260101-1155');
    expect(first.searchParams.getAll('updateMask.fieldPaths')).toEqual(['sent', 'sentAt']);
    expect(first.searchParams.get('currentDocument.updateTime')).toBe('2026-01-01T00:00:01.000001Z');
    expect(patches[0].body).toEqual({ fields: { sent: { booleanValue: true }, sentAt: { integerValue: String(NOW) } } });

    // The stale reminder (13 hours late, household h2) is marked without reading its household or pushing.
    expect(new URL(patches[2].url).pathname).toEndWith('/households/h2/reminders/pet-stale');
    expect(calls.some((c) => c.url.includes('/households/h2/') && c.method === 'GET')).toBe(false);

    // Household h1 is read once for both of its reminders.
    expect(calls.filter((c) => c.method === 'GET' && c.url === `${DOCS}/households/h1`)).toHaveLength(1);

    // A reminder's pushes go out together, so their order within it is not fixed.
    const pushes = calls.filter(isPush);
    expect(pushes.slice(0, 3).map((c) => c.url).sort()).toEqual([
      'https://gone.example.org/sam-old-laptop',
      'https://push.example.net/alex-phone-pet',
      'https://push.example.net/tablet-tasks',
    ]);
    // The tasks reminder: Sam's tablet only; the dropped laptop is gone, Mallory isn't a member.
    expect(pushes.slice(3).map((c) => c.url)).toEqual(['https://push.example.net/tablet-tasks']);
    // Every push is claimed first.
    expect(calls.indexOf(patches[0])).toBeLessThan(calls.indexOf(pushes[0]));
    for (const p of pushes.slice(0, 3)) expect(await decryptPush(p.body as Bytes)).toEqual(JSON.parse(payload(reminders[0])));
    expect(await decryptPush(pushes[3].body as Bytes)).toMatchObject({ title: 'Bins out tonight', tag: 'tasks-bins', app: 'tasks' });

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.map((c) => c.url)).toEqual([`${DOCS}/households/h1/pushSubscriptions/sam-tasks-old`]);
  });

  test('a reminder changed or claimed since it was read is not sent', async () => {
    const { fetchImpl, calls } = stubFetch(
      routes({ patch: (c) => (c.url.includes('pet-c1') ? json(preconditionFailed, 400) : undefined) }),
    );
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats).toMatchObject({ sent: 1, raced: 1, pushed: 1 });
    expect(calls.filter(isPush).map((c) => c.url).sort()).toEqual(['https://gone.example.org/sam-old-laptop', 'https://push.example.net/tablet-tasks']);
  });

  test('other Firestore errors on the claim stop the run', async () => {
    const { fetchImpl } = stubFetch(routes({ patch: () => json({ error: { message: 'boom', status: 'INTERNAL' } }, 500) }));
    await expect(run(await testEnv(), NOW, fetchImpl, quiet)).rejects.toThrow('[500] Firestore markSent: boom');
  });

  test('a failed push is counted and logged; the subscription stays', async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = stubFetch(routes({ push: (c) => (c.url.includes('alex-phone-pet') ? new Response(null, { status: 503 }) : undefined) }));
    const stats = await run(await testEnv(), NOW, fetchImpl, (l) => lines.push(l));
    expect(stats).toMatchObject({ pushed: 2, failed: 2, removed: 1 });
    expect(lines).toEqual(['push to push.example.net failed: 503']);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  test('stops within the subrequest budget, never claiming a reminder it cannot finish', async () => {
    const many = Array.from({ length: 50 }, (_, i) => {
      const r = structuredClone(due[0]);
      r.document!.name = r.document!.name.replace('pet-c1-20260101-1155', `pet-${i}`);
      return r;
    });
    const { fetchImpl, calls } = stubFetch(routes({ due: many }));
    const stats = await run(await testEnv(), NOW, fetchImpl, quiet);
    expect(stats.deferred).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    // Token, query and two household reads (4); the first reminder: claim, 3 pushes and the 410
    // delete (5); then claim and 2 pushes each: 12 more fit exactly in 45.
    const patches = calls.filter((c) => c.method === 'PATCH').length;
    expect(stats.sent).toBe(patches);
    expect(patches).toBe(13);
    expect(calls.filter(isPush).length).toBe(3 + 12 * 2);
    expect(calls.length).toBe(SUBREQUEST_BUDGET);
  });

  test('says which setting is missing', async () => {
    const env = await testEnv();
    await expect(run({ ...env, VAPID_PRIVATE_KEY: '' }, NOW, stubFetch([]).fetchImpl)).rejects.toThrow(/VAPID_PRIVATE_KEY/);
    await expect(run({ ...env, GOOGLE_SERVICE_ACCOUNT: '' }, NOW, stubFetch([]).fetchImpl)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT/);
  });
});

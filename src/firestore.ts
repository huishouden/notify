import type { Fetch } from './google';

/**
 * The few Firestore REST calls the sender needs, as the service account (which Firestore rules
 * don't apply to). Values come back typed (`{"integerValue": "5"}`); `decode` turns them into
 * plain JSON.
 */

export type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: Value[] } }
  | { mapValue: { fields?: Record<string, Value> } };

export interface RestDocument {
  /** projects/{p}/databases/(default)/documents/households/{h}/reminders/{r} */
  name: string;
  fields?: Record<string, Value>;
  createTime?: string;
  updateTime: string;
}

export function decode(value: Value): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return Date.parse(value.timestampValue);
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields);
  return undefined;
}

export function decodeFields(fields: Record<string, Value> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decode(v)]));
}

/** Path segments after `/documents/`: ['households', 'h1', 'reminders', 'r1']. */
export function documentPath(name: string): string[] {
  const at = name.indexOf('/documents/');
  return at < 0 ? [] : name.slice(at + '/documents/'.length).split('/');
}

export class Firestore {
  readonly root: string;
  constructor(
    readonly projectId: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch,
  ) {
    this.root = `projects/${projectId}/databases/(default)/documents`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`https://firestore.googleapis.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body: parsed };
  }

  private static fail(what: string, status: number, body: unknown): Error {
    // runQuery streams, so its errors come as a one-element array.
    const error = (Array.isArray(body) ? body[0] : body) as { error?: { message?: string; status?: string } } | undefined;
    const reason = error?.error?.status ? `${error.error.status} ` : '';
    return new Error(`[${status}] Firestore ${what}: ${reason}${error?.error?.message ?? ''}`.trim());
  }

  /**
   * Unsent reminders due by `now` across every household (a collection group query), oldest or
   * newest first.
   */
  async dueReminders(now: number, limit: number, direction: Direction = 'ASCENDING', collectionId: ReminderCollection = 'reminders'): Promise<RestDocument[]> {
    const { status, body } = await this.call<{ document?: RestDocument }[]>('POST', `${this.root}:runQuery`, dueRemindersQuery(now, limit, direction, collectionId));
    if (status !== 200) throw Firestore.fail('runQuery', status, body);
    return body.filter((r) => r.document).map((r) => r.document!);
  }

  async get(path: string): Promise<RestDocument | null> {
    const { status, body } = await this.call<RestDocument>('GET', `${this.root}/${path}`);
    if (status === 404) return null;
    if (status !== 200) throw Firestore.fail('get', status, body);
    return body;
  }

  /**
   * Several documents in one request (`batchGet`), by path under the database root. Each path maps
   * to its fields decoded, or null when the document doesn't exist; a path missing from the answer
   * is left out.
   */
  async getAll(paths: string[]): Promise<Map<string, Record<string, unknown> | null>> {
    const out = new Map<string, Record<string, unknown> | null>();
    if (paths.length === 0) return out;
    const { status, body } = await this.call<{ found?: RestDocument; missing?: string }[]>('POST', `${this.root}:batchGet`, {
      documents: paths.map((p) => `${this.root}/${p}`),
    });
    if (status !== 200 || !Array.isArray(body)) throw Firestore.fail('batchGet', status, body);
    for (const r of body) {
      if (r.found) out.set(documentPath(r.found.name).join('/'), decodeFields(r.found.fields));
      else if (r.missing) out.set(documentPath(r.missing).join('/'), null);
    }
    return out;
  }

  /** Every document in a (small) collection: one page of up to 300. */
  async list(path: string): Promise<RestDocument[]> {
    const { status, body } = await this.call<{ documents?: RestDocument[] }>('GET', `${this.root}/${path}?pageSize=300`);
    if (status !== 200) throw Firestore.fail('list', status, body);
    return body.documents ?? [];
  }

  /**
   * Marks documents sent, and deletes `remove`, in one non-atomic `batchWrite`, each only if
   * unchanged since it was read (`updateTime` precondition), and says per document (the marked
   * ones, then the deleted ones) whether it was written. `raced` means someone else got there
   * first: another run, or a member editing, rescheduling or deleting it.
   */
  async markSent(docs: RestDocument[], sentAt: number, remove: RestDocument[] = []): Promise<WriteOutcome[]> {
    if (docs.length === 0 && remove.length === 0) return [];
    const writes = [
      ...docs.map((doc) => ({
        update: { name: doc.name, fields: { sent: { booleanValue: true }, sentAt: { integerValue: String(sentAt) } } },
        updateMask: { fieldPaths: ['sent', 'sentAt'] },
        currentDocument: { updateTime: doc.updateTime },
      })),
      ...remove.map((doc) => ({ delete: doc.name, currentDocument: { updateTime: doc.updateTime } })),
    ];
    const { status, body } = await this.call<{ status?: { code?: number; message?: string }[] }>('POST', `${this.root}:batchWrite`, { writes });
    if (status !== 200) throw Firestore.fail('batchWrite', status, body);
    return writes.map((_, i) => {
      const code = body.status?.[i]?.code ?? 0;
      if (code === 0) return { ok: true };
      if (RACED_CODES.includes(code)) return { ok: false, raced: true };
      return { ok: false, raced: false, error: `code ${code}: ${body.status?.[i]?.message ?? ''}`.trim() };
    });
  }

  async delete(name: string): Promise<void> {
    const { status, body } = await this.call('DELETE', name);
    if (status !== 200 && status !== 404) throw Firestore.fail('delete', status, body);
  }
}

export type Direction = 'ASCENDING' | 'DESCENDING';

/** `reminders` (shared) or `personalReminders` (for named members only, pwa-kit `./audience`). */
export type ReminderCollection = 'reminders' | 'personalReminders';

export type WriteOutcome = { ok: true } | { ok: false; raced: true } | { ok: false; raced: false; error: string };

/** NOT_FOUND, FAILED_PRECONDITION and ABORTED (google.rpc.Code). */
const RACED_CODES = [5, 9, 10];

export function dueRemindersQuery(now: number, limit: number, direction: Direction = 'ASCENDING', collectionId: ReminderCollection = 'reminders') {
  return {
    structuredQuery: {
      from: [{ collectionId, allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'sent' }, op: 'EQUAL', value: { booleanValue: false } } },
            { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(now) } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'at' }, direction }],
      limit,
    },
  };
}

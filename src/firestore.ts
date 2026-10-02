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
    const message = (body as { error?: { message?: string } })?.error?.message ?? '';
    return new Error(`[${status}] Firestore ${what}: ${message}`);
  }

  /** Unsent reminders due by `now`, oldest first, across every household (a collection group query). */
  async dueReminders(now: number, limit: number): Promise<RestDocument[]> {
    const { status, body } = await this.call<{ document?: RestDocument }[]>('POST', `${this.root}:runQuery`, dueRemindersQuery(now, limit));
    if (status !== 200) throw Firestore.fail('runQuery', status, body);
    return body.filter((r) => r.document).map((r) => r.document!);
  }

  async get(path: string): Promise<RestDocument | null> {
    const { status, body } = await this.call<RestDocument>('GET', `${this.root}/${path}`);
    if (status === 404) return null;
    if (status !== 200) throw Firestore.fail('get', status, body);
    return body;
  }

  /** Every document in a (small) collection: one page of up to 300. */
  async list(path: string): Promise<RestDocument[]> {
    const { status, body } = await this.call<{ documents?: RestDocument[] }>('GET', `${this.root}/${path}?pageSize=300`);
    if (status !== 200) throw Firestore.fail('list', status, body);
    return body.documents ?? [];
  }

  /**
   * Marks a reminder sent, only if it is unchanged since it was read (`updateTime` precondition).
   * False when someone else got there first: another run, or a member editing or rescheduling it.
   */
  async markSent(doc: RestDocument, sentAt: number): Promise<boolean> {
    const params = new URLSearchParams();
    params.append('updateMask.fieldPaths', 'sent');
    params.append('updateMask.fieldPaths', 'sentAt');
    params.append('currentDocument.updateTime', doc.updateTime);
    const { status, body } = await this.call('PATCH', `${doc.name}?${params}`, {
      fields: { sent: { booleanValue: true }, sentAt: { integerValue: String(sentAt) } },
    });
    if (status === 200) return true;
    // NOT_FOUND (deleted since read) or FAILED_PRECONDITION (changed since read).
    const reason = (body as { error?: { status?: string } })?.error?.status;
    if (status === 404 || reason === 'FAILED_PRECONDITION' || reason === 'ABORTED') return false;
    throw Firestore.fail('markSent', status, body);
  }

  async delete(name: string): Promise<void> {
    const { status, body } = await this.call('DELETE', name);
    if (status !== 200 && status !== 404) throw Firestore.fail('delete', status, body);
  }
}

export function dueRemindersQuery(now: number, limit: number) {
  return {
    structuredQuery: {
      from: [{ collectionId: 'reminders', allDescendants: true }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'sent' }, op: 'EQUAL', value: { booleanValue: false } } },
            { fieldFilter: { field: { fieldPath: 'at' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(now) } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
      limit,
    },
  };
}

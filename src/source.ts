/**
 * A reminder's `source` (pwa-kit `./reminder-core` `ReminderSource`): the records it is about and
 * when it is still due, so a bill paid or a task ticked anywhere (the portal's To-do list, the
 * connector, a calendar) stops its reminder even before the app that wrote it is opened again.
 *
 * `checks` name documents under the reminder's household. A check passes while its document exists
 * and every `due` condition holds; a missing document is done (removed) unless `missing` is `'due'`
 * (a record written once it is done: a dose marked given). The reminder is due while every check
 * passes, or with `any: true` while at least one does. Conditions compare one field, a missing
 * field reading as null, with a short list of plain values (`in` or `notIn`).
 *
 * Only collections of the reminder's own app may be named (`SOURCE_COLLECTIONS`, as pwa-kit
 * `REMINDER_SOURCE_COLLECTIONS`): a reminder can't be made to reveal anything about another app's
 * records. A source this Worker can't read or understand is ignored and the reminder sent, as it
 * was before sources existed.
 */

export type SourceValue = string | number | boolean | null;

export interface SourceCondition {
  field: string;
  op: 'in' | 'notIn';
  values: SourceValue[];
}

export interface SourceCheck {
  /** Under the household: "bills/b1". */
  doc: string;
  due: SourceCondition[];
  missing: 'done' | 'due';
}

export interface Source {
  checks: SourceCheck[];
  any: boolean;
}

/** The limits the kit and the rules use. */
export const SOURCE_LIMITS = { checks: 8, conditions: 4, values: 8, path: 400, field: 100, value: 200 } as const;

/** The collections each app's reminders may name as a source (`*` is one document id). */
export const SOURCE_COLLECTIONS: Record<string, readonly string[]> = {
  bills: ['bills'],
  tasks: ['items'],
  pet: ['petProfiles', 'petMedCourses', 'petMedDoses', 'petMeals', 'petReminders', 'petAppointments'],
  health: ['healthPeople', 'healthPeople/*/meds', 'healthPeople/*/doses', 'healthPeople/*/visits'],
  home: ['homeEvents', 'homeEventPrep', 'homeTasks'],
  baby: ['babyChecklists', 'babyAppointments'],
  car: ['carRenewals', 'carServiceItems'],
};

const SEGMENT = /^(?!\.\.?$)(?!__.*__$)[^/]{1,200}$/;

/** Whether `doc` is a document path in one of `app`'s collections. */
export function sourcePathAllowed(app: string, doc: string): boolean {
  if (typeof doc !== 'string' || doc.length > SOURCE_LIMITS.path) return false;
  const parts = doc.split('/');
  if (parts.length < 2 || parts.length % 2 !== 0 || !parts.every((p) => SEGMENT.test(p))) return false;
  const col = parts.slice(0, -1);
  return (SOURCE_COLLECTIONS[app] ?? []).some((pattern) => {
    const want = pattern.split('/');
    return want.length === col.length && want.every((w, i) => w === '*' || w === col[i]);
  });
}

const isValue = (v: unknown): v is SourceValue =>
  v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= SOURCE_LIMITS.value);

function toCondition(value: unknown): SourceCondition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.field !== 'string' || !c.field || c.field.length > SOURCE_LIMITS.field) return null;
  const op = 'in' in c ? 'in' : 'notIn' in c ? 'notIn' : null;
  if (!op || ('in' in c && 'notIn' in c)) return null;
  const values = c[op];
  if (!Array.isArray(values) || values.length === 0 || values.length > SOURCE_LIMITS.values || !values.every(isValue)) return null;
  return { field: c.field, op, values };
}

function toCheck(app: string, value: unknown): SourceCheck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.doc !== 'string' || !sourcePathAllowed(app, c.doc)) return null;
  if (c.missing !== undefined && c.missing !== 'done' && c.missing !== 'due') return null;
  const raw = c.due ?? [];
  if (!Array.isArray(raw) || raw.length > SOURCE_LIMITS.conditions) return null;
  const due = raw.map(toCondition);
  if (due.some((d) => !d)) return null;
  return { doc: c.doc, due: due as SourceCondition[], missing: c.missing === 'due' ? 'due' : 'done' };
}

/** A reminder's decoded `source`, or null when it has none or one this Worker won't use. */
export function toSource(app: string, value: unknown): Source | null {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.checks) || s.checks.length === 0 || s.checks.length > SOURCE_LIMITS.checks) return null;
  const checks = s.checks.map((c) => toCheck(app, c));
  if (checks.some((c) => !c)) return null;
  return { checks: checks as SourceCheck[], any: s.any === true };
}

/** A field by its dotted path ("autopay.enrolled"); missing reads as null. */
function fieldOf(fields: Record<string, unknown>, path: string): unknown {
  let at: unknown = fields;
  for (const part of path.split('.')) {
    if (!at || typeof at !== 'object' || Array.isArray(at)) return null;
    at = (at as Record<string, unknown>)[part];
  }
  return at === undefined ? null : at;
}

const holds = (c: SourceCondition, fields: Record<string, unknown>) => {
  const v = fieldOf(fields, c.field);
  const found = c.values.some((x) => x === v);
  return c.op === 'in' ? found : !found;
};

/**
 * Whether the reminder is still due, given its documents as read (`null`: the document doesn't
 * exist; absent from the map: not read). Undefined when a document it depends on wasn't read, so
 * the caller sends it as before.
 */
export function stillDue(source: Source, read: Map<string, Record<string, unknown> | null>): boolean | undefined {
  const known = source.checks.filter((check) => read.has(check.doc));
  const passes = known.map((check) => {
    const fields = read.get(check.doc);
    if (fields === null || fields === undefined) return check.missing === 'due';
    return check.due.every((c) => holds(c, fields));
  });
  // Settled by what was read, whatever the unread ones would say.
  if (source.any ? passes.includes(true) : passes.includes(false)) return source.any;
  return known.length < source.checks.length ? undefined : !source.any;
}

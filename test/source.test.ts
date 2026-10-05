import { describe, expect, test } from 'bun:test';
import { sourcePathAllowed, stillDue, toSource, type Source } from '../src/source';

const bill = { checks: [{ doc: 'bills/b1', due: [{ field: 'status', notIn: ['paid', 'credit'] }, { field: 'dismissed', notIn: [true] }, { field: 'due', in: ['2026-01-01'] }] }] };
const read = (entries: Record<string, Record<string, unknown> | null>) => new Map(Object.entries(entries));

describe('toSource', () => {
  test('reads checks, conditions and the missing rule', () => {
    expect(toSource('bills', bill)).toEqual({
      checks: [
        {
          doc: 'bills/b1',
          due: [
            { field: 'status', op: 'notIn', values: ['paid', 'credit'] },
            { field: 'dismissed', op: 'notIn', values: [true] },
            { field: 'due', op: 'in', values: ['2026-01-01'] },
          ],
          missing: 'done',
        },
      ],
      any: false,
    });
    expect(toSource('health', { checks: [{ doc: 'healthPeople/p1/doses/d1', missing: 'due' }], any: true })).toEqual({ checks: [{ doc: 'healthPeople/p1/doses/d1', due: [], missing: 'due' }], any: true });
  });

  test('none, or one it does not understand, is null: the reminder goes out as before', () => {
    for (const bad of [
      undefined,
      null,
      'bills/b1',
      { checks: [] },
      { checks: [{ doc: 'bills' }] },
      { checks: [{ doc: 'bills/b1/x' }] },
      { checks: [{ doc: 'bills/../b1' }] },
      { checks: [{ doc: 'bills/b1', missing: 'maybe' }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status' }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: [] }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: ['a'], notIn: ['b'] }] }] },
      { checks: [{ doc: 'bills/b1', due: [{ field: 'status', in: [['nested']] }] }] },
      { checks: Array.from({ length: 9 }, () => ({ doc: 'bills/b1' })) },
    ])
      expect(toSource('bills', bad)).toBeNull();
  });

  test("only the reminder's own app's collections", () => {
    expect(sourcePathAllowed('bills', 'bills/b1')).toBe(true);
    expect(sourcePathAllowed('tasks', 'bills/b1')).toBe(false);
    expect(sourcePathAllowed('health', 'healthPeople/p1/doses/d1')).toBe(true);
    expect(sourcePathAllowed('health', 'healthPeople/p1/notes/d1')).toBe(false);
    expect(sourcePathAllowed('spending', 'spendingTransactions/t1')).toBe(false);
    expect(sourcePathAllowed('bills', 'bills/__name__')).toBe(false);
  });
});

describe('stillDue', () => {
  const s = toSource('bills', bill)!;

  test('due while every condition holds; done once paid, skipped or re-dated', () => {
    expect(stillDue(s, read({ 'bills/b1': { status: 'due', due: '2026-01-01' } }))).toBe(true);
    expect(stillDue(s, read({ 'bills/b1': { status: 'paid', due: '2026-01-01' } }))).toBe(false);
    expect(stillDue(s, read({ 'bills/b1': { status: 'due', dismissed: true, due: '2026-01-01' } }))).toBe(false);
    expect(stillDue(s, read({ 'bills/b1': { status: 'due', due: '2026-02-01' } }))).toBe(false);
  });

  test('a missing document is done, unless missing means due; an unread one is unknown', () => {
    expect(stillDue(s, read({ 'bills/b1': null }))).toBe(false);
    expect(stillDue(s, read({}))).toBeUndefined();
    const tick: Source = { checks: [{ doc: 'homeEventPrep/e1_2026-01-01', due: [{ field: 'done', op: 'notIn', values: [true] }], missing: 'due' }], any: false };
    expect(stillDue(tick, read({ 'homeEventPrep/e1_2026-01-01': null }))).toBe(true);
    expect(stillDue(tick, read({ 'homeEventPrep/e1_2026-01-01': { done: true } }))).toBe(false);
  });

  test('a missing field reads as null; dotted fields reach into maps', () => {
    const one: Source = { checks: [{ doc: 'bills/b1', due: [{ field: 'autopay.enrolled', op: 'in', values: [false, null] }], missing: 'done' }], any: false };
    expect(stillDue(one, read({ 'bills/b1': {} }))).toBe(true);
    expect(stillDue(one, read({ 'bills/b1': { autopay: { enrolled: true } } }))).toBe(false);
  });

  test('all: any check failing settles it; any: one passing does', () => {
    const given = { field: 'status', op: 'notIn' as const, values: ['given', 'skipped'] };
    const two = (any: boolean): Source => ({
      checks: [
        { doc: 'healthPeople/p1/doses/a', due: [given], missing: 'due' },
        { doc: 'healthPeople/p1/doses/b', due: [given], missing: 'due' },
      ],
      any,
    });
    const marked = { status: 'given' };
    // Due while any dose of the group is unmarked.
    expect(stillDue(two(true), read({ 'healthPeople/p1/doses/a': marked, 'healthPeople/p1/doses/b': null }))).toBe(true);
    expect(stillDue(two(true), read({ 'healthPeople/p1/doses/a': marked, 'healthPeople/p1/doses/b': { status: 'skipped' } }))).toBe(false);
    expect(stillDue(two(true), read({ 'healthPeople/p1/doses/a': marked }))).toBeUndefined();
    expect(stillDue(two(false), read({ 'healthPeople/p1/doses/a': marked }))).toBe(false);
    expect(stillDue(two(false), read({ 'healthPeople/p1/doses/a': null }))).toBeUndefined();
  });
});

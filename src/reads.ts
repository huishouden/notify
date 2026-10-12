import { DurableObject } from 'cloudflare:workers';
import { readLedgerObject, type ReadLedger } from '@huishouden/pwa-kit/read-budget';

/**
 * The day's Firestore reads and the quota pause (pwa-kit `ReadBudget`, src/send.ts `runReads`): one
 * SQLite-backed Durable Object (the only kind on the free plan), a row per Pacific day. Three
 * requests a run (read, add, and a pause only when Firestore says its quota is used up): about 600
 * a day of the free plan's 100,000.
 */
export class ReadLedgerObject extends readLedgerObject(DurableObject) {}

export interface LedgerEnv {
  READ_LEDGER?: DurableObjectNamespace<ReadLedgerObject>;
}

/** The ledger for wrangler.toml's READ_LEDGER binding; null without one (counted per run only). */
export function ledgerOf(env: LedgerEnv): ReadLedger | null {
  const ns = env.READ_LEDGER;
  if (!ns) return null;
  const stub = () => ns.get(ns.idFromName('reads'));
  return {
    read: async (day, keys) => stub().read(day, keys),
    add: async (day, keys, reads) => stub().add(day, keys, reads),
    pause: async (until) => stub().pause(until),
  };
}

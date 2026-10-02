import { b64url } from '../src/b64';
import type { Env } from '../src/send';
import v from './fixtures/rfc8291.json';

/** A throwaway service account: the key is made per test run, so no key material is committed. */
let made: ReturnType<typeof makeServiceAccount> | undefined;
export const testServiceAccount = () => (made ??= makeServiceAccount());

async function makeServiceAccount() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = b64url(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).replace(/-/g, '+').replace(/_/g, '/');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { sa: { client_email: 'notify-sender@demo-huishouden.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' }, publicKey: pair.publicKey };
}

export async function testEnv(): Promise<Env> {
  const { sa } = await testServiceAccount();
  return {
    FIREBASE_PROJECT_ID: 'demo-huishouden',
    VAPID_PUBLIC_KEY: v.as_public,
    VAPID_PRIVATE_KEY: v.as_private,
    VAPID_SUBJECT: 'https://github.com/huishouden/notify',
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify(sa),
  };
}

export interface Call {
  method: string;
  url: string;
  body?: unknown;
}

export type Route = (call: Call) => Response | undefined;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch that answers from routes in order and records every call. Unrouted calls fail the test. */
export function stubFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const raw = init.body;
    const body = typeof raw === 'string' ? (raw.startsWith('{') ? JSON.parse(raw) : raw) : raw;
    const call = { method: init.method ?? 'GET', url: input, body, headers: init.headers } as Call;
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    throw new Error(`unrouted ${call.method} ${call.url}`);
  };
  return { fetchImpl, calls };
}

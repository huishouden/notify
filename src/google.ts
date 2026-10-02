import { b64url, fromB64url, utf8 } from './b64';

/**
 * An OAuth access token for a Google service account, made in the Worker with WebCrypto: a JWT
 * signed with the account's key (RS256) exchanged at Google's token endpoint. The token lasts an
 * hour and is reused across runs while the Worker stays warm.
 */

export const DATASTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function parseServiceAccount(json: string | undefined): ServiceAccount {
  if (!json) throw new Error('GOOGLE_SERVICE_ACCOUNT is not set (wrangler secret put GOOGLE_SERVICE_ACCOUNT).');
  const sa = JSON.parse(json) as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT is not a service account key (no client_email or private_key).');
  return sa as ServiceAccount;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return fromB64url(body).slice().buffer as ArrayBuffer;
}

export async function signedAssertion(sa: ServiceAccount, scope: string, nowSeconds: number): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(
    utf8(
      JSON.stringify({
        iss: sa.client_email,
        scope,
        aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(input).slice().buffer as ArrayBuffer);
  return `${input}.${b64url(signature)}`;
}

let cached: { email: string; token: string; expires: number } | null = null;

/** For tests: forget the cached token. */
export function resetTokenCache() {
  cached = null;
}

export async function accessToken(sa: ServiceAccount, fetchImpl: Fetch, nowMs: number, scope = DATASTORE_SCOPE): Promise<string> {
  if (cached && cached.email === sa.client_email && cached.expires > nowMs) return cached.token;
  const assertion = await signedAssertion(sa, scope, Math.floor(nowMs / 1000));
  const res = await fetchImpl(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`[${res.status}] Google token: ${body.error_description ?? body.error ?? res.statusText}`);
  }
  // Refresh five minutes early so a run never starts with a token about to lapse.
  cached = { email: sa.client_email, token: body.access_token, expires: nowMs + ((body.expires_in ?? 3600) - 300) * 1000 };
  return body.access_token;
}

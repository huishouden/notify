import { beforeEach, describe, expect, test } from 'bun:test';
import { fromB64url, utf8 } from '../src/b64';
import { accessToken, DATASTORE_SCOPE, parseServiceAccount, resetTokenCache } from '../src/google';
import tokenResponse from './fixtures/token-response.json';
import { json, stubFetch, testServiceAccount } from './helpers';

const NOW = 1_767_268_800_000;
const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromB64url(part)));

beforeEach(resetTokenCache);

describe('service account token', () => {
  test('posts an RS256 assertion for the datastore scope and caches the token', async () => {
    const { sa, publicKey } = await testServiceAccount();
    const { fetchImpl, calls } = stubFetch([() => json(tokenResponse)]);
    expect(await accessToken(sa, fetchImpl, NOW)).toBe('ya29.example-access-token');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(calls[0].body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = form.get('assertion')!.split('.');
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(c)).toEqual({
      iss: sa.client_email,
      scope: DATASTORE_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromB64url(s), utf8(`${h}.${c}`))).toBe(true);

    // Reused until five minutes before it expires.
    await accessToken(sa, fetchImpl, NOW + 50 * 60_000);
    expect(calls).toHaveLength(1);
    await accessToken(sa, fetchImpl, NOW + 56 * 60_000);
    expect(calls).toHaveLength(2);
  });

  test("reports Google's reason when the exchange fails", async () => {
    const { sa } = await testServiceAccount();
    const { fetchImpl } = stubFetch([() => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)]);
    await expect(accessToken(sa, fetchImpl, NOW)).rejects.toThrow('[400] Google token: Invalid JWT Signature.');
  });

  test('explains a missing or wrong secret', () => {
    expect(() => parseServiceAccount(undefined)).toThrow(/wrangler secret put GOOGLE_SERVICE_ACCOUNT/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/not a service account key/);
  });
});

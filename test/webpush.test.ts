import { describe, expect, test } from 'bun:test';
import { b64url, concat, fromB64url, utf8, type Bytes } from '../src/b64';
import { deriveKeys, encrypt, importKeyPair, loadVapid, MAX_PAYLOAD, pushRequest, vapidJwt } from '../src/webpush';
import v from './fixtures/rfc8291.json';

const subscription = { endpoint: 'https://push.example.net/push/abc', keys: { p256dh: v.ua_public, auth: v.ua_shared } };

/** What the browser does with a push body: RFC 8291 decryption as the user agent. */
async function decryptAsUA(message: Bytes): Promise<string> {
  const salt = message.slice(0, 16);
  const idlen = message[20];
  const asPublic = message.slice(21, 21 + idlen);
  const ua = await importKeyPair(v.ua_public, v.ua_private, 'ECDH');
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const { cek, nonce } = await deriveKeys(secret, fromB64url(v.ua_shared), fromB64url(v.ua_public), asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, message.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe('RFC 8291 encryption', () => {
  test('intermediate keys match appendix A', async () => {
    const keys = await deriveKeys(fromB64url(v.ecdh_shared), fromB64url(v.ua_shared), fromB64url(v.ua_public), fromB64url(v.as_public), fromB64url(v.salt));
    expect(b64url(keys.ikm)).toBe(v.ikm);
    expect(b64url(keys.cek)).toBe(v.cek);
    expect(b64url(keys.nonce)).toBe(v.nonce);
  });

  test('ECDH between the example keys gives the shared secret of appendix A', async () => {
    const as = await importKeyPair(v.as_public, v.as_private, 'ECDH');
    const ua = await crypto.subtle.importKey('raw', fromB64url(v.ua_public), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    expect(b64url(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256))).toBe(v.ecdh_shared);
  });

  test('the encrypted message is byte for byte the one in section 5', async () => {
    const serverKeys = await importKeyPair(v.as_public, v.as_private, 'ECDH');
    const out = await encrypt(utf8(v.plaintext), subscription.keys, { salt: fromB64url(v.salt), serverKeys });
    expect(b64url(out)).toBe(v.message);
    expect(b64url(out.slice(0, 86))).toBe(v.header);
    expect(b64url(out.slice(86))).toBe(v.ciphertext);
    // 86-octet header + 41 + 1 delimiter + 16 tag. (Section 5 says Content-Length: 145; its own bytes are 144.)
    expect(out.length).toBe(144);
  });

  test('random salt and keys: the user agent decrypts it', async () => {
    const text = JSON.stringify({ title: 'Biscuit: 1 tablet', body: 'with food' });
    const a = await encrypt(utf8(text), subscription.keys);
    const b = await encrypt(utf8(text), subscription.keys);
    expect(b64url(a)).not.toBe(b64url(b));
    expect(await decryptAsUA(a)).toBe(text);
  });

  test('refuses a payload larger than one record', async () => {
    await expect(encrypt(new Uint8Array(MAX_PAYLOAD + 1), subscription.keys)).rejects.toThrow(/limit/);
    expect((await encrypt(new Uint8Array(MAX_PAYLOAD), subscription.keys)).length).toBe(86 + 4096);
  });
});

describe('VAPID', () => {
  test('ES256 token verifies with the public key and carries aud, exp and sub', async () => {
    const keys = await importKeyPair(v.as_public, v.as_private, 'ECDSA');
    const jwt = await vapidJwt('https://push.example.net', 'https://github.com/huishouden/notify', keys.privateKey, 1_767_268_800);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(c)))).toEqual({
      aud: 'https://push.example.net',
      exp: 1_767_268_800 + 12 * 3600,
      sub: 'https://github.com/huishouden/notify',
    });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, fromB64url(s), utf8(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  test('push request: headers, one token per push service origin, decryptable body', async () => {
    const vapid = await loadVapid(v.as_public, v.as_private, 'https://github.com/huishouden/notify');
    const req = await pushRequest(subscription, '{"title":"t"}', vapid, { nowSeconds: 1_767_268_800 });
    expect(req.url).toBe(subscription.endpoint);
    expect(req.init.method).toBe('POST');
    expect(req.init.headers['Content-Encoding']).toBe('aes128gcm');
    expect(req.init.headers.TTL).toBe('14400');
    expect(req.init.headers.Urgency).toBe('high');
    expect(req.init.headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${v.as_public}$`));
    await pushRequest({ ...subscription, endpoint: 'https://push.example.net/other' }, '{}', vapid);
    await pushRequest({ ...subscription, endpoint: 'https://other.example.org/x' }, '{}', vapid);
    expect([...vapid.tokens.keys()]).toEqual(['https://push.example.net', 'https://other.example.org']);
    expect(await decryptAsUA(req.init.body)).toBe('{"title":"t"}');
  });

  test('rejects a public key that is not an uncompressed P-256 point', async () => {
    await expect(importKeyPair(b64url(concat(new Uint8Array([2]), new Uint8Array(32))), v.as_private, 'ECDSA')).rejects.toThrow(/uncompressed/);
  });
});

import { b64url, concat, fromB64url, utf8, type Bytes } from './b64';

/**
 * Web Push with WebCrypto only: message encryption (RFC 8291, aes128gcm content coding from
 * RFC 8188) and VAPID authentication (RFC 8292). No push vendor account is involved; the browser's
 * push service (Google, Mozilla, Apple) accepts any sender that signs with the key pair the
 * subscription was made with.
 */

export interface SubscriptionKeys {
  /** The browser's P-256 public key, uncompressed point, base64url. */
  p256dh: string;
  /** 16-byte authentication secret, base64url. */
  auth: string;
}

/** One record of 4096 octets: plaintext plus the delimiter octet and the 16-octet GCM tag. */
export const RECORD_SIZE = 4096;
export const MAX_PAYLOAD = RECORD_SIZE - 16 - 1;

// Uint8Array<ArrayBufferLike> is not a BufferSource in newer TS lib types; copy into a plain buffer.
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

/** HKDF-SHA256 with one block of output, which is all RFC 8291 needs (32 octets or fewer). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** An EC P-256 key pair from its raw public point and private scalar (both base64url). */
export async function importKeyPair(publicKey: string, privateKey: string, algorithm: 'ECDH' | 'ECDSA'): Promise<CryptoKeyPair> {
  const point = fromB64url(publicKey);
  if (point.length !== 65 || point[0] !== 4) throw new Error('Public key must be an uncompressed P-256 point (65 bytes).');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(point.slice(1, 33)), y: b64url(point.slice(33)), ext: true };
  const params = { name: algorithm, namedCurve: 'P-256' };
  const usages: ('deriveBits' | 'sign')[] = algorithm === 'ECDH' ? ['deriveBits'] : ['sign'];
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk, params, true, algorithm === 'ECDH' ? [] : ['verify']),
    privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: privateKey }, params, true, usages),
  };
}

export interface DerivedKeys {
  ecdhSecret: Uint8Array;
  ikm: Bytes;
  cek: Bytes;
  nonce: Bytes;
}

/** The key schedule of RFC 8291 section 3.4 and RFC 8188 section 2.2, exposed for tests. */
export async function deriveKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<DerivedKeys> {
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  return { ecdhSecret, ikm, cek, nonce };
}

export interface EncryptOptions {
  /** 16 random octets per message; injected only by tests. */
  salt?: Uint8Array;
  /** The sender's one-off ECDH key pair; injected only by tests. */
  serverKeys?: CryptoKeyPair;
}

/** The encrypted request body: header (salt, record size, sender public key) then one record. */
export async function encrypt(plaintext: Uint8Array, keys: SubscriptionKeys, options: EncryptOptions = {}): Promise<Bytes> {
  if (plaintext.length > MAX_PAYLOAD) throw new Error(`Push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD}.`);
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server =
    options.serverKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', server.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Workers' types call the peer key `$public`; the runtime, like every browser, takes `public`.
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, server.privateKey, 256));
  const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  // A single, final record: the plaintext followed by the 0x02 delimiter and no padding.
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(concat(plaintext, new Uint8Array([2])))),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, record);
}

/**
 * A VAPID token for one push service origin. Valid 12 hours (the RFC allows up to 24); `sub` is how
 * a push service contacts the sender's operator.
 */
export async function vapidJwt(audience: string, subject: string, signingKey: CryptoKey, nowSeconds: number): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(utf8(JSON.stringify({ aud: audience, exp: nowSeconds + 12 * 3600, sub: subject })));
  const input = `${header}.${claims}`;
  // WebCrypto's ECDSA output is r || s, exactly the JWS ES256 encoding.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, buf(utf8(input)));
  return `${input}.${b64url(signature)}`;
}

export interface Vapid {
  publicKey: string;
  subject: string;
  keys: CryptoKeyPair;
  /** Tokens by push service origin, reused within one run. */
  tokens: Map<string, string>;
}

export async function loadVapid(publicKey: string, privateKey: string, subject: string): Promise<Vapid> {
  return { publicKey, subject, keys: await importKeyPair(publicKey, privateKey, 'ECDSA'), tokens: new Map() };
}

export interface PushRequest {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: Bytes };
}

/** The HTTP request that delivers `payload` to one subscription. */
export async function pushRequest(
  subscription: { endpoint: string; keys: SubscriptionKeys },
  payload: string,
  vapid: Vapid,
  { ttlSeconds = 4 * 3600, urgency = 'high', topic, nowSeconds = Math.floor(Date.now() / 1000) }: {
    ttlSeconds?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    topic?: string;
    nowSeconds?: number;
  } = {},
): Promise<PushRequest> {
  const audience = new URL(subscription.endpoint).origin;
  let token = vapid.tokens.get(audience);
  if (!token) {
    token = await vapidJwt(audience, vapid.subject, vapid.keys.privateKey, nowSeconds);
    vapid.tokens.set(audience, token);
  }
  const body = await encrypt(utf8(payload), subscription.keys);
  const headers: Record<string, string> = {
    Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttlSeconds),
    Urgency: urgency,
  };
  // Topic replaces an undelivered message with the same topic (at most 32 base64url characters).
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return { url: subscription.endpoint, init: { method: 'POST', headers, body } };
}

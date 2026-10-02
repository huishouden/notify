/** Bytes backed by a plain ArrayBuffer, which is what WebCrypto's BufferSource accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** base64url without padding, as Web Push, VAPID and JWTs use it. */
export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64url or standard base64, with or without padding or whitespace. */
export function fromB64url(text: string): Bytes {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const utf8 = (text: string): Bytes => new Uint8Array(new TextEncoder().encode(text));

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

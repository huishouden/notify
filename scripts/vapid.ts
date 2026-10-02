#!/usr/bin/env bun
// Generates a VAPID key pair for Web Push. Prints both; writes neither to disk.
import { b64url } from '../src/b64';

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
const { d } = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;

console.log(`Public key (not secret):

  ${publicKey}

  1. wrangler.toml: VAPID_PUBLIC_KEY = "${publicKey}"
  2. Each app repo: gh variable set VITE_VAPID_PUBLIC_KEY --repo huishouden/<app> --body ${publicKey}

Private key (secret; store it in the Worker and nowhere else):

  ${d}

  3. bunx wrangler secret put VAPID_PRIVATE_KEY   (paste the private key when asked)

Then clear this terminal. Changing the pair later means every device turns notifications on again.`);

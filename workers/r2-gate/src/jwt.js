// Firebase ID token verification — direct RS256 JWT verification
// against Google's public keys. No Firebase Admin SDK (it cannot run
// in a Cloudflare Worker).
//
// A Firebase ID token is a JWT: header { alg: "RS256", kid, typ: "JWT" },
// payload { iss: "https://securetoken.google.com/<projectId>",
// aud: "<projectId>", sub: <uid>, exp, iat, ... }.

import { GOOGLE_JWKS_URL } from './config.js';
import { base64url } from './encoding.js';

export function parseJwt(token) {
  if (typeof token !== 'string') throw new Error('token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64url.decode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64url.decode(parts[1])));
  } catch {
    throw new Error('malformed token');
  }
  return {
    header, payload,
    signature: base64url.decode(parts[2]),
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

// Fetch Google's public keys, cached in memory for 1 hour (Google
// rotates them; a short TTL is enough and keeps the Worker fast).
let cachedKeys = null;
let cachedKeysAt = 0;
const KEYS_TTL_MS = 60 * 60 * 1000;

export async function getGoogleKeys(fetchFn = fetch) {
  const now = Date.now();
  if (cachedKeys && now - cachedKeysAt < KEYS_TTL_MS) return cachedKeys;
  const res = await fetchFn(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('failed to fetch Google public keys');
  const jwks = await res.json();
  const keys = {};
  for (const k of jwks.keys || []) keys[k.kid] = k;
  cachedKeys = keys;
  cachedKeysAt = now;
  return keys;
}

// Verify a Firebase ID token. Returns { uid, email, claims }.
// `keys` is the map returned by getGoogleKeys() (pass it explicitly in
// tests; the Worker passes the fetched keys).
export async function verifyFirebaseIdToken(idToken, { projectId, keys, now = Date.now() } = {}) {
  const { header, payload, signature, signingInput } = parseJwt(idToken);
  if (header.alg !== 'RS256') throw new Error('unsupported alg: ' + header.alg);
  if (!header.kid) throw new Error('missing kid');
  const jwk = (keys || {})[header.kid];
  if (!jwk) throw new Error('unknown kid: ' + header.kid);
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new Error('invalid signature');
  const iss = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== iss) throw new Error('invalid iss');
  if (payload.aud !== projectId) throw new Error('invalid aud');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) throw new Error('token expired');
  if (typeof payload.iat === 'number' && payload.iat * 1000 > now + 60 * 1000) {
    throw new Error('token issued in the future');
  }
  if (!payload.sub) throw new Error('missing sub');
  return { uid: payload.sub, email: payload.email || null, claims: payload };
}

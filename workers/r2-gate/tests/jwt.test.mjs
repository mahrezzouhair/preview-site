// Firebase ID token verification tests — run with: node --test tests/
// Keys are generated fresh in this file (mocked keys, never real ones).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyFirebaseIdToken, parseJwt } from '../src/jwt.js';

const PROJECT_ID = 'hijama-tracker';
const NOW = Date.now();

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-kid-1';
const KEYS = { [KID]: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' } };

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function makeToken({ header = {}, payload = {}, key = privateKey, kid = KID } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }));
  const p = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'learner-uid-123',
    email: 'learner@example.com',
    iat: Math.floor(NOW / 1000) - 60,
    exp: Math.floor(NOW / 1000) + 3600,
    ...payload,
  }));
  const input = `${h}.${p}`;
  const sig = sign('sha256', Buffer.from(input), key);
  return `${input}.${b64url(sig)}`;
}

test('valid token verifies and returns uid + email', async () => {
  const token = makeToken();
  const out = await verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW });
  assert.equal(out.uid, 'learner-uid-123');
  assert.equal(out.email, 'learner@example.com');
});

test('expired token is rejected', async () => {
  const token = makeToken({ payload: { exp: Math.floor(NOW / 1000) - 10 } });
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /token expired/
  );
});

test('wrong audience is rejected', async () => {
  const token = makeToken({ payload: { aud: 'another-project' } });
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /invalid aud/
  );
});

test('wrong issuer is rejected', async () => {
  const token = makeToken({ payload: { iss: 'https://securetoken.google.com/other' } });
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /invalid iss/
  );
});

test('tampered payload fails the signature check', async () => {
  const token = makeToken();
  const parts = token.split('.');
  const tamperedPayload = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'attacker-uid',
    iat: Math.floor(NOW / 1000) - 60,
    exp: Math.floor(NOW / 1000) + 3600,
  }));
  const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  await assert.rejects(
    verifyFirebaseIdToken(tampered, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /invalid signature/
  );
});

test('unknown kid is rejected', async () => {
  const token = makeToken({ kid: 'no-such-kid' });
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /unknown kid/
  );
});

test('alg none is rejected', async () => {
  const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }));
  const p = b64url(JSON.stringify({ sub: 'x' }));
  const token = `${h}.${p}.`;
  await assert.rejects(
    verifyFirebaseIdToken(token, { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /unsupported alg/
  );
});

test('malformed token is rejected', async () => {
  await assert.rejects(
    verifyFirebaseIdToken('not-a-jwt', { projectId: PROJECT_ID, keys: KEYS, now: NOW }),
    /malformed token/
  );
  // parseJwt itself also throws on bad input.
  assert.throws(() => parseJwt('a.b'), /malformed token/);
});

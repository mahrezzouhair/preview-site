// Firestore access from a Worker: mint a short-lived OAuth2 access
// token from the Firebase service account (RS256 JWT grant), then call
// the Firestore REST API. No Admin SDK needed.
//
// The service account JSON comes from the Worker secret
// FIREBASE_SERVICE_ACCOUNT_JSON (see R2-SETUP.md). It must have a role
// that can read Firestore, e.g. "Cloud Datastore User".
//
// The enrollment check mirrors course.html exactly: the learner's
// `course-enrollments` docs carry { uid, courseId, course, status,
// name, email, method, createdAt }. Access is granted only when a doc
// exists with status 'approved' for this uid + courseId.

import { GOOGLE_TOKEN_URL, FIRESTORE_SCOPE } from './config.js';
import { base64url, base64Decode } from './encoding.js';

async function signRs256(privateKeyPem, data) {
  const pem = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = base64Decode(pem);
  const key = await crypto.subtle.importKey(
    'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
}

let cachedToken = null; // { accessToken, expiresAt }

export async function getAccessToken(serviceAccount, { fetchFn = fetch, now = Date.now() } = {}) {
  if (cachedToken && cachedToken.expiresAt > now + 60 * 1000) {
    return cachedToken.accessToken;
  }
  const header = base64url.encodeText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url.encodeText(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: FIRESTORE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const sig = await signRs256(serviceAccount.private_key, signingInput);
  const assertion = `${signingInput}.${base64url.encode(new Uint8Array(sig))}`;
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error('failed to mint access token: HTTP ' + res.status);
  const body = await res.json();
  if (!body.access_token) throw new Error('token endpoint returned no access_token');
  cachedToken = {
    accessToken: body.access_token,
    expiresAt: now + (body.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

// True when the learner has an APPROVED enrollment for this course.
// Queries by uid only (same pattern as course.html) and filters
// courseId + status in code, so no composite Firestore index is needed.
export async function hasApprovedEnrollment({ projectId, accessToken, uid, courseId, fetchFn = fetch }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'course-enrollments' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'uid' },
            op: 'EQUAL',
            value: { stringValue: uid },
          },
        },
        limit: 10, // a learner has at most 3 courses
      },
    }),
  });
  if (!res.ok) throw new Error('firestore query failed: HTTP ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) return false;
  return rows.some((r) => {
    const f = r && r.document && r.document.fields;
    return f
      && f.courseId && f.courseId.stringValue === courseId
      && f.status && f.status.stringValue === 'approved';
  });
}

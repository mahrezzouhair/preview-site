// Firestore enrollment check tests (mocked fetch) — run with: node --test tests/
// No real Firebase project is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getAccessToken, hasApprovedEnrollment } from '../src/firestore.js';

const PROJECT_ID = 'hijama-tracker';

function docRow(courseId, status) {
  return {
    document: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/course-enrollments/abc`,
      fields: {
        uid: { stringValue: 'learner-uid-123' },
        courseId: { stringValue: courseId },
        course: { stringValue: 'الحجامة' },
        status: { stringValue: status },
      },
    },
  };
}

function mockFetch(rows, capture) {
  return async (url, opts) => {
    if (capture) capture.push({ url, opts });
    return {
      ok: true,
      json: async () => rows,
    };
  };
}

test('approved enrollment for the requested course grants access', async () => {
  const fetchFn = mockFetch([docRow('hijama', 'approved')]);
  const ok = await hasApprovedEnrollment({
    projectId: PROJECT_ID, accessToken: 'tok', uid: 'learner-uid-123',
    courseId: 'hijama', fetchFn,
  });
  assert.equal(ok, true);
});

test('pending enrollment does not grant access', async () => {
  const fetchFn = mockFetch([docRow('hijama', 'pending')]);
  const ok = await hasApprovedEnrollment({
    projectId: PROJECT_ID, accessToken: 'tok', uid: 'learner-uid-123',
    courseId: 'hijama', fetchFn,
  });
  assert.equal(ok, false);
});

test('approved enrollment for a different course does not grant access', async () => {
  const fetchFn = mockFetch([docRow('bone', 'approved')]);
  const ok = await hasApprovedEnrollment({
    projectId: PROJECT_ID, accessToken: 'tok', uid: 'learner-uid-123',
    courseId: 'hijama', fetchFn,
  });
  assert.equal(ok, false);
});

test('no enrollment at all does not grant access', async () => {
  const fetchFn = mockFetch([]);
  const ok = await hasApprovedEnrollment({
    projectId: PROJECT_ID, accessToken: 'tok', uid: 'learner-uid-123',
    courseId: 'hijama', fetchFn,
  });
  assert.equal(ok, false);
});

test('query goes to runQuery and filters by uid', async () => {
  const captured = [];
  const fetchFn = mockFetch([docRow('hijama', 'approved')], captured);
  await hasApprovedEnrollment({
    projectId: PROJECT_ID, accessToken: 'tok', uid: 'learner-uid-123',
    courseId: 'hijama', fetchFn,
  });
  assert.equal(captured.length, 1);
  assert.ok(captured[0].url.includes('/documents:runQuery'));
  assert.equal(captured[0].opts.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(captured[0].opts.body);
  assert.equal(body.structuredQuery.from[0].collectionId, 'course-enrollments');
  assert.equal(
    body.structuredQuery.where.fieldFilter.value.stringValue,
    'learner-uid-123'
  );
});

test('service-account token mint posts a JWT grant and caches the token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sa = { client_email: 'firebase-adminsdk@test.iam.gserviceaccount.com', private_key: pem };
  const captured = [];
  let calls = 0;
  const fetchFn = async (url, opts) => {
    calls++;
    captured.push({ url, opts });
    return { ok: true, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) };
  };
  const t1 = await getAccessToken(sa, { fetchFn });
  const t2 = await getAccessToken(sa, { fetchFn });
  assert.equal(t1, 'ya29.test');
  assert.equal(t2, 'ya29.test');
  assert.equal(calls, 1, 'second call must use the cached token');
  assert.ok(captured[0].url.includes('oauth2.googleapis.com/token'));
  const params = new URLSearchParams(captured[0].opts.body);
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(params.get('assertion').split('.').length, 3, 'assertion must be a JWT');
});

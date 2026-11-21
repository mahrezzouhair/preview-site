// Firestore enrollment check tests (mocked fetch) — run with: node --test tests/
// No real Firebase project is touched.
//
// The Worker reads Firestore AS the learner, with the learner's own
// Firebase ID token — so the tests assert the Authorization header
// carries exactly that user token (never a minted service-account one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnrollment } from '../src/firestore.js';

const PROJECT_ID = 'hijama-tracker';
const UID = 'learner-uid-123';
const USER_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.user-token-fixture';

function docRow({ courseId, course, status }) {
  const fields = {
    uid: { stringValue: UID },
    status: { stringValue: status },
  };
  if (courseId !== undefined) fields.courseId = { stringValue: courseId };
  if (course !== undefined) fields.course = { stringValue: course };
  return {
    document: {
      name: `projects/${PROJECT_ID}/databases/(default)/documents/course-enrollments/abc`,
      fields,
    },
  };
}

function mockFetch(rows, capture, status = 200) {
  return async (url, opts) => {
    if (capture) capture.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => rows,
    };
  };
}

function check(rows, capture, status) {
  return checkEnrollment(USER_TOKEN, UID, 'hijama', {
    projectId: PROJECT_ID,
    fetchFn: mockFetch(rows, capture, status),
  });
}

test('approved enrollment for the requested course grants access', async () => {
  const ok = await check([docRow({ courseId: 'hijama', course: 'الحجامة', status: 'approved' })]);
  assert.equal(ok, true);
});

test('approved enrollment matching via the course field grants access', async () => {
  // Doc carries course === courseId and no courseId field.
  const ok = await check([docRow({ course: 'hijama', status: 'approved' })]);
  assert.equal(ok, true);
});

test('pending enrollment does not grant access', async () => {
  const ok = await check([docRow({ courseId: 'hijama', course: 'الحجامة', status: 'pending' })]);
  assert.equal(ok, false);
});

test('approved enrollment for a different course does not grant access', async () => {
  const ok = await check([docRow({ courseId: 'bone', course: 'تقويم العظام', status: 'approved' })]);
  assert.equal(ok, false);
});

test('no enrollment at all does not grant access', async () => {
  const ok = await check([]);
  assert.equal(ok, false);
});

test('non-array Firestore response does not grant access', async () => {
  const ok = await check(null);
  assert.equal(ok, false);
});

test('query goes to runQuery, filters by uid, and carries the user token', async () => {
  const captured = [];
  await check([docRow({ courseId: 'hijama', status: 'approved' })], captured);
  assert.equal(captured.length, 1);
  assert.ok(
    captured[0].url ===
      `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`
  );
  // The learner's own ID token — NOT a minted service-account token.
  assert.equal(captured[0].opts.headers.Authorization, `Bearer ${USER_TOKEN}`);
  const body = JSON.parse(captured[0].opts.body);
  assert.equal(body.structuredQuery.from[0].collectionId, 'course-enrollments');
  assert.equal(body.structuredQuery.where.fieldFilter.field.fieldPath, 'uid');
  assert.equal(body.structuredQuery.where.fieldFilter.op, 'EQUAL');
  assert.equal(
    body.structuredQuery.where.fieldFilter.value.stringValue,
    UID
  );
});

test('Firestore 403 throws (index.js maps it to 502)', async () => {
  await assert.rejects(
    () => check([], undefined, 403),
    /firestore query failed: HTTP 403/
  );
});

test('Firestore 500 throws (index.js maps it to 502)', async () => {
  await assert.rejects(
    () => check([], undefined, 500),
    /firestore query failed: HTTP 500/
  );
});

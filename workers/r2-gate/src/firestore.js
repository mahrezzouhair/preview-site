// Firestore enrollment check — as the LEARNER, with their own
// Firebase ID token. No service account, no master key anywhere.
//
// The Worker already verified the ID token (jwt.js), so the token is
// genuine and belongs to this uid. The query below carries that same
// token, so Firestore rules enforce ownership: rules v4.3 let a
// learner read only their OWN `course-enrollments` docs (owner uid)
// or an admin. A forged uid in the query therefore returns nothing —
// the rules, not the Worker, are the authority on who may read what.
//
// The enrollment check mirrors course.html exactly: the learner's
// `course-enrollments` docs carry { uid, courseId, course, status,
// name, email, method, createdAt }. Access is granted only when a doc
// exists with status 'approved' for this uid + courseId.

const RUN_QUERY_PATH = 'documents:runQuery';

// True when the learner has an APPROVED enrollment for this course.
// Queries by uid only (same pattern as course.html) and filters
// courseId + status in code, so no composite Firestore index is needed.
// Non-2xx from Firestore → throws (index.js maps it to 502).
// Missing/empty results → false.
export async function checkEnrollment(idToken, uid, courseId, { projectId, fetchFn = fetch } = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/${RUN_QUERY_PATH}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
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
    if (!f) return false;
    const courseMatches =
      (f.courseId && f.courseId.stringValue === courseId) ||
      (f.course && f.course.stringValue === courseId);
    return courseMatches && f.status && f.status.stringValue === 'approved';
  });
}

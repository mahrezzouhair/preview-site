// R2 video gate — Cloudflare Worker.
//
//   GET /watch?course=<courseId>&lesson=<lessonId>
//   Authorization: Bearer <Firebase ID token>   (skipped for free lessons)
//
// Checks, in order:
//   1. Domain lock — Origin (fetch) or Referer (video element) must be
//      in ALLOWED_ORIGINS. This stops other sites from using our Worker
//      as a free signing service.
//   2. course/lesson validation — hijama lessons must exist in the
//      approved curriculum (38 lessons, units 0–8).
//   3. Free preview lessons (hijama 0.1, 4.1) skip auth entirely.
//   4. Firebase ID token verification (RS256 against Google's keys).
//   5. Enrollment check — Firestore `course-enrollments` must hold an
//      APPROVED doc for this uid + courseId. The query runs AS the
//      learner, with their own verified ID token, so Firestore rules
//      enforce ownership (no service account, no master key).
//   6. Returns a short-lived presigned R2 URL (default 10 min) for
//      courses/<courseId>/<lessonId>.mp4. R2 supports Range requests
//      on presigned URLs, so seeking works in the player.
//
// Response: { url, expiresIn, course, lesson, free } or
// { error, detail? } with HTTP 400 / 401 / 403 / 502.

import {
  DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS,
  isValidCourse, isValidLesson, isFreeLesson, objectKey,
  parseAllowedOrigins, requestOrigin, isAllowedOrigin,
} from './config.js';
import { presignUrl } from './signing.js';
import { getGoogleKeys, verifyFirebaseIdToken } from './jwt.js';
import { checkEnrollment } from './firestore.js';

function jsonResponse(body, status, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  headers['Vary'] = 'Origin';
  return new Response(JSON.stringify(body), { status, headers });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const origin = requestOrigin(request);
    const originAllowed = allowedOrigins.includes(origin);

    // CORS preflight (the player fetches this Worker from the site).
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: originAllowed ? corsHeaders(origin) : {},
      });
    }

    if (url.pathname !== '/watch') {
      return jsonResponse({ error: 'not_found' }, 404, originAllowed ? origin : '');
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, originAllowed ? origin : '');
    }

    // 1. Domain lock — no Origin/Referer, or an origin not on the list:
    //    refuse. This also means opening a signed URL directly in a
    //    browser tab does not bypass the gate (the gate is the issuer).
    if (!isAllowedOrigin(request, allowedOrigins)) {
      return jsonResponse({ error: 'forbidden_origin' }, 403);
    }

    // 2. Params.
    const course = url.searchParams.get('course') || '';
    const lesson = url.searchParams.get('lesson') || '';
    if (!isValidCourse(course) || !isValidLesson(course, lesson)) {
      return jsonResponse({ error: 'invalid_course_or_lesson' }, 400, origin);
    }

    const free = isFreeLesson(course, lesson);

    // 3–5. Auth + enrollment (skipped for free preview lessons).
    if (!free) {
      const authHeader = request.headers.get('Authorization') || '';
      const m = /^Bearer\s+(.+)$/.exec(authHeader);
      if (!m) return jsonResponse({ error: 'missing_token' }, 401, origin);
      let claims;
      try {
        const keys = await getGoogleKeys();
        claims = await verifyFirebaseIdToken(m[1], {
          projectId: env.FIREBASE_PROJECT_ID,
          keys,
        });
      } catch (e) {
        return jsonResponse({ error: 'invalid_token', detail: e.message }, 401, origin);
      }
      try {
        const ok = await checkEnrollment(m[1], claims.uid, course, {
          projectId: env.FIREBASE_PROJECT_ID,
        });
        if (!ok) return jsonResponse({ error: 'not_enrolled' }, 403, origin);
      } catch (e) {
        return jsonResponse({ error: 'enrollment_check_failed', detail: e.message }, 502, origin);
      }
    }

    // 6. Presign the R2 URL.
    const ttl = Math.min(
      Math.max(Number(env.URL_TTL_SECONDS) || DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS),
      MAX_TTL_SECONDS
    );
    const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const key = objectKey(course, lesson);
    const signed = await presignUrl({
      host,
      path: `/${env.BUCKET_NAME}/${key}`,
      accessKey: env.R2_ACCESS_KEY_ID,
      secretKey: env.R2_SECRET_ACCESS_KEY,
      region: 'auto',
      service: 's3',
      expiresIn: ttl,
    });
    return jsonResponse(
      { url: signed, expiresIn: ttl, course, lesson, free },
      200,
      origin
    );
  },
};

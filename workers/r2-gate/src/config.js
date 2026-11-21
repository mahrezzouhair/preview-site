// Configuration for the R2 video gate.
//
// SAFE TO SHIP: course/lesson rules, free lessons, defaults.
// Everything secret lives in Worker secrets (wrangler secret put) —
// see R2-SETUP.md. No credential may ever be written in this file.

export const COURSES = ['hijama', 'bone', 'acu'];

// Hijama curriculum: unit -> number of lessons, from the approved
// منهج دورة الحجامة (9 units, 38 lessons). Lesson ids are "unit.lesson",
// e.g. 0.1, 4.1, 6.5.
export const HIJAMA_UNITS = { 0: 3, 1: 4, 2: 5, 3: 5, 4: 4, 5: 4, 6: 5, 7: 4, 8: 4 };

// Free preview lessons — public, no sign-in and no enrollment needed
// (the domain lock still applies). hijama 0.1 and 4.1 are the two free
// lessons shown on course.html.
export const FREE_LESSONS = { hijama: ['0.1', '4.1'] };

export const R2_KEY_PREFIX = 'courses';
export const DEFAULT_BUCKET = 'mahrez-courses';
export const DEFAULT_TTL_SECONDS = 600; // 10 minutes
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 3600;

export const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// R2 object key for a lesson video.
export function objectKey(courseId, lessonId) {
  return `${R2_KEY_PREFIX}/${courseId}/${lessonId}.mp4`;
}

export function isValidCourse(courseId) {
  return COURSES.includes(courseId);
}

// Validate a lesson id: "unit.lesson", e.g. "0.1", "6.5".
// For hijama the lesson must exist in the approved curriculum;
// for bone/acu (curricula not finalised yet) any well-formed id passes.
export function isValidLesson(courseId, lessonId) {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(lessonId || '');
  if (!m) return false;
  if (courseId !== 'hijama') return true;
  const unit = Number(m[1]);
  const lesson = Number(m[2]);
  const count = HIJAMA_UNITS[unit];
  return count !== undefined && lesson >= 1 && lesson <= count;
}

export function isFreeLesson(courseId, lessonId) {
  return (FREE_LESSONS[courseId] || []).includes(lessonId);
}

// Parse the comma-separated ALLOWED_ORIGINS var into a clean list.
export function parseAllowedOrigins(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

// Origin of a request: Origin header first, else the origin of Referer.
// (A <video> element request sends Referer, not Origin; a fetch() call
// sends Origin. Both are checked.)
export function requestOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin) return origin.replace(/\/$/, '');
  const referer = request.headers.get('Referer');
  if (referer) {
    try { return new URL(referer).origin; } catch { return ''; }
  }
  return '';
}

export function isAllowedOrigin(request, allowedOrigins) {
  const origin = requestOrigin(request);
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

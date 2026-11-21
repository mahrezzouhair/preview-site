# R2 video gate — «mahrez-courses-gate»

Cloudflare Worker that sits in front of the **private** R2 bucket
`mahrez-courses` and hands out short-lived signed URLs for course
videos — only to learners who are signed in **and** have an approved
enrollment for that course.

```
learner (video-test.html / course page)
  → GET https://<worker>.workers.dev/watch?course=hijama&lesson=0.1
    Authorization: Bearer <Firebase ID token>
  → Worker checks: domain lock → course/lesson → token → enrollment
  → { url: "https://<account>.r2.cloudflarestorage.com/mahrez-courses/courses/hijama/0.1.mp4?X-Amz-...&X-Amz-Expires=600", expiresIn: 600 }
  → <video src=url> plays it (Range requests work, so seeking works)
```

## Files

| File | What it does |
|---|---|
| `wrangler.toml` | Worker name, vars (project, bucket, TTL, allowed origins). Secrets are **not** in this file. |
| `src/index.js` | Worker entry: domain lock → validation → token → enrollment → presign. |
| `src/config.js` | Courses, hijama curriculum (9 units / 38 lessons), free lessons (0.1, 4.1), validation, domain-lock helpers. |
| `src/signing.js` | AWS Signature Version 4 on Web Crypto (presigned URLs + signed headers). Runs unchanged in Workers and in Node. |
| `src/jwt.js` | Firebase ID token verification (RS256 against Google's public keys). No Admin SDK. |
| `src/firestore.js` | Service-account OAuth2 token + enrollment check via the Firestore REST API. Mirrors `course.html`: `course-enrollments` docs carry `{ uid, courseId, course, status, name, email, method, createdAt }`; only `status === 'approved'` opens the video. |
| `src/encoding.js` | base64url helpers shared by `jwt.js` and `firestore.js`. |
| `tests/` | `node --test` suite: SigV4 (AWS docs vector), JWT (generated keys), validation, Firestore (mocked fetch). |
| `test-clip.mp4` | 10 s generated sample clip (ffmpeg test pattern) — for upload + player tests only, never a real lesson. |
| `R2-SETUP.md` | Exact console steps the owner still has to do (account, bucket, token, service account, secrets, deploy) + costs + honest security notes. |

## Rules the gate enforces

- **Domain lock:** `Origin` (fetch) or `Referer` (video element) must be in `ALLOWED_ORIGINS` (`mahrezzouhair.github.io` now; add the personal domain later). Anything else → 403.
- **Lesson validation:** hijama lessons must exist in the approved curriculum (`0.1`–`0.3`, `1.1`–`1.4`, `2.1`–`2.5`, `3.1`–`3.5`, `4.1`–`4.4`, `5.1`–`5.4`, `6.1`–`6.5`, `7.1`–`7.4`, `8.1`–`8.4`). Bone/acu accept any well-formed `unit.lesson` id until their curricula are finalised.
- **Free preview lessons** (hijama `0.1` and `4.1`) skip sign-in and enrollment — domain lock still applies.
- **Signed URLs live 10 minutes** (`URL_TTL_SECONDS`, 60–3600). A leaked URL stops working on its own; the player re-requests a fresh one when it expires.

## Errors (JSON, `{ error, detail? }`)

| HTTP | error | Meaning |
|---|---|---|
| 400 | `invalid_course_or_lesson` | Unknown course, or lesson id not in the curriculum |
| 401 | `missing_token` / `invalid_token` | No Bearer token, or the Firebase token failed verification |
| 403 | `forbidden_origin` | Origin/Referer not in the allowed list |
| 403 | `not_enrolled` | Signed in, but no approved enrollment for this course |
| 502 | `enrollment_check_failed` | Firestore / token-minting problem on our side |
| 404 | `not_found` | Any path other than `/watch` |

## Local checks (no deploy, no account)

```bash
cd workers/r2-gate
npm test            # node --test tests/  (SigV4 + JWT + validation + Firestore)
node --check src/index.js
node --check src/config.js
node --check src/signing.js
node --check src/jwt.js
node --check src/firestore.js
node --check src/encoding.js
```

## Upload a video (once the bucket exists)

```bash
# credentials ONLY from env vars — never in files
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=mahrez-courses   # optional, this is the default

node ../../scripts/r2-upload.mjs test-clip.mp4 hijama 0.1
# → uploads to courses/hijama/0.1.mp4
```

## Deploy (owner — see R2-SETUP.md for the full checklist)

```bash
cd workers/r2-gate
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
wrangler deploy
```

## Next step after deploy (not done here)

Wire the player into `course.html` / `my-courses.html`: the approved
learner's lesson list calls `/watch` with their Firebase ID token and
plays the returned URL in the same no-download player as
`../video-test.html`. The course pages were deliberately left
untouched until the bucket exists and real videos are uploaded.

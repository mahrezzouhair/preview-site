#!/usr/bin/env node
// Upload a course video to the private R2 bucket.
//   node r2-upload.mjs <local-file> <courseId> <lessonId>
//   → stored as courses/<courseId>/<lessonId>.mp4
//
// Credentials ONLY from environment variables — never in files, never
// in chat, never in git:
//   R2_ACCOUNT_ID         Cloudflare account ID
//   R2_ACCESS_KEY_ID      R2 API token access key id
//   R2_SECRET_ACCESS_KEY  R2 API token secret access key
//   R2_BUCKET             bucket name (default: mahrez-courses)
//
// The file is streamed (hashed first, then uploaded) so multi-GB
// lesson videos do not need to fit in memory.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { signHeaders, sha256Hex } from '../workers/r2-gate/src/signing.js';
import { isValidCourse, isValidLesson, objectKey, DEFAULT_BUCKET } from '../workers/r2-gate/src/config.js';

const [, , filePath, courseId, lessonId] = process.argv;

if (!filePath || !courseId || !lessonId) {
  console.error('Usage: node r2-upload.mjs <local-file> <courseId> <lessonId>');
  console.error('Example: node r2-upload.mjs lesson-0.1.mp4 hijama 0.1');
  process.exit(2);
}
if (!isValidCourse(courseId) || !isValidLesson(courseId, lessonId)) {
  console.error(`Invalid course/lesson: ${courseId}/${lessonId}`);
  process.exit(2);
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const bucket = process.env.R2_BUCKET || DEFAULT_BUCKET;
for (const [name, value] of [
  ['R2_ACCOUNT_ID', R2_ACCOUNT_ID],
  ['R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID],
  ['R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY],
]) {
  if (!value) {
    console.error(`Missing env var: ${name} (credentials come only from env vars — see R2-SETUP.md)`);
    process.exit(2);
  }
}

const key = objectKey(courseId, lessonId);
const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const path = `/${bucket}/${key}`;

const info = await stat(filePath);
console.log(`Uploading ${filePath} (${(info.size / 1024 / 1024).toFixed(1)} MB) → s3://${bucket}/${key}`);

// Stream-hash the file first (needed for the SigV4 body hash).
const hash = createHash('sha256');
await new Promise((resolve, reject) => {
  createReadStream(filePath)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', resolve)
    .on('error', reject);
});
const payloadHash = hash.digest('hex');

const signed = await signHeaders({
  method: 'PUT',
  host,
  path,
  headers: {
    host,
    'content-type': 'video/mp4',
    'x-amz-content-sha256': payloadHash,
  },
  payloadHash,
  accessKey: R2_ACCESS_KEY_ID,
  secretKey: R2_SECRET_ACCESS_KEY,
  region: 'auto',
  service: 's3',
});

const res = await fetch(`https://${host}${path}`, {
  method: 'PUT',
  headers: {
    ...signed,
    'Content-Type': 'video/mp4',
    'Content-Length': String(info.size),
  },
  body: createReadStream(filePath),
  duplex: 'half',
});

if (!res.ok) {
  console.error(`Upload failed: HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

console.log('OK — uploaded.');
console.log(`  bucket : ${bucket}`);
console.log(`  key    : ${key}`);
console.log(`  size   : ${info.size} bytes`);
console.log(`  sha256 : ${payloadHash}`);
console.log(`  watch  : GET <worker-url>/watch?course=${courseId}&lesson=${lessonId}`);

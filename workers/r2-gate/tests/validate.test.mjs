// Validation + domain-lock tests — run with: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCourse, isValidLesson, isFreeLesson, objectKey,
  parseAllowedOrigins, requestOrigin, isAllowedOrigin,
} from '../src/config.js';

test('courses: only hijama / bone / acu are valid', () => {
  assert.equal(isValidCourse('hijama'), true);
  assert.equal(isValidCourse('bone'), true);
  assert.equal(isValidCourse('acu'), true);
  assert.equal(isValidCourse('Hijama'), false);
  assert.equal(isValidCourse(''), false);
  assert.equal(isValidCourse('courses/hijama'), false);
});

test('hijama lessons must exist in the approved curriculum (38 lessons)', () => {
  // Unit boundaries: U0:3, U1:4, U2:5, U3:5, U4:4, U5:4, U6:5, U7:4, U8:4
  assert.equal(isValidLesson('hijama', '0.1'), true);
  assert.equal(isValidLesson('hijama', '0.3'), true);
  assert.equal(isValidLesson('hijama', '0.4'), false); // U0 has only 3
  assert.equal(isValidLesson('hijama', '6.5'), true);
  assert.equal(isValidLesson('hijama', '6.6'), false); // U6 has only 5
  assert.equal(isValidLesson('hijama', '8.4'), true);
  assert.equal(isValidLesson('hijama', '9.1'), false); // no unit 9
  assert.equal(isValidLesson('hijama', '1'), false);
  assert.equal(isValidLesson('hijama', 'x.y'), false);
  assert.equal(isValidLesson('hijama', '../secret'), false);
  assert.equal(isValidLesson('hijama', '0.1.mp4'), false);
});

test('bone/acu accept any well-formed lesson id until curricula are final', () => {
  assert.equal(isValidLesson('bone', '0.1'), true);
  assert.equal(isValidLesson('bone', '3.7'), true);
  assert.equal(isValidLesson('acu', '1.2'), true);
  assert.equal(isValidLesson('bone', 'nope'), false);
});

test('free preview lessons are exactly hijama 0.1 and 4.1', () => {
  assert.equal(isFreeLesson('hijama', '0.1'), true);
  assert.equal(isFreeLesson('hijama', '4.1'), true);
  assert.equal(isFreeLesson('hijama', '0.2'), false);
  assert.equal(isFreeLesson('hijama', '4.2'), false);
  assert.equal(isFreeLesson('bone', '0.1'), false);
});

test('object key layout', () => {
  assert.equal(objectKey('hijama', '0.1'), 'courses/hijama/0.1.mp4');
  assert.equal(objectKey('bone', '2.3'), 'courses/bone/2.3.mp4');
});

test('allowed origins parsing', () => {
  assert.deepEqual(
    parseAllowedOrigins('https://mahrezzouhair.github.io, https://mahrezzouhair.com/'),
    ['https://mahrezzouhair.github.io', 'https://mahrezzouhair.com']
  );
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test('domain lock: Origin first, else Referer; unknown or missing is refused', () => {
  const allowed = ['https://mahrezzouhair.github.io', 'https://mahrezzouhair.com'];
  const withOrigin = new Request('https://w.example.com/watch', {
    headers: { Origin: 'https://mahrezzouhair.github.io' },
  });
  assert.equal(requestOrigin(withOrigin), 'https://mahrezzouhair.github.io');
  assert.equal(isAllowedOrigin(withOrigin, allowed), true);

  const withReferer = new Request('https://w.example.com/watch', {
    headers: { Referer: 'https://mahrezzouhair.github.io/preview-site/video-test.html' },
  });
  assert.equal(requestOrigin(withReferer), 'https://mahrezzouhair.github.io');
  assert.equal(isAllowedOrigin(withReferer, allowed), true);

  const evil = new Request('https://w.example.com/watch', {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(isAllowedOrigin(evil, allowed), false);

  const none = new Request('https://w.example.com/watch');
  assert.equal(requestOrigin(none), '');
  assert.equal(isAllowedOrigin(none, allowed), false);
});

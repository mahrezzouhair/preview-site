// SigV4 tests — run with: node --test tests/
// The AWS example below uses the PUBLIC documentation example keys
// (AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY)
// from the AWS Signature Version 4 docs. They are not real credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presignUrl, signHeaders, sha256Hex } from '../src/signing.js';

test('presigned URL matches the AWS documentation example', async () => {
  const url = await presignUrl({
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    expiresIn: 86400,
    date: '20130524T000000Z',
  });
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
    '&X-Amz-Date=20130524T000000Z' +
    '&X-Amz-Expires=86400' +
    '&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
  );
});

test('canonical request hash matches the AWS documentation example', async () => {
  // Same inputs as the test above; the docs publish this intermediate
  // value, so it pins the canonical-request construction independently
  // of the final signature.
  const { signRequest } = await import('../src/signing.js');
  const { canonicalRequest } = await signRequest({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    query: {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
      'X-Amz-Date': '20130524T000000Z',
      'X-Amz-Expires': '86400',
      'X-Amz-SignedHeaders': 'host',
    },
    headers: { host: 'examplebucket.s3.amazonaws.com' },
    payloadHash: 'UNSIGNED-PAYLOAD',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    date: '20130524T000000Z',
  });
  assert.equal(
    await sha256Hex(canonicalRequest),
    '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04'
  );
});

test('R2-style presigned URL has the right shape and is deterministic', async () => {
  const args = {
    host: '0123456789abcdef.r2.cloudflarestorage.com',
    path: '/mahrez-courses/courses/hijama/0.1.mp4',
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    region: 'auto',
    service: 's3',
    expiresIn: 600,
    date: '20261121T120000Z',
  };
  const a = await presignUrl(args);
  const b = await presignUrl(args);
  assert.equal(a, b, 'same inputs must give the same URL');
  assert.ok(a.startsWith('https://0123456789abcdef.r2.cloudflarestorage.com/mahrez-courses/courses/hijama/0.1.mp4?'));
  assert.ok(a.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'));
  assert.ok(a.includes('X-Amz-Expires=600'));
  assert.ok(a.includes('X-Amz-SignedHeaders=host'));
  const sig = new URL(a).searchParams.get('X-Amz-Signature');
  assert.match(sig, /^[0-9a-f]{64}$/);
  // A different expiry must change the signature.
  const c = await presignUrl({ ...args, expiresIn: 60 });
  assert.notEqual(a, c);
});

test('signHeaders produces a well-formed Authorization header', async () => {
  const bodyHash = await sha256Hex('hello');
  const headers = await signHeaders({
    method: 'PUT',
    host: '0123456789abcdef.r2.cloudflarestorage.com',
    path: '/mahrez-courses/courses/hijama/0.1.mp4',
    headers: {
      host: '0123456789abcdef.r2.cloudflarestorage.com',
      'content-type': 'video/mp4',
      'x-amz-content-sha256': bodyHash,
    },
    payloadHash: bodyHash,
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    region: 'auto',
    service: 's3',
    date: '20261121T120000Z',
  });
  assert.match(
    headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=test-access-key\/20261121\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256, Signature=[0-9a-f]{64}$/
  );
  assert.equal(headers['X-Amz-Date'], '20261121T120000Z');
  assert.equal(headers['X-Amz-Content-Sha256'], bodyHash);
});

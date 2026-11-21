// AWS Signature Version 4 — implemented on Web Crypto (SubtleCrypto),
// so the same code runs in Cloudflare Workers and in Node >= 19
// (globalThis.crypto.subtle). No npm dependency.
//
// Two uses:
//   - presignUrl(): short-lived GET URL for R2 (the Worker returns this
//     to the player; R2 supports Range requests on presigned URLs, so
//     seeking works).
//   - signHeaders(): Authorization header for a signed request with a
//     body hash (the upload helper uses this for PUT).

const encoder = new TextEncoder();

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC', cryptoKey, typeof data === 'string' ? encoder.encode(data) : data
  );
  return new Uint8Array(sig);
}

export async function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = await hmac(encoder.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function amzDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function dateStamp(isoDate) { return isoDate.slice(0, 8); }

// RFC 3986 percent-encoding (encodeURIComponent leaves !'()* unescaped).
export function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQueryString(params) {
  return Object.keys(params).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join('&');
}

function canonicalUri(path) {
  return path.split('/').map((seg) => encodeRfc3986(seg)).join('/');
}

export async function signRequest({ method, host, path, query = {}, headers = {}, payloadHash, accessKey, secretKey, region, service, date }) {
  const datetime = date || amzDate();
  const stamp = dateStamp(datetime);
  const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const canonicalRequest = [
    method,
    canonicalUri(path),
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${stamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', datetime, scope, await sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = await getSignatureKey(secretKey, stamp, region, service);
  const signature = [...await hmac(signingKey, stringToSign)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return { canonicalRequest, stringToSign, scope, signature, datetime, signedHeaders: signedHeaders.join(';') };
}

// Build a presigned GET URL for an S3-compatible endpoint (Cloudflare R2).
export async function presignUrl({ host, path, accessKey, secretKey, region = 'auto', service = 's3', expiresIn = 600, date }) {
  const datetime = date || amzDate();
  const stamp = dateStamp(datetime);
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${stamp}/${region}/${service}/aws4_request`,
    'X-Amz-Date': datetime,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  const { signature } = await signRequest({
    method: 'GET', host, path, query,
    headers: { host },
    payloadHash: 'UNSIGNED-PAYLOAD',
    accessKey, secretKey, region, service, date: datetime,
  });
  return `https://${host}${canonicalUri(path)}?${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
}

// Build the Authorization header for a signed request with a body hash
// (used by the upload helper for PUT).
export async function signHeaders({ method, host, path, query = {}, headers, payloadHash, accessKey, secretKey, region = 'auto', service = 's3', date }) {
  const datetime = date || amzDate();
  const { signature, scope, signedHeaders } = await signRequest({
    method, host, path, query, headers, payloadHash,
    accessKey, secretKey, region, service, date: datetime,
  });
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': datetime,
    'X-Amz-Content-Sha256': payloadHash,
  };
}

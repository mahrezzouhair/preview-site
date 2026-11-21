// Base64url helpers — shared by the JWT verification code.
// Works in Cloudflare Workers and in Node (atob/btoa exist in both).
export const base64url = {
  decode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  },
  encode(bytes) {
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  encodeText(text) {
    return base64url.encode(new TextEncoder().encode(text));
  },
};

// Decode a base64 (standard alphabet, with or without padding) string
// into bytes — used for PEM private keys.
export function base64Decode(s) {
  const clean = s.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

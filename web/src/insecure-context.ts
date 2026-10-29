// Browsers offer crypto.subtle and crypto.randomUUID only in a secure context: HTTPS or localhost. The VM
// deployment serves the app over plain HTTP on a VM's address (http://10.2.44.21:8080), where both are missing –
// and the sign-in needs them (oidc-client-ts: SHA-256 for the PKCE code challenge, UUIDs for the state).
// crypto.getRandomValues exists everywhere, so both are added on top of it, only where the browser hides them.
// Imported first in main.tsx.

if (typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}

if (!crypto.subtle) {
  // only digest('SHA-256') – all the sign-in uses (DPoP, which would need keys, is not enabled)
  Object.defineProperty(crypto, 'subtle', {
    value: {
      digest: async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
        const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
        if (name.toUpperCase() !== 'SHA-256') throw new DOMException(`${name} needs HTTPS`, 'NotSupportedError');
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        return sha256(bytes).buffer as ArrayBuffer;
      },
    },
  });
}

/** SHA-256 (FIPS 180-4). */
export function sha256(message: Uint8Array): Uint8Array {
  const k = new Uint32Array(64);
  for (let i = 0, n = 2; i < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
    if (prime) k[i++] = (Math.cbrt(n) % 1) * 2 ** 32; // fractional part of the cube root of the first 64 primes
  }
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(message.length / 2 ** 29)); // length in bits, big-endian
  view.setUint32(padded.length - 4, message.length * 8);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => {
      h[i] += value;
    });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

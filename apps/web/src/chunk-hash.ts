import { sha256 } from '@noble/hashes/sha2.js';

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(data)))
    : sha256(data);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

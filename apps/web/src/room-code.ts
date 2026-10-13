const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{8}$/;

export function generateRoomCode(
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): string {
  const bytes = randomBytes(CODE_LENGTH);
  if (bytes.length !== CODE_LENGTH) {
    throw new Error('Room code generator returned the wrong number of bytes');
  }
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function normalizeRoomCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

export function displayRoomCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

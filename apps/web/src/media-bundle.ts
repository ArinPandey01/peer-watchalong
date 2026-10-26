const MAGIC = [0x50, 0x57, 0x43, 0x48];
const HEADER_BYTES = 8;
const PART_BYTES = 8;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export interface BundlePart {
  trackId: number;
  data: Uint8Array;
}

export function encodeMediaBundle(parts: readonly BundlePart[]): Uint8Array {
  if (parts.length < 1 || parts.length > 255) throw new RangeError('Invalid media bundle');
  const size = HEADER_BYTES + parts.length * PART_BYTES +
    parts.reduce((total, part) => total + part.data.byteLength, 0);
  if (size > MAX_BUNDLE_BYTES) {
    throw new Error('This video has a segment larger than 16 MB.');
  }
  const result = new Uint8Array(size);
  result.set(MAGIC);
  result[4] = 1;
  result[5] = parts.length;
  const view = new DataView(result.buffer);
  let offset = HEADER_BYTES + parts.length * PART_BYTES;
  for (const [index, part] of parts.entries()) {
    view.setUint32(HEADER_BYTES + index * PART_BYTES, part.trackId);
    view.setUint32(HEADER_BYTES + index * PART_BYTES + 4, part.data.byteLength);
    result.set(part.data, offset);
    offset += part.data.byteLength;
  }
  return result;
}

export function decodeMediaBundle(
  data: Uint8Array,
  expected: readonly { trackId: number; byteLength: number }[],
): Map<number, Uint8Array> {
  if (data.byteLength < HEADER_BYTES ||
      MAGIC.some((byte, index) => data[index] !== byte) || data[4] !== 1 ||
      data[5] !== expected.length || data[6] !== 0 || data[7] !== 0) {
    throw new Error('Invalid media bundle header.');
  }
  const headerEnd = HEADER_BYTES + expected.length * PART_BYTES;
  if (data.byteLength < headerEnd) throw new Error('Incomplete media bundle.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts = new Map<number, Uint8Array>();
  let offset = headerEnd;
  for (const [index, part] of expected.entries()) {
    const trackId = view.getUint32(HEADER_BYTES + index * PART_BYTES);
    const length = view.getUint32(HEADER_BYTES + index * PART_BYTES + 4);
    if (trackId !== part.trackId || length !== part.byteLength ||
        parts.has(trackId) || length === 0 || offset + length > data.byteLength) {
      throw new Error('Invalid media bundle part.');
    }
    parts.set(trackId, data.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== data.byteLength) throw new Error('Invalid media bundle length.');
  return parts;
}

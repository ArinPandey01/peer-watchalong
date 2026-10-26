import { createFile, type Track } from 'mp4box';
import type { MediaManifest } from '@peer-watchalong/protocol';
import { sha256Hex } from './chunk-hash.ts';
import { encodeMediaBundle } from './media-bundle.ts';

const READ_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const TARGET_SECONDS = 2;

interface ChunkBase {
  chunkIndex: number;
  kind: 'init' | 'media';
  startTimeSec: number;
  endTimeSec: number;
  byteLength: number;
}

export type MediaChunk = ChunkBase & ({ trackId: number; parts?: never } | {
  trackId?: never;
  parts: Array<{
    trackId: number;
    startTimeSec: number;
    endTimeSec: number;
    byteLength: number;
  }>;
});

export interface PreparedMedia {
  durationSec: number;
  tracks: Array<{ id: number; kind: 'audio' | 'video'; mimeType: string }>;
  chunks: MediaChunk[];
  readChunk: (chunkIndex: number) => Uint8Array | null;
}

export async function createMediaManifest(
  media: PreparedMedia, mediaId: string, signal?: AbortSignal,
): Promise<MediaManifest> {
  const chunks: MediaManifest['chunks'] = [];
  for (const chunk of media.chunks) {
    if (signal?.aborted) throw new DOMException('Media preparation cancelled', 'AbortError');
    const data = media.readChunk(chunk.chunkIndex);
    if (!data) throw new Error('A prepared segment is missing.');
    chunks.push({ ...chunk, sha256: await sha256Hex(data) });
  }
  const manifest = {
    mediaId,
    durationSec: media.durationSec,
    tracks: media.tracks,
    chunks,
  };
  return manifest;
}

export function createMediaWindow(
  manifest: MediaManifest,
  targetTimeSec: number,
): MediaManifest {
  const target = Math.max(0, Math.min(targetTimeSec, manifest.durationSec));
  let behindSec = 8;
  let aheadSec = 24;
  for (;;) {
    const start = Math.max(0, target - behindSec);
    const end = Math.min(manifest.durationSec, target + aheadSec);
    const chunks = manifest.chunks.filter((chunk) =>
      chunk.kind === 'init' ||
      (chunk.endTimeSec > start && chunk.startTimeSec <= end));
    for (const track of manifest.tracks) {
      if (chunks.some((chunk) => chunk.kind === 'media' &&
          (chunk.trackId === track.id || chunk.parts?.some((part) => part.trackId === track.id)))) continue;
      const fallback = [...manifest.chunks].reverse().find((chunk) =>
        chunk.kind === 'media' && chunk.startTimeSec <= target &&
        (chunk.trackId === track.id || chunk.parts?.some((part) => part.trackId === track.id)));
      if (fallback && !chunks.includes(fallback)) chunks.push(fallback);
    }
    const firstBundle = chunks.find((chunk) => chunk.kind === 'media' && chunk.parts);
    if (firstBundle) {
      const previous = [...manifest.chunks].reverse().find((chunk) =>
        chunk.kind === 'media' && chunk.parts && chunk.chunkIndex < firstBundle.chunkIndex);
      if (previous && !chunks.includes(previous)) chunks.push(previous);
    }
    chunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
    const window = { ...manifest, totalChunks: manifest.chunks.length, chunks };
    if (chunks.length <= 512 && JSON.stringify(window).length <= 48 * 1024) return window;
    if (behindSec <= 1 && aheadSec <= 2) {
      throw new Error('The selected part of this video has too many segments.');
    }
    behindSec = Math.max(1, behindSec / 2);
    aheadSec = Math.max(2, aheadSec / 2);
  }
}

export async function hashMediaWindow(
  media: PreparedMedia,
  window: MediaManifest,
  hashes: Map<number, string>,
  signal?: AbortSignal,
): Promise<MediaManifest> {
  const chunks: MediaManifest['chunks'] = [];
  for (const chunk of window.chunks) {
    if (signal?.aborted) throw new DOMException('Media preparation cancelled', 'AbortError');
    let sha256 = hashes.get(chunk.chunkIndex);
    if (!sha256) {
      const data = media.readChunk(chunk.chunkIndex);
      if (!data) throw new Error('A prepared segment is missing.');
      sha256 = await sha256Hex(data);
      hashes.set(chunk.chunkIndex, sha256);
    }
    chunks.push({ ...chunk, sha256 });
  }
  return { ...window, chunks };
}

export async function prepareMp4(
  source: Blob,
  options: { signal?: AbortSignal; supportsType?: (mimeType: string) => boolean } = {},
): Promise<PreparedMedia> {
  if (source.size === 0 || source.size > MAX_FILE_BYTES) {
    throw new Error('Choose an MP4 file smaller than 256 MB.');
  }
  const supportsType = options.supportsType ?? ((mimeType: string) =>
    typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType));
  const file = createFile(await mediaDataPrecedesMetadata(source, options.signal));
  const chunks: MediaChunk[] = [];
  const bytes = new Map<number, Uint8Array>();
  const rawMedia: Array<{ trackId: number; startTimeSec: number; endTimeSec: number;
    data: Uint8Array }> = [];
  const trackEnds = new Map<number, number>();
  let durationSec = 0;
  let selectedTracks: Track[] = [];
  let failure: Error | null = null;

  function addChunk(trackId: number, kind: 'init' | 'media', buffer: ArrayBuffer,
    startTimeSec: number, endTimeSec: number): void {
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_CHUNK_BYTES) {
      failure = new Error('This video has a segment larger than 16 MB.');
      return;
    }
    const chunkIndex = chunks.length;
    chunks.push({ chunkIndex, trackId, kind, startTimeSec, endTimeSec,
      byteLength: buffer.byteLength });
    bytes.set(chunkIndex, new Uint8Array(buffer));
  }

  file.onError = (_module, message) => { failure = new Error(`Could not read MP4: ${message}`); };
  file.onReady = (info) => {
    try {
      if (info.videoTracks.length !== 1 || info.audioTracks.length > 1 ||
          info.tracks.length !== info.videoTracks.length + info.audioTracks.length ||
          !Number.isFinite(info.duration / info.timescale) || info.duration <= 0) {
        throw new Error('Choose an MP4 with one video track and at most one audio track.');
      }
      selectedTracks = [info.videoTracks[0]!, ...info.audioTracks];
      const videoTrack = info.videoTracks[0]!;
      if (selectedTracks.some((track) => track.timescale <= 0 ||
          track.duration <= 0 || track.nb_samples <= 0)) {
        throw new Error('This MP4 has incomplete track timing information.');
      }
      const samplesPerSegment = Math.max(1, Math.round(
        videoTrack.nb_samples * TARGET_SECONDS / (videoTrack.duration / videoTrack.timescale),
      ));
      for (const track of selectedTracks) {
        const mimeType = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
        if (!supportsType(mimeType)) {
          throw new Error(`This browser cannot play the ${track.video ? 'video' : 'audio'} codec.`);
        }
        file.setSegmentOptions(track.id, track.id, {
          nbSamples: samplesPerSegment,
          rapAlignement: !!track.video,
        });
        trackEnds.set(track.id, 0);
      }
      for (const init of file.initializeSegmentation('per-track')) {
        addChunk(init.id, 'init', init.buffer, 0, 0);
      }
      durationSec = info.duration / info.timescale;
      file.start();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  };
  file.onSegment = (id, _user, buffer, nextSample) => {
    if (failure) return;
    const track = selectedTracks.find((entry) => entry.id === id);
    if (!track) return;
    const previousEnd = trackEnds.get(id) ?? 0;
    const lastSample = file.getTrackSamplesInfo(id)?.[nextSample - 1];
    const end = lastSample
      ? (lastSample.cts + lastSample.duration) / track.timescale
      : track.duration / track.timescale;
    rawMedia.push({ trackId: id, startTimeSec: previousEnd, endTimeSec: end,
      data: new Uint8Array(buffer) });
    trackEnds.set(id, end);
    file.releaseUsedSamples(id, nextSample);
  };

  try {
    for (let offset = 0; offset < source.size; offset += READ_BYTES) {
      if (options.signal?.aborted) throw new DOMException('Media preparation cancelled', 'AbortError');
      const buffer = await source.slice(offset, offset + READ_BYTES).arrayBuffer() as
        ArrayBuffer & { fileStart: number };
      buffer.fileStart = offset;
      file.appendBuffer(buffer);
      if (failure) throw failure;
    }
    file.flush();
    if (failure) throw failure;
    const videoTrackId = selectedTracks.find((track) => track.video)?.id;
    const videoSegments = rawMedia.filter((segment) => segment.trackId === videoTrackId)
      .sort((left, right) => left.startTimeSec - right.startTimeSec);
    const audioSegments = rawMedia.filter((segment) => segment.trackId !== videoTrackId)
      .sort((left, right) => left.startTimeSec - right.startTimeSec);
    const audioGroups = videoSegments.map(() => [] as typeof audioSegments);
    let videoIndex = 0;
    for (const segment of audioSegments) {
      while (videoSegments[videoIndex + 1] &&
          segment.startTimeSec >= videoSegments[videoIndex + 1]!.startTimeSec - 0.25) {
        videoIndex++;
      }
      if (!videoSegments[videoIndex] ||
          segment.startTimeSec < videoSegments[videoIndex]!.startTimeSec - 0.25) {
        throw new Error('Could not align this MP4 audio with its video.');
      }
      audioGroups[videoIndex]!.push(segment);
    }
    for (const [index, video] of videoSegments.entries()) {
      const audio = audioGroups[index]!;
      const parts = [{ trackId: video.trackId, startTimeSec: video.startTimeSec,
        endTimeSec: video.endTimeSec, data: video.data }];
      if (audio.length) {
        const combined = new Uint8Array(audio.reduce((size, segment) =>
          size + segment.data.byteLength, 0));
        let offset = 0;
        for (const segment of audio) {
          combined.set(segment.data, offset);
          offset += segment.data.byteLength;
        }
        parts.push({ trackId: audio[0]!.trackId, startTimeSec: audio[0]!.startTimeSec,
          endTimeSec: audio.at(-1)!.endTimeSec, data: combined });
      }
      const bundle = encodeMediaBundle(parts);
      if (bundle.byteLength > MAX_CHUNK_BYTES) {
        throw new Error('This video has a segment larger than 16 MB.');
      }
      const chunkIndex = chunks.length;
      chunks.push({ chunkIndex, kind: 'media', startTimeSec: video.startTimeSec,
        endTimeSec: video.endTimeSec, byteLength: bundle.byteLength,
        parts: parts.map(({ trackId, startTimeSec, endTimeSec, data }) => ({
          trackId, startTimeSec, endTimeSec, byteLength: data.byteLength,
        })) });
      bytes.set(chunkIndex, bundle);
    }
    if (durationSec === 0 || chunks.length <= selectedTracks.length) {
      throw new Error('No playable media segments were found in this MP4.');
    }
    return {
      durationSec,
      tracks: selectedTracks.map((track) => ({
        id: track.id,
        kind: track.video ? 'video' : 'audio',
        mimeType: `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`,
      })),
      chunks,
      readChunk: (chunkIndex) => bytes.get(chunkIndex) ?? null,
    };
  } finally {
    file.stop();
  }
}

async function mediaDataPrecedesMetadata(source: Blob, signal?: AbortSignal): Promise<boolean> {
  for (let offset = 0; offset + 8 <= source.size;) {
    if (signal?.aborted) throw new DOMException('Media preparation cancelled', 'AbortError');
    const header = new DataView(await source.slice(offset, offset + 16).arrayBuffer());
    const type = String.fromCharCode(
      header.getUint8(4), header.getUint8(5), header.getUint8(6), header.getUint8(7),
    );
    if (type === 'moov') return false;
    if (type === 'mdat') return true;
    let size = header.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16 || header.getUint32(8) !== 0) return false;
      size = header.getUint32(12);
      headerSize = 16;
    } else if (size === 0) {
      size = source.size - offset;
    }
    if (size < headerSize || offset + size > source.size) return false;
    offset += size;
  }
  return false;
}

import { createFile, type Track } from 'mp4box';
import type { MediaManifest } from '@peer-watchalong/protocol';
import { sha256Hex } from './chunk-hash.ts';

const READ_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const TARGET_SECONDS = 2;

export interface MediaChunk {
  chunkIndex: number;
  trackId: number;
  kind: 'init' | 'media';
  startTimeSec: number;
  endTimeSec: number;
  byteLength: number;
}

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
  if (manifest.chunks.length > 512 || JSON.stringify(manifest).length > 48 * 1024) {
    throw new Error('This video has too many segments to share in one room.');
  }
  return manifest;
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
  const file = createFile();
  const chunks: MediaChunk[] = [];
  const bytes = new Map<number, Uint8Array>();
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
    addChunk(id, 'media', buffer, previousEnd, end);
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

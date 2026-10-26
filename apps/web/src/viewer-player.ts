import type { MediaManifest } from '@peer-watchalong/protocol';
import type { PlaybackDecision } from '@peer-watchalong/scheduler';
import { decodeMediaBundle } from './media-bundle.ts';

interface TrackBuffer {
  id: number;
  mimeType: string;
  initIndex: number;
  mediaIndices: number[];
  sourceBuffer: SourceBuffer | null;
  appended: Set<number>;
  nextPosition: number;
  inFlight: { chunkIndex: number; position: number | null } | null;
  evictBeforeSec: number;
  onUpdateEnd?: () => void;
  onError?: () => void;
}

export interface ViewerPlayerOptions {
  onBuffered?: () => void;
  onBlocked?: () => void;
  onError?: (error: Error) => void;
  createMediaSource?: () => MediaSource;
  createObjectUrl?: (source: MediaSource) => string;
  revokeObjectUrl?: (url: string) => void;
  supportsType?: (mimeType: string) => boolean;
}

export class ViewerPlayer {
  private readonly video: HTMLVideoElement;
  private manifest: MediaManifest;
  private readonly options: ViewerPlayerOptions;
  private readonly mediaSource: MediaSource;
  private readonly objectUrl: string;
  private readonly tracks: TrackBuffer[];
  private readonly chunks = new Map<string, Uint8Array>();
  private readonly knownChunkStarts = new Map<string, number>();
  private readonly onSourceOpen: () => void;
  private readonly onVideoError: () => void;
  private playAttempt: Promise<void> | null = null;
  private blocked = false;
  private closed = false;
  private failed = false;
  private lastDecision: PlaybackDecision | null = null;
  private pendingSeekTime: number | null = null;

  constructor(video: HTMLVideoElement, manifest: MediaManifest, options: ViewerPlayerOptions = {}) {
    this.video = video;
    this.manifest = manifest;
    this.options = options;
    const supportsType = options.supportsType ?? ((mimeType: string) =>
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType));
    if (manifest.tracks.some((track) => !supportsType(track.mimeType))) {
      throw new Error('This browser cannot play the video or audio codec.');
    }
    if (!options.createMediaSource && typeof MediaSource === 'undefined') {
      throw new Error('This browser does not support Media Source playback.');
    }
    this.tracks = manifest.tracks.map((track) => {
      const init = manifest.chunks.find((chunk) => chunk.trackId === track.id &&
        chunk.kind === 'init');
      if (!init) throw new Error('The video manifest is missing initialization data.');
      return {
        id: track.id,
        mimeType: track.mimeType,
        initIndex: init.chunkIndex,
        mediaIndices: manifest.chunks.filter((chunk) => chunk.kind === 'media' &&
          (chunk.trackId === track.id || chunk.parts?.some((part) =>
            part.trackId === track.id))).map((chunk) => chunk.chunkIndex),
        sourceBuffer: null,
        appended: new Set<number>(),
        nextPosition: 0,
        inFlight: null,
        evictBeforeSec: 0,
      };
    });
    for (const chunk of manifest.chunks) {
      if (chunk.kind !== 'media') continue;
      for (const track of manifest.tracks) {
        const start = chunk.parts?.find((part) => part.trackId === track.id)?.startTimeSec ??
          (chunk.trackId === track.id ? chunk.startTimeSec : null);
        if (start !== null) this.knownChunkStarts.set(this.key(chunk.chunkIndex, track.id), start);
      }
    }
    this.mediaSource = options.createMediaSource?.() ?? new MediaSource();
    this.objectUrl = (options.createObjectUrl ?? URL.createObjectURL)(this.mediaSource);
    this.onSourceOpen = () => this.openBuffers();
    this.onVideoError = () => {
      const detail = this.video.error?.message;
      this.reportError(new Error(`The browser could not play this video (media error ${
        this.video.error?.code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`));
    };
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
    this.video.addEventListener('error', this.onVideoError);
    this.video.src = this.objectUrl;
  }

  receiveChunk(chunkIndex: number, data: Uint8Array): void {
    if (this.closed || this.failed) return;
    const chunk = this.manifest.chunks.find((entry) => entry.chunkIndex === chunkIndex);
    if (!chunk) return;
    try {
      if (chunk.parts) {
        const parts = decodeMediaBundle(data, chunk.parts);
        for (const [trackId, bytes] of parts) {
          this.chunks.set(this.key(chunkIndex, trackId), bytes);
        }
      } else {
        this.chunks.set(this.key(chunkIndex, chunk.trackId), data);
      }
    } catch (error) {
      this.reportError(error);
      return;
    }
    for (const track of this.tracks) this.pump(track);
  }

  updateManifest(manifest: MediaManifest): void {
    if (this.closed || this.failed || manifest.mediaId !== this.manifest.mediaId) return;
    this.manifest = manifest;
    for (const chunk of manifest.chunks) {
      if (chunk.kind !== 'media') continue;
      for (const track of manifest.tracks) {
        const start = chunk.parts?.find((part) => part.trackId === track.id)?.startTimeSec ??
          (chunk.trackId === track.id ? chunk.startTimeSec : null);
        if (start !== null) this.knownChunkStarts.set(this.key(chunk.chunkIndex, track.id), start);
      }
    }
    const available = new Set(manifest.chunks.map((chunk) => chunk.chunkIndex));
    for (const key of this.chunks.keys()) {
      if (!available.has(Number(key.split(':')[0]))) this.chunks.delete(key);
    }
    for (const key of this.knownChunkStarts.keys()) {
      const [index] = key.split(':');
      if (!available.has(Number(index)) &&
          !this.tracks.some((track) => track.appended.has(Number(index)))) {
        this.knownChunkStarts.delete(key);
      }
    }
    for (const track of this.tracks) {
      track.mediaIndices = manifest.chunks.filter((chunk) =>
        chunk.kind === 'media' && (chunk.trackId === track.id ||
          chunk.parts?.some((part) => part.trackId === track.id))).map((chunk) => chunk.chunkIndex);
    }
    const firstVideo = manifest.chunks.find((chunk) =>
      chunk.kind === 'media' && manifest.tracks.some((track) =>
        track.kind === 'video' && (track.id === chunk.trackId ||
          chunk.parts?.some((part) => part.trackId === track.id))));
    const before = Math.max(0, (firstVideo?.startTimeSec ?? 0) - 4);
    for (const track of this.tracks) {
      track.evictBeforeSec = before;
      this.evictOldBuffer(track);
    }
    this.seekBuffers(this.pendingSeekTime ?? this.video.currentTime);
  }

  applyDecision(decision: PlaybackDecision): void {
    if (this.closed || this.failed) return;
    this.lastDecision = decision;
    if (!('targetMediaTimeSec' in decision)) {
      this.video.pause();
      return;
    }
    const target = Math.min(Math.max(0, decision.targetMediaTimeSec),
      Math.max(0, this.manifest.durationSec - 0.05));
    if (decision.type === 'SEEK') {
      this.pendingSeekTime = target;
      this.seekBuffers(target);
      if (!this.isBuffered(target)) {
        this.video.pause();
        return;
      }
      if (Math.abs(this.video.currentTime - target) > 0.05) this.video.currentTime = target;
      this.pendingSeekTime = null;
    }
    this.video.playbackRate = decision.playbackRate;
    if (!decision.playing || !this.isBuffered(this.video.currentTime)) {
      this.video.pause();
      return;
    }
    if (this.video.paused && !this.blocked) void this.tryPlay();
  }

  async startWatching(): Promise<void> {
    if (this.closed || this.failed) return;
    this.blocked = false;
    if (this.lastDecision && 'playing' in this.lastDecision && this.lastDecision.playing &&
        this.isBuffered(this.video.currentTime)) {
      await this.tryPlay();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.video.pause();
    this.video.removeEventListener('error', this.onVideoError);
    this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
    for (const track of this.tracks) {
      if (track.sourceBuffer && track.onUpdateEnd && track.onError) {
        track.sourceBuffer.removeEventListener('updateend', track.onUpdateEnd);
        track.sourceBuffer.removeEventListener('error', track.onError);
      }
    }
    this.video.removeAttribute('src');
    this.video.load();
    (this.options.revokeObjectUrl ?? URL.revokeObjectURL)(this.objectUrl);
    this.chunks.clear();
  }

  private openBuffers(): void {
    if (this.closed || this.failed || this.mediaSource.readyState !== 'open' ||
        this.tracks.some((track) => track.sourceBuffer)) return;
    try {
      for (const track of this.tracks) {
        const buffer = this.mediaSource.addSourceBuffer(track.mimeType);
        track.sourceBuffer = buffer;
        track.onUpdateEnd = () => {
          const written = track.inFlight;
          track.inFlight = null;
          if (this.closed || this.failed) return;
          if (written) {
            track.appended.add(written.chunkIndex);
            if (written.position !== null && track.nextPosition === written.position) {
              track.nextPosition++;
            }
          }
          this.evictOldBuffer(track);
          if (written) this.options.onBuffered?.();
          this.pump(track);
        };
        track.onError = () => this.reportError(new Error('The browser rejected a video segment.'));
        buffer.addEventListener('updateend', track.onUpdateEnd);
        buffer.addEventListener('error', track.onError);
      }
      this.mediaSource.duration = this.manifest.durationSec;
      for (const track of this.tracks) this.pump(track);
    } catch (error) {
      this.reportError(error);
    }
  }

  private seekBuffers(target: number): void {
    for (const track of this.tracks) {
      const position = track.mediaIndices.findIndex((chunkIndex) =>
        (this.endTime(chunkIndex, track.id) ?? 0) > target);
      track.nextPosition = position < 0 ? track.mediaIndices.length : position;
      const chunkIndex = track.mediaIndices[track.nextPosition];
      if (chunkIndex !== undefined && track.appended.has(chunkIndex) &&
          !this.trackIsBuffered(track, target)) track.appended.delete(chunkIndex);
      this.pump(track);
    }
  }

  private pump(track: TrackBuffer): void {
    const buffer = track.sourceBuffer;
    if (this.closed || this.failed || !buffer || buffer.updating || track.inFlight) return;
    if (!track.appended.has(track.initIndex)) {
      const data = this.chunks.get(this.key(track.initIndex, track.id));
      if (data) this.append(track, track.initIndex, null, data);
      return;
    }
    while (track.nextPosition < track.mediaIndices.length &&
        track.appended.has(track.mediaIndices[track.nextPosition]!)) {
      track.nextPosition++;
    }
    const index = track.mediaIndices[track.nextPosition];
    if (index === undefined) return;
    const data = this.chunks.get(this.key(index, track.id));
    if (data) this.append(track, index, track.nextPosition, data);
  }

  private evictOldBuffer(track: TrackBuffer): void {
    const buffer = track.sourceBuffer;
    const before = track.evictBeforeSec;
    if (!buffer || buffer.updating || before <= 0 ||
        this.mediaSource.readyState !== 'open' || typeof buffer.remove !== 'function') return;
    track.evictBeforeSec = 0;
    if (!buffer.buffered.length || buffer.buffered.start(0) >= before) return;
    try {
      buffer.remove(0, before);
      for (const chunkIndex of track.appended) {
        if ((this.knownChunkStarts.get(this.key(chunkIndex, track.id)) ?? Infinity) < before &&
            !this.manifest.chunks.some((chunk) => chunk.chunkIndex === chunkIndex)) {
          track.appended.delete(chunkIndex);
          this.knownChunkStarts.delete(this.key(chunkIndex, track.id));
        }
      }
    } catch {
      track.evictBeforeSec = before;
    }
  }

  private append(track: TrackBuffer, chunkIndex: number, position: number | null,
    data: Uint8Array): void {
    try {
      track.inFlight = { chunkIndex, position };
      track.sourceBuffer!.appendBuffer(Uint8Array.from(data));
    } catch (error) {
      track.inFlight = null;
      this.reportError(error);
    }
  }

  private key(chunkIndex: number, trackId: number): string {
    return `${chunkIndex}:${trackId}`;
  }

  private endTime(chunkIndex: number, trackId: number): number | null {
    const chunk = this.manifest.chunks.find((entry) => entry.chunkIndex === chunkIndex);
    return chunk?.parts?.find((part) => part.trackId === trackId)?.endTimeSec ??
      (chunk?.trackId === trackId ? chunk.endTimeSec : null);
  }

  private isBuffered(time: number): boolean {
    return this.tracks.every((track) => this.trackIsBuffered(track, time));
  }

  private trackIsBuffered(track: TrackBuffer, time: number): boolean {
    const ranges = track.sourceBuffer?.buffered;
    if (!ranges) return false;
    for (let index = 0; index < ranges.length; index++) {
      if (ranges.start(index) <= time + 0.2 && ranges.end(index) > time + 0.05) return true;
    }
    return false;
  }

  private tryPlay(): Promise<void> {
    if (this.playAttempt) return this.playAttempt;
    try {
      this.playAttempt = Promise.resolve(this.video.play()).catch((error: unknown) => {
        if (this.closed) return;
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          this.blocked = true;
          this.options.onBlocked?.();
        } else if (error instanceof Error && error.name === 'AbortError') {
          return;
        } else {
          this.reportError(error);
        }
      }).finally(() => { this.playAttempt = null; });
    } catch (error) {
      this.reportError(error);
      return Promise.resolve();
    }
    return this.playAttempt;
  }

  private reportError(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.video.pause();
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

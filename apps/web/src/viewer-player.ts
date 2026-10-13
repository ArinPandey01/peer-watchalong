import type { MediaManifest } from '@peer-watchalong/protocol';
import type { PlaybackDecision } from '@peer-watchalong/scheduler';

interface TrackBuffer {
  id: number;
  mimeType: string;
  initIndex: number;
  mediaIndices: number[];
  sourceBuffer: SourceBuffer | null;
  appended: Set<number>;
  nextPosition: number;
  inFlight: { chunkIndex: number; position: number | null } | null;
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
  private readonly manifest: MediaManifest;
  private readonly options: ViewerPlayerOptions;
  private readonly mediaSource: MediaSource;
  private readonly objectUrl: string;
  private readonly tracks: TrackBuffer[];
  private readonly chunks = new Map<number, Uint8Array>();
  private readonly onSourceOpen: () => void;
  private readonly onVideoError: () => void;
  private playAttempt: Promise<void> | null = null;
  private blocked = false;
  private closed = false;
  private failed = false;
  private lastDecision: PlaybackDecision | null = null;

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
        mediaIndices: manifest.chunks.filter((chunk) => chunk.trackId === track.id &&
          chunk.kind === 'media').map((chunk) => chunk.chunkIndex),
        sourceBuffer: null,
        appended: new Set<number>(),
        nextPosition: 0,
        inFlight: null,
      };
    });
    this.mediaSource = options.createMediaSource?.() ?? new MediaSource();
    this.objectUrl = (options.createObjectUrl ?? URL.createObjectURL)(this.mediaSource);
    this.onSourceOpen = () => this.openBuffers();
    this.onVideoError = () => this.reportError(new Error('The browser could not decode this video.'));
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
    this.video.addEventListener('error', this.onVideoError);
    this.video.src = this.objectUrl;
  }

  receiveChunk(chunkIndex: number, data: Uint8Array): void {
    if (this.closed || this.failed || !this.manifest.chunks[chunkIndex] ||
        this.chunks.has(chunkIndex)) return;
    this.chunks.set(chunkIndex, data);
    for (const track of this.tracks) this.pump(track);
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
      this.seekBuffers(target);
      if (!this.isBuffered(target)) {
        this.video.pause();
        return;
      }
      if (Math.abs(this.video.currentTime - target) > 0.05) this.video.currentTime = target;
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
          if (this.closed || this.failed || !written) return;
          track.appended.add(written.chunkIndex);
          if (written.position !== null && track.nextPosition === written.position) {
            track.nextPosition++;
          }
          this.options.onBuffered?.();
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
        (this.manifest.chunks[chunkIndex]?.endTimeSec ?? 0) > target);
      track.nextPosition = position < 0 ? track.mediaIndices.length : position;
      this.pump(track);
    }
  }

  private pump(track: TrackBuffer): void {
    const buffer = track.sourceBuffer;
    if (this.closed || this.failed || !buffer || buffer.updating || track.inFlight) return;
    if (!track.appended.has(track.initIndex)) {
      const data = this.chunks.get(track.initIndex);
      if (data) this.append(track, track.initIndex, null, data);
      return;
    }
    while (track.nextPosition < track.mediaIndices.length &&
        track.appended.has(track.mediaIndices[track.nextPosition]!)) {
      track.nextPosition++;
    }
    const index = track.mediaIndices[track.nextPosition];
    if (index === undefined) return;
    const data = this.chunks.get(index);
    if (data) this.append(track, index, track.nextPosition, data);
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

  private isBuffered(time: number): boolean {
    return this.tracks.every((track) => {
      const ranges = track.sourceBuffer?.buffered;
      if (!ranges) return false;
      for (let index = 0; index < ranges.length; index++) {
        if (ranges.start(index) <= time + 0.2 && ranges.end(index) > time + 0.05) {
          return true;
        }
      }
      return false;
    });
  }

  private tryPlay(): Promise<void> {
    if (this.playAttempt) return this.playAttempt;
    try {
      this.playAttempt = Promise.resolve(this.video.play()).catch((error: unknown) => {
        if (this.closed) return;
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          this.blocked = true;
          this.options.onBlocked?.();
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

import type { TrackerClient } from '@peer-watchalong/tracker-client';

type PlaybackUpdate = Parameters<TrackerClient['setPlayback']>[0];

export interface VideoSnapshot {
  paused: boolean;
  currentTime: number;
  playbackRate: number;
}

export class HostPlaybackPublisher {
  private revision = 0;
  private ready = false;

  seedRevision(revision: number): void {
    if (Number.isSafeInteger(revision) && revision >= 0) this.revision = revision;
  }

  sourceSelected(): void {
    this.ready = false;
  }

  sourceReady(video: VideoSnapshot): PlaybackUpdate | null {
    if (!validSnapshot(video)) return null;
    if (this.ready) return this.snapshot(video);
    this.revision += 1;
    this.ready = true;
    return this.snapshot(video);
  }

  playbackChanged(video: VideoSnapshot): PlaybackUpdate | null {
    return this.ready ? this.snapshot(video) : null;
  }

  seeked(video: VideoSnapshot): PlaybackUpdate | null {
    if (!this.ready || !validSnapshot(video)) return null;
    this.revision += 1;
    return this.snapshot(video);
  }

  private snapshot(video: VideoSnapshot): PlaybackUpdate | null {
    if (!validSnapshot(video)) return null;
    return {
      playing: !video.paused,
      mediaTime: video.currentTime,
      playbackRate: video.playbackRate,
      revision: this.revision,
    };
  }
}

function validSnapshot(video: VideoSnapshot): boolean {
  return Number.isFinite(video.currentTime) && video.currentTime >= 0 &&
    Number.isFinite(video.playbackRate) && video.playbackRate > 0;
}

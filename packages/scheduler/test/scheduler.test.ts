import { describe, it, expect } from 'vitest';
import { ChunkScheduler } from '../src/scheduler';
import { PlaybackState } from '../src/protocol-types';

function makeState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    playing: true,
    mediaTime: 0,
    effectiveAt: 0,
    playbackRate: 1,
    revision: 1,
    ...overrides,
  };
}

describe('ChunkScheduler', () => {
  it('requests chunks for peers the tracker says are eligible', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState());
    scheduler.updateEligibleHolders(0, ['peerA']);
    scheduler.updateEligibleHolders(1, ['peerA']);

    const { commands } = scheduler.tick(0, 0, new Set());
    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0]).toMatchObject({ type: 'REQUEST_CHUNK', chunkIndex: 0, peerId: 'peerA' });
  });

  it('does not re-request chunks already owned locally', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState());
    scheduler.updateEligibleHolders(0, ['peerA']);

    const owned = new Set([0]);
    const { commands } = scheduler.tick(0, 0, owned);
    expect(commands.find((c) => c.chunkIndex === 0)).toBeUndefined();
  });

  it('does not double-request a chunk that already has an in-flight request', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState());
    scheduler.updateEligibleHolders(0, ['peerA']);

    const first = scheduler.tick(0, 0, new Set());
    const second = scheduler.tick(1, 0, new Set());

    const chunk0RequestsFirst = first.commands.filter((c) => c.chunkIndex === 0);
    const chunk0RequestsSecond = second.commands.filter((c) => c.chunkIndex === 0);
    expect(chunk0RequestsFirst).toHaveLength(1);
    expect(chunk0RequestsSecond).toHaveLength(0);
  });

  it('skips chunks with no eligible holders reported yet', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState());
    // no updateEligibleHolders call at all

    const { commands } = scheduler.tick(0, 0, new Set());
    expect(commands).toHaveLength(0);
  });

  it('bumps the epoch and purges in-flight requests on a playback revision change', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState({ revision: 1 }));
    scheduler.updateEligibleHolders(0, ['peerA']);
    scheduler.tick(0, 0, new Set()); // chunk 0 now in-flight, tagged epoch 1

    const epochBefore = scheduler.getCurrentEpoch();
    const accepted = scheduler.updatePlaybackState(makeState({ revision: 2, mediaTime: 50000 })); // seek
    expect(accepted).toBe(true);

    const purged = scheduler.purgeForNewEpoch();

    expect(scheduler.getCurrentEpoch()).toBe(epochBefore + 1);
    expect(purged.some((c) => c.chunkIndex === 0)).toBe(true);
  });

  it('returns false from updatePlaybackState for a stale revision, without bumping epoch', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState({ revision: 5 }));
    const epochAfterFirst = scheduler.getCurrentEpoch();

    const accepted = scheduler.updatePlaybackState(makeState({ revision: 3 })); // stale
    expect(accepted).toBe(false);
    expect(scheduler.getCurrentEpoch()).toBe(epochAfterFirst);
  });

  it('ignores a stale (older-revision) playback state update', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState({ revision: 5, mediaTime: 5000 }));
    scheduler.updatePlaybackState(makeState({ revision: 3, mediaTime: 999 })); // stale

    expect(scheduler.getSyncManager().getCurrentState()?.mediaTime).toBe(5000);
  });

  it('records chunk success and frees peer capacity via onChunkReceived', () => {
    const scheduler = new ChunkScheduler({ chunkDurationSec: 1, totalChunks: 100 });
    scheduler.updatePlaybackState(makeState());
    scheduler.updateEligibleHolders(0, ['peerA']);

    const { commands } = scheduler.tick(0, 0, new Set());
    const requestId = (commands[0] as any).requestId;

    scheduler.onChunkReceived(requestId, 50);
    expect(scheduler.getRetryManager().getInFlightCount()).toBe(0);
  });
});

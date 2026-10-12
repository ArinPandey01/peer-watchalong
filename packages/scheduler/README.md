# Scheduler decisions

This package makes timing and chunk-planning decisions for a viewer. It sends
no messages and does not control the video element. The viewer app owns the
`CLOCK_SYNC_REQ`/`CLOCK_SYNC_RES` exchange and applies each playback decision.

```ts
import {
  ClockSynchronizer,
  PlaybackSynchronizer,
} from './packages/scheduler/index.ts';

const clock = new ClockSynchronizer();
const playback = new PlaybackSynchronizer(clock);

// After matching a CLOCK_SYNC_RES to a pending request:
clock.addSample(response.payload, Date.now());

// After receiving a PLAYBACK_STATE_RES or PLAYBACK_STATE_EVENT:
const update = playback.applyPlaybackState(message.payload.state);
if (update.timelineChanged) {
  // A later scheduling PR will invalidate old chunk requests here.
}

const decision = playback.evaluate(video.currentTime, Date.now());
if (decision.type === 'SEEK') video.currentTime = decision.targetMediaTimeSec;
if (decision.type !== 'WAIT_FOR_STATE' && decision.type !== 'WAIT_FOR_CLOCK') {
  video.playbackRate = decision.playbackRate;
  if (decision.playing && video.paused) void video.play();
  if (!decision.playing && !video.paused) video.pause();
}
```

`video.currentTime` and `PlaybackState.mediaTime` are seconds. Local and tracker
timestamps are Unix milliseconds. `driftMs` is positive when the viewer is
behind the canonical timeline. Under 250 ms the decision returns the canonical
playback rate; from 250 ms to 2 s it adjusts rate by 5%; at 2 s it seeks.
Paused playback seeks once drift reaches 250 ms. The caller should wait for
nearby media to be buffered before starting or seeking.

## Chunk planning and holder choice

`planNeededChunks` takes the target media time in seconds, the chunks already
cached, and an ordered segment manifest containing each chunk's actual start
and end time. The array position is the `chunkIndex` used by the data protocol.
It returns missing chunks in playback order. A chunk is urgent if its start is
within 3 seconds of the target position; the planner looks ahead 16 seconds
by default. Both windows can be configured. It returns an empty plan at or
beyond the media end. The look-ahead window limits time, not cached bytes or
active downloads.

```ts
import {
  planNeededChunks,
  rankEligibleHolders,
} from './packages/scheduler/index.ts';

const plan = planNeededChunks(targetMediaTimeSec, ownedChunks, {
  segments: segmentManifest,
});

// The viewer app obtains holderIds from a CHUNK_QUERY_RES for a planned chunk.
const ranked = rankEligibleHolders(holderIds, peerPerformance, {
  excludePeerIds: peersAlreadyTriedForThisChunk,
});
const nextPeerId = ranked[0];
```

The tracker decides which peers are eligible; ranking never adds a peer that
the tracker did not return. Peers at the per-peer request limit (3 by default)
are omitted. Remaining peers are ordered by fewer pending requests, fewer
recent failures, lower latency, then peer ID. A later request-lifecycle PR
will maintain those performance statistics and decide when to query or retry.
For larger video segments, that PR should also measure completed transfer
bytes per second and use the segment's byte length to estimate completion
time. The current ranking is a fallback until those observations exist.

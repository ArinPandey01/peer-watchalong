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
recent failures, lower observed completion time, then peer ID.

## Chunk request lifecycle

`ChunkRequestScheduler` turns a plan into actions for the viewer to execute:

- `QUERY_HOLDERS`: send `CHUNK_QUERY_REQ` to the tracker. Keep the local
  `queryToken` associated with the control message ID, and pass the token back
  with the matching `CHUNK_QUERY_RES` via `onHolders`.
- `REQUEST_CHUNK`: send a data-protocol `REQUEST` to `peerId` using the numeric
  `requestId` and `chunkIndex`. If sending fails, call `onRequestSendFailed`.
- `CHUNK_RECEIVED`: cache the validated bytes, call `markOwned`, then announce
  `CHUNK_HAVE_EVENT`. If storage fails, the next `updatePlan` can retry the
  chunk. The scheduler does not cache bytes or send messages.

Call `updatePlan(plan, playbackRevision, Date.now())` after computing a fresh
plan, and call `tick(Date.now())` periodically to drive timeouts and retries.
Pass `PAYLOAD` and `NOT_AVAILABLE` messages to `onData`, with the sending peer
ID. For a payload, validate its bytes against the media manifest **before**
passing `validPayload: true`; invalid bytes trigger a retry. A verified chunk
obtained by another path can also be passed to `markOwned` once cached.

Requests time out after 3 seconds by default. `NOT_AVAILABLE`, invalid bytes,
send failures, and timeouts try a different known holder first. Empty or
exhausted holder lists trigger a new tracker query after exponential backoff,
bounded at 8 seconds. Query replies and data responses are matched to the
current token or request ID; late responses after a timeout or playback
revision change are ignored. A new revision cancels obsolete work locally;
there is no wire-level cancel message.

The scheduler caps active requests globally (6) and per peer (3), and active
tracker queries globally (4). Its peer statistics include pending requests,
recent failures, an exponential average of complete request time, and an
exponential average of delivered bytes per second. Holder ranking currently
uses the first three statistics; a future size-aware ranking can use the
throughput estimate with each segment's byte length. The viewer must continue
to plan and tick while playback progresses; this package has no timer of its
own.

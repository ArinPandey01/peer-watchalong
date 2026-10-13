# Scheduling and Playback Sync

## Chunk scheduling

Each viewer schedules its own downloads. The tracker only reports authorized
neighbors that claim to hold a requested chunk.

Priority order:

1. the chunk containing the current target position;
2. the next chunks required to start or continue playback; and
3. later chunks in the look-ahead window.

The viewer looks ahead 16 seconds by default. MP4 audio and video segments
overlap in time, so the web app plans both tracks together rather than using
the single-timeline `planNeededChunks` helper directly.

## Request rules

- Prefer an eligible holder with fewer active requests and better recent
  response time.
- Avoid retrying the same holder when another holder is available.
- Time out a chunk request after 3 seconds by default.
- `NOT_AVAILABLE` completes the request immediately and triggers another
  holder choice.
- A timeout lowers confidence in the holder but does not prove it lacks the
  chunk.
- If no holder is known, query again with bounded backoff.
- Validate a payload before caching it or announcing `CHUNK_HAVE_EVENT`.

The viewer checks the chunk's SHA-256 digest from the current media manifest.
Claims and queries include that manifest's media ID, so claims for a replaced
video cannot be reused.

The host is the final fallback for chunks when it is an authorized holder.
Schedulers must limit concurrent requests per peer to avoid overloading one
uploader.

The current scheduler allows up to 6 active chunk requests, 4 active tracker
queries, and 3 active requests to one peer. Empty or exhausted holder results
are retried with exponential backoff, capped at 8 seconds. These are defaults,
not benchmarked tuning results.

## Seeks and cancellation

`revision` identifies the current playback timeline. It starts at `0` and
increases whenever the host seeks or changes the media. Play and pause update
the playback state without changing the revision.

When a viewer receives a higher revision, it seeks to the new target position
even if the difference is less than the normal 2-second drift threshold. The
viewer still waits for nearby chunks to be buffered before applying the seek.
Small drift at the same revision uses playback-rate correction instead.

Every chunk request records the revision it belongs to. For example, if a
viewer is downloading chunks near 10:00 at revision 3 and the host seeks to
25:00, the tracker publishes revision 4. The viewer then:

1. stops requesting chunks near 10:00;
2. ignores late revision 3 responses unless their chunks are still useful;
3. starts requesting chunks near 25:00; and
4. keeps already cached chunks because a later seek may reuse them.

## Canonical playback state

```ts
interface PlaybackState {
  playing: boolean;
  mediaTime: number;
  effectiveAt: number;
  playbackRate: number;
  revision: number;
}
```

Only the host may change this state. The tracker validates the host, timestamps
the accepted state against its clock, stores it, and distributes it.

While playing, expected media time is:

```text
mediaTime + (trackerNow - effectiveAt) / 1000 * playbackRate
```

While paused, expected media time is `mediaTime`.

## Clock and drift

Viewers periodically exchange a timestamped request and response with the
tracker. They estimate tracker time using the midpoint of the local
round-trip, prefer low-latency samples, and refresh the estimate periodically.

Initial correction policy:

- under 250 ms drift: use the host's normal playback rate;
- 250 ms–2 s drift: temporarily use 95% or 105% of the host's rate;
- at 2 s drift or more: seek to the expected position.

When paused, a 250 ms difference is enough to trigger a seek. A new playback
revision also forces a seek even if the difference is smaller. While the host
is playing, a viewer waits for a tracker clock sample before deriving the
target position.

These thresholds are tuning defaults. A viewer starts or rejoins only after it
has the required nearby chunks buffered.

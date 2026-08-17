# Scheduling and Playback Sync

## Chunk scheduling

Each viewer schedules its own downloads. The tracker only reports authorized
neighbors that claim to hold a requested chunk.

Priority order:

1. the chunk containing the current target position;
2. the next chunks required to start or continue playback; and
3. later chunks in the look-ahead window.


## Request rules

- Prefer an eligible holder with fewer active requests and better recent
  response time.
- Avoid retrying the same holder when another holder is available.
- Apply a timeout per request; start with 3 seconds and measure it.
- `NOT_AVAILABLE` completes the request immediately and triggers another
  holder choice.
- A timeout lowers confidence in the holder but does not prove it lacks the
  chunk.
- If no holder is known, query again with bounded backoff.
- Validate a payload before caching it or announcing `CHUNK_HAVE_EVENT`.

The host is the final fallback for chunks when it is an authorized holder.
Schedulers must limit concurrent requests per peer to avoid overloading one
uploader.

## Seeks and cancellation

`revision` identifies the current playback timeline. It starts at `0` and
increases whenever the host seeks or changes the media. Play and pause update
the playback state without changing the revision.

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

- under 250 ms drift: do nothing;
- 250 ms–2 s drift: temporarily adjust playback rate within `0.95–1.05`;
- over 2 s drift: seek to the expected position.

These thresholds are tuning defaults. A viewer starts or rejoins only after it
has the required nearby chunks buffered.

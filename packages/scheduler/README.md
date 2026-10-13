# Scheduler package

This package decides what a viewer should request and how it should follow the
host timeline. It does not send WebSocket or DataChannel messages, store chunk
bytes, or control a video element. The web app executes its decisions.

| API | Responsibility |
| --- | --- |
| `ClockSynchronizer` | Estimate tracker time from timestamped request/response samples |
| `PlaybackSynchronizer` | Convert host state and local video time into wait, rate-adjustment, or seek decisions |
| `planNeededChunks` | Plan a single ordered media timeline around a target time |
| `rankEligibleHolders` | Rank only the holders returned by the tracker |
| `ChunkRequestScheduler` | Track holder queries, requests, timeouts, retries, and playback revisions |

`planNeededChunks` assumes non-overlapping segments. MP4 audio and video tracks
overlap in time, so `apps/web/src/viewer-chunks.ts` builds the combined plan for
both tracks before giving it to `ChunkRequestScheduler`.

The request scheduler returns actions: `QUERY_HOLDERS`, `REQUEST_CHUNK`, and
`CHUNK_RECEIVED`. The web app sends queries and requests, validates payloads
against the manifest, caches verified bytes, and announces ownership. It calls
`updatePlan` as the target position changes and `tick` to drive timeouts. A
new playback revision abandons obsolete work; late replies to old requests
are ignored.

The clock uses Unix milliseconds; media positions use seconds. When applying
a playback decision, the web app waits for needed media to be buffered before
playing or seeking. See [scheduling and playback sync](../../docs/scheduling-and-sync.md)
for the current timing rules and thresholds.

# Project Context: Peer Watchalong — Scheduler & Sync Module

## Role & Boundaries
- Implementing: `packages/scheduler` (Scheduling & Sync).
- Do NOT rewrite or modify `packages/protocol` (PR #1) or `apps/tracker` (PR #3).
- `packages/scheduler` is a pure logic layer: no direct DOM/MSE access, no
  WebSocket/WebRTC socket handling. It only computes decisions and emits
  command objects (`RequestChunkCommand`, `CancelChunkCommand`) for the
  host app (`apps/peer`) to actually execute over `packages/webrtc`.

## Contracts to Reuse (never redefine)
- PR #1 (`packages/protocol`): `PlaybackState`, `PlaybackUpdate`,
  `CLOCK_SYNC_REQ`/`CLOCK_SYNC_RES`, `CHUNK_QUERY_RES`, binary opcodes
  (`REQUEST`, `NOT_AVAILABLE`, `PAYLOAD`) and `data-codec.ts`.
- PR #3 (`apps/tracker`): `RoomRegistry.getEligibleChunkHolders()` is the
  ONLY source of "who can I ask for this chunk" — the scheduler never
  computes topology or eligibility itself, and never reads
  `RoomRegistry` internals directly.

## Scheduler Responsibilities (this package, and only this package)
- Clock offset & RTT estimation via Cristian's algorithm, driven by
  `CLOCK_SYNC_REQ`/`CLOCK_SYNC_RES` round trips (`clock.ts`).
- Target media time calculation & drift correction — gradual rate
  adjustment vs. hard seek (`drift.ts`, `sync.ts`).
- Priority sliding window: urgent (0–3s ahead) vs. prefetch (3–12s
  ahead) vs. ignored (`priority.ts`).
- Peer holder scoring & selection among tracker-provided eligible
  holders — least-loaded, lowest-latency, fewest recent failures
  (`holder-selection.ts`).
- Request deadlines, timeouts, retry/backoff, chunk blacklisting, and
  epoch invalidation on seek (`retry.ts`, `scheduler.ts`).

## Explicitly NOT this package's job
- Topology generation (`assignViewerLayer`, `buildPeerTopologies`,
  `compactViewerLayers`) — tracker's job.
- Chunk ownership bookkeeping (`announceChunk`) — tracker's job.
- Neighbor authorization (`areNeighbors`) — tracker's job.
- Canonical playback mutation (`setPlayback`) — tracker's job; the host
  app calls this, not the scheduler.
- Opening RTCPeerConnections/DataChannels — `packages/webrtc`'s job.
- MediaSource/SourceBuffer feeding — `packages/buffer`'s job (though
  `SyncManager`'s drift output feeds directly into it).

## Current Status
`packages/scheduler` has a full first implementation: `types.ts`,
`clock.ts`, `drift.ts`, `sync.ts`, `priority.ts`, `retry.ts`,
`holder-selection.ts`, `scheduler.ts`, `index.ts`, plus unit/integration
tests for each. It imports protocol types from a local
`protocol-types.ts` shim — **replace this with a real import from
`packages/protocol` once merged into the monorepo**, and delete the
shim file and its re-export from `index.ts`.

# Room UI

The browser app currently supports creating a room, joining by code, leaving,
and showing connection and room-closure states. Video selection, playback, and
peer media transfer are planned for later changes.

From the repository root with Node.js 22.12 or newer, install dependencies with
`pnpm install`, then run
these commands in separate terminals:

```sh
pnpm --filter @peer-watchalong/tracker start
pnpm --filter @peer-watchalong/web dev
```

Open `http://localhost:5173` in a browser. The app connects to the tracker at
`ws://<browser hostname>:8080` by default, so another device on the same LAN
can open the dev server using this computer's hostname or IP address. Set
`VITE_TRACKER_URL` when the tracker runs at a different WebSocket address:

```sh
VITE_TRACKER_URL=ws://192.168.1.10:8080 pnpm --filter @peer-watchalong/web dev
```

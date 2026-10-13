import { TrackerClient } from '@peer-watchalong/tracker-client';
import { RoomController, type RoomView } from './room-controller.ts';
import { displayRoomCode } from './room-code.ts';
import { HostPlaybackPublisher } from './host-playback.ts';
import { createMediaManifest, prepareMp4 } from './mp4-segments.ts';
import { ViewerPlayer } from './viewer-player.ts';
import { randomUuid } from './random-id.ts';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root was not found');

const trackerUrl = import.meta.env.VITE_TRACKER_URL ||
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8080`;
const controller = new RoomController(() => new TrackerClient(trackerUrl));
let hostVideoUrl: string | null = null;
let hostVideoElement: HTMLVideoElement | null = null;
let hostPlayback = new HostPlaybackPublisher();
let mediaPreparation: AbortController | null = null;
let viewerPlayer: ViewerPlayer | null = null;
let viewerMediaId: string | null = null;
let viewerSyncTimer: ReturnType<typeof setInterval> | null = null;

controller.subscribe((state) => {
  clearViewerPlayer();
  if (state.screen !== 'room' || state.role !== 'host') {
    clearHostVideo();
    hostPlayback = new HostPlaybackPublisher();
  }
  app.innerHTML = page(state);
  bindActions(state);
  syncViewerPlayer();
  renderPlaybackStatus();
  renderMediaStatus();
  renderChunkProgress();
  renderPeerStatus();
});
controller.subscribePlayback(renderPlaybackStatus);
controller.subscribeMedia(() => {
  syncViewerPlayer();
  renderMediaStatus();
});
controller.subscribeChunkProgress(renderChunkProgress);
controller.subscribePeerCount(renderPeerStatus);
controller.subscribeVerifiedChunks((chunkIndex, data) => viewerPlayer?.receiveChunk(chunkIndex, data));

function page(state: RoomView): string {
  return `
    <div class="site-shell">
      ${state.screen === 'home' ? '' : '<header class="site-header"><span class="brand">Peer Watchalong</span></header>'}
      <main class="main-content">
        ${state.screen === 'home' ? home(state) : state.screen === 'connecting'
          ? connecting(state) : state.screen === 'ended' ? ended(state) : room(state)}
      </main>
    </div>
  `;
}

function home(state: Extract<RoomView, { screen: 'home' }>): string {
  return `
    <section class="home-intro" aria-labelledby="home-title">
      <h1 id="home-title">Peer Watchalong</h1>
      <p>Create a room or join one with a code.</p>
    </section>
    <section class="entry-grid" aria-label="Room options">
      <div class="entry-card">
        <h2>Host</h2>
        <p>Create a room and share its code.</p>
        <button class="button button-primary" id="create-room" type="button">Create room</button>
      </div>
      <div class="entry-card">
        <h2>Viewer</h2>
        <p>Enter the code your host shared.</p>
        <form id="join-form" novalidate>
          <label for="room-code">Room code</label>
          <div class="join-input-row">
            <input id="room-code" name="room-code" type="text" inputmode="text"
              maxlength="9" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH"
              value="${escapeHtml(state.enteredCode ?? '')}" />
            <button class="button button-secondary" type="submit">Join room</button>
          </div>
        </form>
      </div>
    </section>
    ${state.error ? `<div class="notice notice-error" role="alert">${escapeHtml(state.error)}</div>` : ''}
    <section class="how-to" aria-labelledby="how-to-title">
      <h2 id="how-to-title">How to use</h2>
      <ol>
        <li>Host creates a room.</li>
        <li>Host shares the room code.</li>
        <li>Viewers enter the code to join.</li>
      </ol>
    </section>
  `;
}

function connecting(state: Extract<RoomView, { screen: 'connecting' }>): string {
  return `
    <section class="state-panel" aria-live="polite">
      <div class="state-symbol loading-symbol" aria-hidden="true"></div>
      <div class="eyebrow">${state.role === 'host' ? 'CREATING ROOM' : 'JOINING ROOM'}</div>
      <h1>${state.role === 'host' ? 'Making space for everyone.' : 'Joining the room.'}</h1>
      <p>Connecting to the tracker and getting your room ready.</p>
      <div class="state-code">${displayRoomCode(state.code)}</div>
      <button class="text-button" id="cancel" type="button">Cancel</button>
    </section>
  `;
}

function room(state: Extract<RoomView, { screen: 'room' }>): string {
  const isHost = state.role === 'host';
  return `
    <section class="room-header" aria-label="Room details">
      <div class="room-heading">
        <div class="eyebrow">${isHost ? 'YOUR ROOM IS LIVE' : 'YOU HAVE JOINED THE ROOM'}</div>
        <h1>${isHost ? 'The room is yours.' : 'You’re in.'}</h1>
        <p>${isHost ? 'Share the code and let everyone settle in.' : 'Stay here. The host will start the watchalong.'}</p>
      </div>
      <div class="room-actions">
        <span class="role-badge">${isHost ? 'HOST' : 'VIEWER'}</span>
        <button class="button button-quiet" id="leave" type="button">Leave room</button>
      </div>
    </section>
    <section class="room-code-panel" aria-label="Room code">
      <div><span class="overline">ROOM CODE</span><strong id="room-code-value">${displayRoomCode(state.code)}</strong></div>
      <button class="button button-copy" id="copy-code" type="button">${iconCopy()} Copy code</button>
      <span id="copy-feedback" class="copy-feedback" role="status" aria-live="polite"></span>
    </section>
    ${state.connection === 'disconnected' ? `
      <div class="notice notice-error disconnection" role="alert">
        <span>Connection lost. The host may still be here.</span>
        <button class="button button-secondary" id="retry" type="button">Try again</button>
      </div>
    ` : ''}
    ${isHost ? `
      <div class="media-toolbar">
        <input id="video-file" class="visually-hidden" type="file" accept="video/mp4,.mp4" />
        <label class="button button-secondary" for="video-file">Choose video</label>
        <span id="video-name">No video selected</span>
        <span id="video-feedback" role="alert"></span>
      </div>
    ` : ''}
    <section class="player-shell" aria-label="Video player">
      ${isHost ? '<video id="host-video" class="host-video" controls playsinline hidden></video>' : ''}
      ${isHost ? '' : '<video id="viewer-video" class="host-video" playsinline hidden></video><button class="button button-primary viewer-play-button" id="viewer-play" type="button" hidden>Start watching</button><div id="viewer-feedback" class="viewer-feedback" role="alert" hidden></div>'}
      <div id="player-placeholder" class="player-content">
        <div class="player-emblem" aria-hidden="true">${iconPlay()}</div>
        <h2 id="player-heading">${isHost ? 'Choose a video to play.' : 'Waiting for video.'}</h2>
        <p id="player-description">${isHost ? 'Select a file from your device using the button above.' : 'The host has not selected a video yet.'}</p>
      </div>
    </section>
    <div class="room-status" role="status">
      <span><span class="status-dot ${state.connection === 'connected' ? '' : 'status-dot-off'}"></span>
        ${state.connection === 'connected' ? 'Connected to room' : 'Disconnected'}</span>
      <span id="peer-status"></span>
      ${isHost ? '' : '<span id="chunk-status"></span>'}
      <span id="playback-status"></span>
    </div>
  `;
}

function ended(state: Extract<RoomView, { screen: 'ended' }>): string {
  return `
    <section class="state-panel">
      <div class="state-symbol end-symbol" aria-hidden="true">×</div>
      <div class="eyebrow">ROOM ${displayRoomCode(state.code)}</div>
      <h1>Room ended.</h1>
      <p>${escapeHtml(state.reason)}</p>
      <button class="button button-primary" id="back-home" type="button">Back to home <span aria-hidden="true">→</span></button>
    </section>
  `;
}

function bindActions(state: RoomView): void {
  if (state.screen === 'home') {
    document.querySelector('#create-room')?.addEventListener('click', () => {
      void controller.createRoom();
    });
    document.querySelector('#join-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.querySelector<HTMLInputElement>('#room-code');
      void controller.joinRoom(input?.value ?? '');
    });
  } else if (state.screen === 'connecting') {
    document.querySelector('#cancel')?.addEventListener('click', () => controller.leave());
  } else if (state.screen === 'ended') {
    document.querySelector('#back-home')?.addEventListener('click', () => controller.leave());
  } else {
    document.querySelector('#leave')?.addEventListener('click', () => controller.leave());
    document.querySelector('#retry')?.addEventListener('click', () => {
      void controller.retry();
    });
    document.querySelector('#copy-code')?.addEventListener('click', () => {
      void copyCode(state.code);
    });
    if (state.role === 'host') bindHostVideo();
    else bindViewerVideo();
  }
}

function bindViewerVideo(): void {
  document.querySelector('#viewer-play')?.addEventListener('click', () => {
    void viewerPlayer?.startWatching();
  });
  document.querySelector('#viewer-video')?.addEventListener('playing', () => {
    const button = document.querySelector<HTMLElement>('#viewer-play');
    if (button) button.hidden = true;
  });
}

function syncViewerPlayer(): void {
  const room = controller.current;
  const manifest = controller.currentMedia;
  if (room.screen !== 'room' || room.role !== 'viewer' || !manifest) {
    clearViewerPlayer();
    return;
  }
  if (viewerPlayer && viewerMediaId === manifest.mediaId) return;
  clearViewerPlayer();
  const video = document.querySelector<HTMLVideoElement>('#viewer-video');
  if (!video) return;
  const feedback = document.querySelector<HTMLElement>('#viewer-feedback');
  try {
    const player = new ViewerPlayer(video, manifest, {
      onBuffered: syncViewerPlayback,
      onBlocked: () => {
        const button = document.querySelector<HTMLElement>('#viewer-play');
        if (button) button.hidden = false;
      },
      onError: (error) => {
        if (feedback) {
          feedback.textContent = error.message;
          feedback.hidden = false;
        }
      },
    });
    viewerPlayer = player;
    viewerMediaId = manifest.mediaId;
    video.hidden = false;
    const placeholder = document.querySelector<HTMLElement>('#player-placeholder');
    if (placeholder) placeholder.hidden = true;
    for (const chunk of manifest.chunks) {
      const data = controller.readCachedChunk(chunk.chunkIndex);
      if (data) player.receiveChunk(chunk.chunkIndex, data);
    }
    viewerSyncTimer = setInterval(syncViewerPlayback, 250);
    syncViewerPlayback();
  } catch (error) {
    if (feedback) {
      feedback.textContent = error instanceof Error ? error.message : String(error);
      feedback.hidden = false;
    }
  }
}

function syncViewerPlayback(): void {
  const video = document.querySelector<HTMLVideoElement>('#viewer-video');
  if (!viewerPlayer || !video) return;
  viewerPlayer.applyDecision(controller.evaluateViewerPlayback(video.currentTime));
}

function clearViewerPlayer(): void {
  if (viewerSyncTimer) clearInterval(viewerSyncTimer);
  viewerSyncTimer = null;
  viewerPlayer?.close();
  viewerPlayer = null;
  viewerMediaId = null;
  const video = document.querySelector<HTMLVideoElement>('#viewer-video');
  if (!video) return;
  video.hidden = true;
  const placeholder = document.querySelector<HTMLElement>('#player-placeholder');
  if (placeholder) placeholder.hidden = false;
  const button = document.querySelector<HTMLElement>('#viewer-play');
  if (button) button.hidden = true;
  const feedback = document.querySelector<HTMLElement>('#viewer-feedback');
  if (feedback) {
    feedback.textContent = '';
    feedback.hidden = true;
  }
}

function bindHostVideo(): void {
  const input = document.querySelector<HTMLInputElement>('#video-file');
  const video = document.querySelector<HTMLVideoElement>('#host-video');
  if (!input || !video) return;
  hostVideoElement = video;

  video.addEventListener('loadedmetadata', () => {
    publishHostPlayback(hostPlayback.sourceReady(video));
  });
  video.addEventListener('play', () => {
    publishHostPlayback(hostPlayback.playbackChanged(video));
  });
  video.addEventListener('pause', () => {
    publishHostPlayback(hostPlayback.playbackChanged(video));
  });
  video.addEventListener('seeked', () => {
    publishHostPlayback(hostPlayback.seeked(video));
  });
  video.addEventListener('ratechange', () => {
    publishHostPlayback(hostPlayback.playbackChanged(video));
  });
  video.addEventListener('ended', () => {
    publishHostPlayback(hostPlayback.playbackChanged(video));
  });

  video.addEventListener('error', () => {
    const feedback = document.querySelector<HTMLElement>('#video-feedback');
    if (feedback && hostVideoUrl && video.currentSrc === hostVideoUrl) {
      feedback.textContent = 'This video format cannot be played in this browser.';
    }
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    if (hostVideoUrl) {
      publishHostPlayback(hostPlayback.playbackChanged({
        paused: true,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      }));
    }
    hostPlayback.sourceSelected();
    clearHostVideo();
    void controller.publishMedia(null).catch(() => {});
    hostVideoElement = video;
    const feedback = document.querySelector<HTMLElement>('#video-feedback');
    if (feedback) feedback.textContent = '';
    hostVideoUrl = URL.createObjectURL(file);
    video.src = hostVideoUrl;
    video.hidden = false;
    const placeholder = document.querySelector<HTMLElement>('#player-placeholder');
    if (placeholder) placeholder.hidden = true;
    const name = document.querySelector<HTMLElement>('#video-name');
    if (name) name.textContent = file.name;
    input.value = '';
    const preparation = new AbortController();
    mediaPreparation = preparation;
    if (feedback) feedback.textContent = 'Preparing MP4 segments…';
    void prepareMp4(file, { signal: preparation.signal }).then(async (media) => {
      if (preparation.signal.aborted || hostVideoElement !== video) return;
      const manifest = await createMediaManifest(media, randomUuid(), preparation.signal);
      if (preparation.signal.aborted || hostVideoElement !== video) return;
      controller.setChunkReader(media.readChunk);
      if (feedback) feedback.textContent = 'Sharing video details with the room…';
      await controller.publishMedia(manifest);
      if (preparation.signal.aborted || hostVideoElement !== video) return;
      if (feedback) feedback.textContent = `${media.chunks.length} segments prepared.`;
    }).catch((error: unknown) => {
      if (preparation.signal.aborted || hostVideoElement !== video) return;
      controller.setChunkReader(() => null);
      if (feedback) feedback.textContent = error instanceof Error
        ? error.message : 'Could not prepare this MP4 for sharing.';
    });
  });
}

function publishHostPlayback(update: ReturnType<HostPlaybackPublisher['playbackChanged']>): void {
  if (!update) return;
  const feedback = document.querySelector<HTMLElement>('#video-feedback');
  if (!controller.publishPlayback(update) && feedback) {
    feedback.textContent = 'Could not share playback status with the room.';
  }
}

function renderPlaybackStatus(): void {
  const status = document.querySelector<HTMLElement>('#playback-status');
  if (!status) return;
  const room = controller.current;
  const playback = controller.currentPlayback;
  if (room.screen !== 'room') return;
  if (room.role === 'host') {
    status.textContent = playback && playback.revision > 0
      ? 'Playback status shared with room'
      : 'Video plays on this device';
  } else if (!playback || playback.revision === 0) {
    status.textContent = 'Waiting for host playback';
  } else {
    status.textContent = playback.playing
      ? 'Host is playing'
      : `Host paused at ${formatTime(playback.mediaTime)}`;
  }
}

function renderMediaStatus(): void {
  const room = controller.current;
  if (room.screen !== 'room' || room.role !== 'viewer') return;
  const heading = document.querySelector<HTMLElement>('#player-heading');
  const description = document.querySelector<HTMLElement>('#player-description');
  if (heading) heading.textContent = controller.currentMedia ? 'Loading video.' : 'Waiting for video.';
  if (description) description.textContent = controller.currentMedia
    ? 'Downloading the parts needed for playback.'
    : 'The host has not selected a video yet.';
}

function renderChunkProgress(): void {
  const status = document.querySelector<HTMLElement>('#chunk-status');
  if (!status) return;
  const progress = controller.currentChunkProgress;
  status.textContent = progress.total > 0
    ? `${progress.downloaded} of ${progress.total} segments received`
    : '';
}

function renderPeerStatus(): void {
  const status = document.querySelector<HTMLElement>('#peer-status');
  if (!status) return;
  const count = controller.connectedPeerCount;
  status.textContent = `${count} ${count === 1 ? 'peer' : 'peers'} connected`;
}

function formatTime(seconds: number): string {
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function clearHostVideo(): void {
  mediaPreparation?.abort();
  mediaPreparation = null;
  controller.setChunkReader(() => null);
  if (hostVideoElement) {
    hostVideoElement.pause();
    hostVideoElement.removeAttribute('src');
    hostVideoElement.load();
    hostVideoElement = null;
  }
  if (hostVideoUrl) {
    URL.revokeObjectURL(hostVideoUrl);
    hostVideoUrl = null;
  }
}

async function copyCode(code: string): Promise<void> {
  const feedback = document.querySelector<HTMLElement>('#copy-feedback');
  try {
    await navigator.clipboard.writeText(code);
    if (feedback) feedback.textContent = 'Copied';
  } catch {
    const codeText = document.querySelector<HTMLElement>('#room-code-value');
    if (!codeText) return;
    const range = document.createRange();
    range.selectNodeContents(codeText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (feedback) feedback.textContent = 'Selected. Press Ctrl+C to copy.';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function iconCopy(): string {
  return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>';
}

function iconPlay(): string {
  return '<svg viewBox="0 0 38 38" fill="none" aria-hidden="true"><path d="m14 9 17 10-17 10V9Z" fill="currentColor"/></svg>';
}

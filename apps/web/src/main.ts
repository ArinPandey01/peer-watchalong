import { TrackerClient } from '@peer-watchalong/tracker-client';
import { RoomController, type RoomView } from './room-controller.ts';
import { displayRoomCode } from './room-code.ts';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root was not found');

const trackerUrl = import.meta.env.VITE_TRACKER_URL ||
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8080`;
const controller = new RoomController(() => new TrackerClient(trackerUrl));

controller.subscribe((state) => {
  app.innerHTML = page(state);
  bindActions(state);
});

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
    <section class="player-shell" aria-label="Video player">
      <div class="player-grid" aria-hidden="true"></div>
      <div class="player-content">
        <div class="player-emblem" aria-hidden="true">${iconPlay()}</div>
        <h2>${isHost ? 'Ready when you are.' : 'Waiting for the host.'}</h2>
        <p>${isHost ? 'Your room is open. Anyone with the code can join.' : 'The video will appear here when the host starts watching.'}</p>
      </div>
      <div class="player-corner player-corner-top">${isHost ? 'HOST VIEW' : 'VIEWER VIEW'}</div>
      <div class="player-corner player-corner-bottom">PEER WATCHALONG / ROOM ${displayRoomCode(state.code)}</div>
    </section>
    <div class="room-status" role="status">
      <span><span class="status-dot ${state.connection === 'connected' ? '' : 'status-dot-off'}"></span>
        ${state.connection === 'connected' ? 'Connected to room' : 'Disconnected'}</span>
      <span>${isHost ? 'You control this room' : 'Following the host'}</span>
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

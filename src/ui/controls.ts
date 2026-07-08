// FR-13 Live/Paused indicator + Return to Live, FR-1.4 map style toggle,
// NFR-2.5 offline indicator, and the tzNotice/snapNotice toast chips.
import type { Store } from '../store';
import type { UrlSync } from '../url';
import type { AppState, MapStyleMode } from '../types';
import type { UiComponent } from './shared';
import { effectiveTzId } from './shared';
import { formatClock } from '../time';

function noticeChip(store: Store, key: 'tzNotice' | 'snapNotice'): { el: HTMLElement; span: HTMLSpanElement } {
  const el = document.createElement('div');
  el.className = `notice notice-${key}`;
  el.setAttribute('role', 'status');
  el.hidden = true;
  const span = document.createElement('span');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'notice-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.addEventListener('click', () => {
    store.dispatch({ type: 'NOTICE', key, message: null, origin: 'system' });
  });
  el.append(span, closeBtn);
  return { el, span };
}

export function mountControls(container: HTMLElement, store: Store, urlSync: UrlSync): UiComponent {
  const wrap = document.createElement('div');
  wrap.className = 'controls';

  // FR-13.5
  const modeChip = document.createElement('div');
  modeChip.className = 'mode-chip';
  const liveDot = document.createElement('span');
  liveDot.className = 'live-dot';
  const modeText = document.createElement('span');
  modeChip.append(liveDot, modeText);

  // FR-13.3
  const returnBtn = document.createElement('button');
  returnBtn.type = 'button';
  returnBtn.className = 'return-live-btn';
  returnBtn.textContent = 'Return to Live';
  returnBtn.hidden = true;
  returnBtn.addEventListener('click', () => {
    store.dispatch({ type: 'SET_MODE', mode: 'live', origin: 'system' });
    urlSync.commit();
  });

  // FR-1.4.1/1.4.2
  const styleToggle = document.createElement('div');
  styleToggle.className = 'style-toggle';
  styleToggle.setAttribute('role', 'group');
  styleToggle.setAttribute('aria-label', 'Map style mode');
  const appTimeBtn = document.createElement('button');
  appTimeBtn.type = 'button';
  appTimeBtn.textContent = 'App Time';
  const realTimeBtn = document.createElement('button');
  realTimeBtn.type = 'button';
  realTimeBtn.textContent = 'Real Time';
  styleToggle.append(appTimeBtn, realTimeBtn);

  function setStyle(mode: MapStyleMode) {
    store.dispatch({ type: 'SET_MAP_STYLE_MODE', mode, explicit: true, origin: 'system' });
    urlSync.commit();
  }
  appTimeBtn.addEventListener('click', () => setStyle('app-time'));
  realTimeBtn.addEventListener('click', () => setStyle('real-time'));

  // NFR-2.5
  const offlineChip = document.createElement('div');
  offlineChip.className = 'offline-chip';
  offlineChip.textContent = 'Offline — showing cached data';
  offlineChip.hidden = true;
  offlineChip.setAttribute('role', 'status');

  const notices = document.createElement('div');
  notices.className = 'notices';
  const tzNotice = noticeChip(store, 'tzNotice');
  const snapNotice = noticeChip(store, 'snapNotice');
  notices.append(tzNotice.el, snapNotice.el);

  wrap.append(modeChip, returnBtn, styleToggle, offlineChip, notices);
  container.appendChild(wrap);

  function setNotice(n: { el: HTMLElement; span: HTMLSpanElement }, message: string | null) {
    if (message) {
      n.span.textContent = message;
      n.el.hidden = false;
    } else {
      n.el.hidden = true;
    }
  }

  function render(state: AppState) {
    const tzId = effectiveTzId(state);
    if (state.mode === 'live') {
      modeChip.classList.add('live');
      modeText.textContent = 'LIVE';
      returnBtn.hidden = true;
    } else {
      modeChip.classList.remove('live');
      modeText.textContent = `Paused at ${formatClock(state.time.epochMs, tzId)}`;
      returnBtn.hidden = false;
    }

    appTimeBtn.classList.toggle('active', state.mapStyle.mode === 'app-time');
    appTimeBtn.setAttribute('aria-pressed', String(state.mapStyle.mode === 'app-time'));
    realTimeBtn.classList.toggle('active', state.mapStyle.mode === 'real-time');
    realTimeBtn.setAttribute('aria-pressed', String(state.mapStyle.mode === 'real-time'));

    offlineChip.hidden = state.net.online;

    setNotice(tzNotice, state.ui.tzNotice);
    setNotice(snapNotice, state.ui.snapNotice);
  }

  return {
    render,
    destroy() {
      // Only DOM-scoped listeners on nodes we own; nothing external to release.
    },
  };
}

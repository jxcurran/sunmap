// DOM UI subsystem entry point. Wires the individual subsystems (search,
// timeline, panels, datepicker, controls) to the shared store and owns the
// cross-cutting concerns that don't belong to any one of them: the Live-mode
// clock ticker (FR-13.6), the offline listener (NFR-2.5), and a defensive
// initial timezone resolution (see comment below).
import type { Store } from '../store';
import type { UrlSync } from '../url';
import type { AppState } from '../types';
import { commitLocation } from '../locationCommit';
import { onNetChange } from '../services/net';
import { mountSearch } from './search';
import { mountTimeline } from './timeline';
import { mountPanels } from './panels';
import { mountDatePicker } from './datepicker';
import { mountControls } from './controls';

export function createUi(root: HTMLElement, store: Store, urlSync: UrlSync): { destroy(): void } {
  root.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'ui-shell';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  const searchMount = document.createElement('div');
  searchMount.className = 'search-mount';
  const controlsMount = document.createElement('div');
  controlsMount.className = 'controls-mount';
  topbar.append(searchMount, controlsMount);

  const panelsMount = document.createElement('div');
  panelsMount.className = 'panels-mount';

  const bottomDock = document.createElement('div');
  bottomDock.className = 'bottom-dock';
  const datepickerMount = document.createElement('div');
  datepickerMount.className = 'datepicker-mount';
  const timelineMount = document.createElement('div');
  timelineMount.className = 'timeline-mount';
  bottomDock.append(datepickerMount, timelineMount);

  shell.append(topbar, panelsMount, bottomDock);
  root.appendChild(shell);

  const search = mountSearch(searchMount, store, urlSync);
  const controls = mountControls(controlsMount, store, urlSync);
  const panels = mountPanels(panelsMount, store);
  const datepicker = mountDatePicker(datepickerMount, store, urlSync);
  const timeline = mountTimeline(timelineMount, store, urlSync);

  const components = [search, controls, panels, datepicker, timeline];

  // Defensive tz bootstrap: nothing in the frozen core resolves tz for the
  // initial default location on its own, and HYDRATE's reducer always resets
  // tz to 'pending' regardless of whether the URL carried a location — every
  // time.ts helper (and therefore every component above) needs a real tz id.
  // commitLocation is idempotent here (same lat/lng/source) and a no-op if
  // something else has already resolved it by the time we mount.
  if (store.getState().tz.status === 'pending') {
    const loc = store.getState().location;
    commitLocation(store, { lat: loc.lat, lng: loc.lng, label: loc.label, source: loc.source, origin: 'system' });
  }

  // FR-13.6: we own the Live-mode ticking timer — nothing else in the codebase
  // ticks the clock. 1Hz is sufficient (sub-second updates are unnecessary).
  // FR-13.7 midnight rollover falls out for free: every tick re-derives the
  // local date from the fresh epoch, so date-dependent rendering (solar day,
  // timeline bounds) just silently rolls over on the render right after
  // midnight — no dedicated rollover action/timer needed.
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  function syncTicking(state: AppState) {
    if (state.mode === 'live' && tickInterval === null) {
      tickInterval = setInterval(() => {
        store.dispatch({ type: 'SET_TIME', epochMs: Date.now(), origin: 'clock' });
      }, 1000);
    } else if (state.mode !== 'live' && tickInterval !== null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function renderAll(state: AppState) {
    for (const c of components) c.render(state);
  }

  // Single central subscription: re-render is a pure reflection of state, never
  // a re-dispatch, so this is safe regardless of which surface caused the
  // action (echo suppression, Technical Architecture §2.4).
  const unsubscribe = store.subscribe((state) => {
    syncTicking(state);
    renderAll(state);
  });

  syncTicking(store.getState());
  renderAll(store.getState());

  const stopNet = onNetChange((online) => {
    store.dispatch({ type: 'SET_NET', online, origin: 'system' });
  });

  // NFR-1.8-adjacent: resync the live clock immediately on tab foregrounding
  // rather than waiting up to a second, so a returning user never sees stale
  // "live" data even briefly.
  function onVisibility() {
    if (document.visibilityState === 'visible' && store.getState().mode === 'live') {
      store.dispatch({ type: 'SET_TIME', epochMs: Date.now(), origin: 'clock' });
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy() {
      unsubscribe();
      if (tickInterval !== null) clearInterval(tickInterval);
      stopNet();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const c of components) c.destroy();
      root.innerHTML = '';
    },
  };
}

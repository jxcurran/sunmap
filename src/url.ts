// URL sync adapter — Technical Architecture §2.5. Write-only during a session,
// read-only exactly once at hydration; popstate re-validates through the same
// NFR-4.1 gate since the URL is untrusted input every time.
import type { Action, AppState, HydratablePatch, Mode } from './types';
import { throttle } from './util';

const MIN_EPOCH = Date.UTC(1900, 0, 1);
const MAX_EPOCH = Date.UTC(2100, 11, 31, 23, 59, 59);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface HydrationResult {
  patch: Partial<HydratablePatch>;
  mode: Mode;
  rejected: string[];
}

// NFR-4.1/4.2: each field validated independently; failures are individually
// discarded and replaced by the default (i.e. simply omitted from the patch),
// never thrown — malformed state can never crash hydration.
export function parseUrlState(search: string): HydrationResult {
  const params = new URLSearchParams(search);
  const rejected: string[] = [];
  const patch: Partial<HydratablePatch> = {};

  const latRaw = params.get('lat');
  const lngRaw = params.get('lng');
  if (latRaw !== null || lngRaw !== null) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (latRaw !== null && lngRaw !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
      patch.location = { lat: clamp(lat, -90, 90), lng: clamp(lng, -180, 180), label: null, source: 'url' };
    } else {
      rejected.push('location');
    }
  }

  let mode: Mode = 'live'; // FR-13.4: no timestamp => Live
  const tRaw = params.get('t');
  if (tRaw !== null) {
    const t = Number(tRaw);
    if (Number.isFinite(t) && t >= MIN_EPOCH && t <= MAX_EPOCH) {
      patch.time = { epochMs: t };
      mode = 'paused'; // FR-8.2.1/13.4: timestamp present => frozen Paused snapshot
    } else {
      rejected.push('time');
    }
  }

  const styleRaw = params.get('style');
  if (styleRaw !== null) {
    if (styleRaw === 'app-time' || styleRaw === 'real-time') {
      patch.mapStyle = { mode: styleRaw, explicit: true };
    } else {
      rejected.push('style');
    }
  }

  return { patch, mode, rejected };
}

function serialize(state: AppState): string {
  const params = new URLSearchParams();
  params.set('lat', state.location.lat.toFixed(5));
  params.set('lng', state.location.lng.toFixed(5));
  if (state.mode === 'paused') params.set('t', String(Math.round(state.time.epochMs)));
  if (state.mapStyle.explicit) params.set('style', state.mapStyle.mode);
  const qs = params.toString();
  return qs ? `?${qs}` : location.pathname;
}

export interface UrlSync {
  /** Subscribe this to the store; call on every dispatched action. */
  onAction(state: AppState, action: Action): void;
  /** Discrete commit point (dragEnd, location commit, calendar pick, style toggle): pushState. */
  commit(): void;
}

export function createUrlSync(getState: () => AppState): UrlSync {
  const replace = throttle(() => {
    history.replaceState(null, '', serialize(getState()));
  }, 250); // §2.5: throttled to <=4Hz

  return {
    onAction(_state, action) {
      if (action.type === 'HYDRATE' || action.origin === 'clock') return; // FR-13.6/13.7: never write history
      replace();
    },
    commit() {
      history.pushState(null, '', serialize(getState()));
    },
  };
}

// Canonical state schema — Technical Architecture §2.1.
// `camera` and `location` are deliberately separate: panning must never change
// timezone context (FR-2.6). `date view` is intentionally absent — it is always
// derived from time.epochMs + tz.id (Technical Architecture §3), never stored.

export type LocationSource = 'search' | 'geoloc' | 'pin' | 'url' | 'default';
export type TzStatus = 'resolved' | 'approx' | 'pending';
export type MapStyleMode = 'app-time' | 'real-time';
export type Mode = 'live' | 'paused';
export type QualityTier = 'Q0' | 'Q1' | 'Q2' | 'Q3';

// Every dispatched action is tagged with its origin (Technical Architecture §2.4).
// Subscribers dispatch only from direct user-input handlers and must ignore
// store-driven updates for dispatch purposes — this is what closes the
// map<->timeline echo loop. 'clock' never pauses Live mode or writes the URL.
export type Origin =
  | 'timeline'
  | 'map'
  | 'keyboard'
  | 'clock'
  | 'url'
  | 'system'
  | 'search'
  | 'calendar';

// Origins that constitute "user manipulation of time" and disengage Live mode (FR-13.2).
export const PAUSING_ORIGINS: ReadonlySet<Origin> = new Set([
  'timeline',
  'map',
  'keyboard',
  'calendar',
]);

export interface Camera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface AppState {
  location: { lat: number; lng: number; label: string | null; source: LocationSource };
  tz: { id: string | null; status: TzStatus; approxOffsetHours: number | null };
  time: { epochMs: number };
  mode: Mode;
  mapStyle: { mode: MapStyleMode; explicit: boolean }; // FR-1.4/1.4.1
  camera: Camera;
  quality: QualityTier; // NFR-1.7
  net: { online: boolean };
  ui: {
    advancedOpen: boolean; // FR-10.2
    searchStatus: 'idle' | 'loading' | 'error';
    searchError: string | null; // FR-5.2.1
    tzNotice: string | null; // FR-2.5.1 non-blocking alert
    snapNotice: string | null; // FR-7.3.2 DST snap indication
  };
}

export type Action =
  | { type: 'SET_TIME'; epochMs: number; origin: Origin }
  | {
      type: 'COMMIT_LOCATION';
      lat: number;
      lng: number;
      label: string | null;
      source: LocationSource;
      origin: Origin;
    }
  | { type: 'TZ_PENDING'; origin: Origin }
  | { type: 'TZ_RESOLVED'; id: string; origin: Origin }
  | { type: 'TZ_APPROX'; approxOffsetHours: number; origin: Origin }
  | { type: 'SET_MODE'; mode: Mode; origin: Origin }
  | { type: 'SET_MAP_STYLE_MODE'; mode: MapStyleMode; explicit: boolean; origin: Origin }
  | { type: 'SET_CAMERA'; camera: Partial<Camera>; origin: Origin }
  | { type: 'SET_QUALITY'; tier: QualityTier; origin: Origin }
  | { type: 'SET_NET'; online: boolean; origin: Origin }
  | {
      type: 'SEARCH_STATUS';
      status: AppState['ui']['searchStatus'];
      error: string | null;
      origin: Origin;
    }
  | { type: 'NOTICE'; key: 'tzNotice' | 'snapNotice'; message: string | null; origin: Origin }
  | { type: 'SET_ADVANCED_OPEN'; open: boolean; origin: Origin }
  | { type: 'HYDRATE'; patch: Partial<HydratablePatch>; mode: Mode; origin: 'url' };

// Subset of state that URL hydration is permitted to set (NFR-4.1 validated beforehand).
export interface HydratablePatch {
  location: AppState['location'];
  time: AppState['time'];
  mapStyle: AppState['mapStyle'];
}

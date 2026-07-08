import { PAUSING_ORIGINS, type Action, type AppState } from './types';

// FR-5.1.1 fallback: Prime Meridian, London.
const DEFAULT_LOCATION: AppState['location'] = {
  lat: 51.4779,
  lng: -0.0015,
  label: 'Greenwich, London',
  source: 'default',
};

export function initialState(): AppState {
  return {
    location: DEFAULT_LOCATION,
    tz: { id: null, status: 'pending', approxOffsetHours: null },
    time: { epochMs: Date.now() },
    mode: 'live', // FR-13.1
    mapStyle: { mode: 'app-time', explicit: false },
    camera: { center: [DEFAULT_LOCATION.lng, DEFAULT_LOCATION.lat], zoom: 12, pitch: 45, bearing: 0 },
    quality: 'Q0',
    net: { online: navigator.onLine },
    ui: { advancedOpen: false, searchStatus: 'idle', searchError: null, tzNotice: null, snapNotice: null },
  };
}

// Reducer is a pure function: state in, action in, state out. No side effects,
// no async — those live in services/* and are dispatched back in as actions
// (Technical Architecture §4.3: the store sees exactly one terminal action per intent).
function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_TIME': {
      const mode = PAUSING_ORIGINS.has(action.origin) ? 'paused' : state.mode; // FR-13.2
      return { ...state, time: { epochMs: action.epochMs }, mode };
    }
    case 'COMMIT_LOCATION':
      return {
        ...state,
        location: { lat: action.lat, lng: action.lng, label: action.label, source: action.source },
        tz: { id: null, status: 'pending', approxOffsetHours: null },
        ui: { ...state.ui, tzNotice: null },
      };
    case 'TZ_PENDING':
      return { ...state, tz: { ...state.tz, status: 'pending' } };
    case 'TZ_RESOLVED':
      return { ...state, tz: { id: action.id, status: 'resolved', approxOffsetHours: null } };
    case 'TZ_APPROX':
      return {
        ...state,
        tz: { id: state.tz.id, status: 'approx', approxOffsetHours: action.approxOffsetHours },
      };
    case 'SET_MODE': {
      if (action.mode === 'live') {
        return { ...state, mode: 'live', time: { epochMs: Date.now() } }; // FR-13.3
      }
      return { ...state, mode: 'paused' };
    }
    case 'SET_MAP_STYLE_MODE':
      return { ...state, mapStyle: { mode: action.mode, explicit: action.explicit } };
    case 'SET_CAMERA':
      return { ...state, camera: { ...state.camera, ...action.camera } };
    case 'SET_QUALITY':
      return state.quality === action.tier ? state : { ...state, quality: action.tier };
    case 'SET_NET':
      return { ...state, net: { online: action.online } };
    case 'SEARCH_STATUS':
      return { ...state, ui: { ...state.ui, searchStatus: action.status, searchError: action.error } };
    case 'NOTICE':
      return { ...state, ui: { ...state.ui, [action.key]: action.message } };
    case 'SET_ADVANCED_OPEN':
      return { ...state, ui: { ...state.ui, advancedOpen: action.open } };
    case 'HYDRATE':
      return {
        ...state,
        ...action.patch,
        tz: { id: null, status: 'pending', approxOffsetHours: null },
        mode: action.mode,
      };
    default:
      return state;
  }
}

export type Listener = (state: AppState, action: Action) => void;

export function createStore() {
  let state = initialState();
  const listeners = new Set<Listener>();

  function dispatch(action: Action): void {
    state = reduce(state, action);
    for (const listener of listeners) listener(state, action);
  }

  function getState(): AppState {
    return state;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { dispatch, getState, subscribe };
}

export type Store = ReturnType<typeof createStore>;

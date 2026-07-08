// App entry point: creates the store, hydrates from the URL (NFR-4.1 gate),
// wires the URL sync adapter, and mounts the two read-only subscriber
// subsystems (map and UI) — Technical Architecture §1/§2.5.
import { createStore } from './store';
import { createUrlSync, parseUrlState } from './url';
import { createSunMap } from './map';
import { createUi } from './ui';

const store = createStore();
const urlSync = createUrlSync(store.getState);

function hydrateFromUrl(origin: 'url') {
  const { patch, mode, rejected } = parseUrlState(location.search);
  store.dispatch({ type: 'HYDRATE', patch, mode, origin });
  if (rejected.length > 0) {
    store.dispatch({
      type: 'NOTICE',
      key: 'snapNotice',
      message: `Ignored invalid link parameters: ${rejected.join(', ')} (using defaults).`,
      origin,
    });
  }
}

hydrateFromUrl('url'); // initial load

// URL is write-only during the session except for popstate, which re-validates
// through the same NFR-4.1 gate every time (Technical Architecture §2.5).
window.addEventListener('popstate', () => hydrateFromUrl('url'));

store.subscribe((state, action) => urlSync.onAction(state, action));

const mapEl = document.getElementById('map')!;
const uiEl = document.getElementById('ui-root')!;

createSunMap(mapEl, store, urlSync);
createUi(uiEl, store, urlSync);

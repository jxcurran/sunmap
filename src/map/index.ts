// Map/WebGL subsystem entry point. Owns the MapLibre instance, the custom sun-path GL
// layer (sunLayer.ts), the shadow approximation (shadows.ts), the pin marker, the
// day/night tint (dayNightTint.ts), camera<->store sync, and the NFR-1.7 quality ladder.
// See sun-path-app-technical-architecture.md §5 for the design this implements.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AppState, QualityTier } from '../types';
import type { Store } from '../store';
import type { UrlSync } from '../url';
import { commitLocation } from '../locationCommit';
import { getSunPosition } from '../solar';
import { debounce } from '../util';
import { createQualityMonitor } from './quality';
import { hasWebGLSupport, renderUnsupportedMessage } from './support';
import { SunLayer } from './sunLayer';
import { ShadowController } from './shadows';
import { createTintOverlay, setNight } from './dayNightTint';

export function createSunMap(container: HTMLElement, store: Store, urlSync: UrlSync): { destroy(): void } {
  // NFR-5.2: probe before ever constructing MapLibre.
  if (!hasWebGLSupport()) {
    renderUnsupportedMessage(container);
    return { destroy() {} };
  }

  const initial = store.getState();
  // Centered on `location` (not `camera.center`): on a fresh URL hydration, `camera`
  // keeps its default value (HydratablePatch doesn't include it) and could otherwise
  // briefly disagree with a hydrated location. zoom/pitch/bearing are genuine
  // camera-only concerns so those do come from `camera`.
  const map = new maplibregl.Map({
    container,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [initial.location.lng, initial.location.lat],
    zoom: initial.camera.zoom,
    pitch: initial.camera.pitch,
    bearing: initial.camera.bearing,
    maxTileCacheSize: 100, // NFR-1.3 budget cap; MapLibre's own cache handles eviction beyond this
  });

  const tintEl = createTintOverlay(container);

  // Second, ordinary DOM marker showing the selected location (distinct from the
  // custom-GL sun marker) — draggable per FR-2.6's "explicitly dropping/moving the pin".
  const pinMarker = new maplibregl.Marker({ draggable: true })
    .setLngLat([initial.location.lng, initial.location.lat])
    .addTo(map);
  let lastLocation = { lat: initial.location.lat, lng: initial.location.lng };

  pinMarker.on('dragend', () => {
    const { lng, lat } = pinMarker.getLngLat();
    commitLocation(store, { lat, lng, label: null, source: 'pin', origin: 'map' });
    urlSync.commit(); // FR-8.4: discrete commit point
  });

  // dblclick-to-drop: minimal FR-2.6 fulfillment alongside marker drag, no separate
  // "pin mode" state machine. preventDefault() also cancels the default zoom-in.
  map.on('dblclick', (e) => {
    e.preventDefault();
    const { lng, lat } = e.lngLat;
    pinMarker.setLngLat([lng, lat]);
    commitLocation(store, { lat, lng, label: null, source: 'pin', origin: 'map' });
    urlSync.commit();
  });

  // FR-2.6: camera pan/zoom/pitch/rotate updates `camera` only, never `location`/`tz`.
  // Fires on our own flyTo/easeTo completions too, which is correct (camera state
  // should reflect wherever the camera actually ends up) — see item 8 in the brief.
  map.on('moveend', () => {
    const c = map.getCenter();
    store.dispatch({
      type: 'SET_CAMERA',
      camera: { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
      origin: 'map',
    });
  });

  const shadows = new ShadowController();
  let buildingLayerId: string | null = null;
  let mapReady = false;

  function findBuildingLayerId(): string | null {
    const layers = map.getStyle()?.layers ?? [];
    return layers.find((ly) => ly.type === 'fill-extrusion')?.id ?? null;
  }

  function findFirstSymbolLayerId(): string | undefined {
    const layers = map.getStyle()?.layers ?? [];
    return layers.find((ly) => ly.type === 'symbol')?.id;
  }

  // Item 12 of the brief: Q0/Q1/Q2 keep 3D buildings; Q3 forces flat 2D (pitch 0 +
  // building layer hidden, since extrusions are still visible from directly overhead).
  // The custom sun layer (marker/ray) itself is never gated here — it stays alive at
  // every tier per the same instruction.
  function applyQualityTier(tier: QualityTier): void {
    if (buildingLayerId) {
      map.setLayoutProperty(buildingLayerId, 'visibility', tier === 'Q3' ? 'none' : 'visible');
    }
    if (tier === 'Q3' && map.getPitch() !== 0) {
      map.easeTo({ pitch: 0, duration: 300 });
    }
  }

  function updateTint(state: AppState): void {
    const epoch = state.mapStyle.mode === 'real-time' ? Date.now() : state.time.epochMs;
    const { altitude } = getSunPosition(epoch, state.location.lat, state.location.lng);
    setNight(tintEl, altitude < 0);
  }

  function runUpdatePass(state: AppState): void {
    if (state.location.lat !== lastLocation.lat || state.location.lng !== lastLocation.lng) {
      lastLocation = { lat: state.location.lat, lng: state.location.lng };
      pinMarker.setLngLat([state.location.lng, state.location.lat]);
      map.easeTo({ center: [state.location.lng, state.location.lat], duration: 600 }); // UX nicety, item 8
    }
    updateTint(state);
    if (!mapReady || !sunLayer) return; // style/layers not ready yet; tz resolves near-instantly regardless
    applyQualityTier(state.quality);
    sunLayer.update(state);
    const shadowsAllowedByTier = state.quality === 'Q0' || state.quality === 'Q1';
    const sun = getSunPosition(state.time.epochMs, state.location.lat, state.location.lng);
    shadows.update(state.location.lat, sun.altitude, sun.azimuth, shadowsAllowedByTier);
    map.triggerRepaint(); // MapLibre only repaints on demand; our own time-driven changes need this
  }

  // FR-9.3/NFR-1.7 Q1+: our own marker drag suspends/resumes shadow recompute exactly
  // (onMarkerDragChange below). For externally-driven scrubbing we don't get a discrete
  // "dragend" event (timeline/keyboard live in the UI layer), so we approximate it as a
  // short idle gap in SET_TIME churn — reusing the same debounce util as URL throttling.
  const settleShadowRecalc = debounce(() => {
    shadows.setSuspended(false);
    runUpdatePass(store.getState());
  }, 150);

  function onMarkerDragChange(dragging: boolean): void {
    if (store.getState().quality === 'Q0') return; // full quality: never gate (FR-9.3 only kicks in under low perf)
    shadows.setSuspended(dragging);
    if (!dragging) runUpdatePass(store.getState()); // fire exactly once on dragEnd
  }

  const sunLayer = new SunLayer(store, urlSync, onMarkerDragChange);

  map.on('load', () => {
    buildingLayerId = findBuildingLayerId(); // null is a legitimate "no 3D data here" case (FR-1.3.1)
    map.addLayer(sunLayer, findFirstSymbolLayerId()); // §5.4: above extrusions, below symbols
    shadows.init(map, buildingLayerId);
    mapReady = true;
    runUpdatePass(store.getState());
  });

  const qualityMonitor = createQualityMonitor({
    onTierChange: (tier) => store.dispatch({ type: 'SET_QUALITY', tier, origin: 'system' }),
    onFrame: (dt) => console.debug('[sun-map] frame', dt), // NFR-1.9 hook; no analytics backend exists
  });
  qualityMonitor.start();

  const unsubscribe = store.subscribe((state, action) => {
    const tier = state.quality;
    const isExternalDragLikeChange =
      action.type === 'SET_TIME' && (action.origin === 'timeline' || action.origin === 'keyboard');
    if (tier !== 'Q0' && isExternalDragLikeChange && !sunLayer.getIsDragging()) {
      shadows.setSuspended(true);
      settleShadowRecalc();
    } else if (tier === 'Q0') {
      shadows.setSuspended(false);
    }
    runUpdatePass(state);
  });

  // 'real-time' style mode tracks the actual wall clock even while paused/idle (no
  // store dispatches happening) — a coarse timer catches drift that store-driven
  // updates alone would miss. 60s cadence matches FR-13.6's "sub-minute unnecessary".
  const tintInterval = window.setInterval(() => updateTint(store.getState()), 60_000);

  return {
    destroy() {
      window.clearInterval(tintInterval);
      unsubscribe();
      qualityMonitor.suspend();
      pinMarker.remove();
      tintEl.remove();
      map.remove(); // tears down style/layers/DOM, invoking SunLayer.onRemove for GL cleanup
    },
  };
}

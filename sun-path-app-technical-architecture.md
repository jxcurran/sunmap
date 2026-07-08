# Technical Architecture: Modernized Sun Path Application
*Revision 1 — companion to Functional Requirements Rev. 5 and NFR Rev. 1. Defines the deterministic pipelines that keep state predictable.*

## 1. Architectural Overview

The system is a client-side single-page application organized around one **centralized, unidirectional state store**. All user inputs, network resolutions, and clock ticks are expressed as dispatched actions; every visual surface (map layers, timeline, panels, theme, URL) is a read-only, derived subscriber. Nothing renders from local mutable copies of shared state.

```
                 ┌────────────────────────────────────────────┐
   user input    │                ACTIONS                     │
  ─────────────► │ SET_TIME · COMMIT_LOCATION · SET_DATE ·    │
   clock tick    │ SET_MODE · TZ_RESOLVED(epoch) · HYDRATE …  │
  ─────────────► └───────────────────┬────────────────────────┘
   async resolve                     ▼
  ─────────────►        ┌─────────────────────────┐
                        │   CANONICAL STORE        │
                        │  (single state machine)  │
                        └─────┬───────────┬────────┘
                              ▼           ▼
                     memoized selectors (sun position,
                     trajectory geometry, phases, DST map)
                              │
      ┌───────────┬───────────┼─────────────┬─────────────┐
      ▼           ▼           ▼             ▼             ▼
  Map custom   Timeline    Data panels   Theme ctrl    URL sync
  layer (GL)   (ARIA)                                  adapter
      read-only subscribers — they dispatch actions, never write state
```

**Why this shape:** FR-9 demands that any control updates every surface simultaneously. Bidirectional bindings between five surfaces create update cycles (map → store → timeline → store → map …). Unidirectional flow with derived subscribers makes cycles structurally impossible; the remaining echo risk is handled in §2.4.

## 2. State Management

### 2.1 Canonical store schema
```
AppState {
  location:  { lat, lng, label, source: 'search'|'geoloc'|'pin'|'url' }   // FR-2.6 anchor
  tz:        { id: IANA string | null, status: 'resolved'|'approx'|'pending', epoch }
  time:      { epochMs }                                                  // single time truth
  mode:      'live' | 'paused'                                            // FR-13
  date view: derived, never stored (see §3)
  mapStyle:  { mode: 'app-time'|'real-time', explicit? }                  // FR-1.4
  camera:    { center, zoom, pitch, bearing }                             // independent of location (FR-2.6)
  quality:   Q0–Q3 tier (NFR-1.7)
  net:       { online, pendingOps }
}
```
`camera` and `location` are deliberately separate slices: panning mutates `camera` only, so timezone context can never shift during free navigation (FR-2.6).

### 2.2 Live/Paused as an explicit state machine
`mode` transitions are enumerated, not inferred:
- `live → paused` on: `SET_TIME` from timeline drag, map reverse-drag, keyboard step (FR-12.4), calendar selection.
- `paused → live` on: "Return to Live" (FR-13.3), which also dispatches `SET_TIME(now)`.
- `HYDRATE` sets the initial mode from URL state (FR-13.4).
In `live`, a scheduler (§7) dispatches `TICK` actions; in `paused`, no time-mutating timers exist at all.

### 2.3 Derived data via memoized selectors
Sun position, the sampled trajectory arc, phase boundaries, and the DST hour-map are **pure functions of (location, date, tz)** computed in memoized selectors — never stored, never duplicated. Consumers (GL layer, timeline gradient, panels) share one memo, so they cannot disagree. Memo keys and bounds are defined in §6.3.

### 2.4 Echo suppression (origin tagging)
Every action carries an `origin` tag: `'timeline' | 'map' | 'keyboard' | 'clock' | 'url' | 'system'`. A subscriber applying a store update programmatically (e.g., the map moving its sun sprite because the timeline changed time) must not re-dispatch the change it is merely reflecting. Concretely: components dispatch only from *direct user input handlers*, and ignore store-driven updates for dispatch purposes. This closes the classic map↔timeline feedback loop.

### 2.5 URL sync adapter (FR-8.4)
The URL is a **write-only projection during a session** and a **read-only source exactly once, at hydration**:
- Subscribes to the store; serializes `{lat, lng, date, time, style, mode}`.
- During continuous interaction (an `interaction.active` flag set on `dragStart`/pointer-down, cleared on `dragEnd`): `history.replaceState`, throttled to ≤ 4 Hz.
- On discrete commits (location commit, calendar date, style toggle, `dragEnd`): single `history.pushState`.
- `TICK` and midnight rollover never write history (FR-13.6, FR-13.7).
- `popstate` (Back/Forward) dispatches `HYDRATE` through the same NFR-4.1 validation gate as initial load — the URL is untrusted input every time.

## 3. Time Representation & DST Strategy

**Canonical time is a UTC epoch (`epochMs`) plus the selected location's IANA tz id.** Wall-clock values are always *derived* at the presentation edge via the tz database (`Intl` / a tz-aware date library). Consequences:

- DST becomes a pure presentation concern. A "day" on the timeline is the epoch interval `[localMidnight, nextLocalMidnight)`, which is naturally 23, 24, or 25 hours long — the arc slider maps slider-fraction → epoch linearly over that interval, so FR-4.7's skipped/repeated hours fall out of the representation instead of being special-cased.
- The fall-back repeated hour is unambiguous internally (two distinct epochs); disambiguation (`'earlier' | 'later'`) is needed only when converting *user-entered wall time* → epoch, at the input boundary.
- FR-7.3.1's "retain time of day across date change" is implemented as: derive wall time from current epoch in current tz → construct same wall time on new date → convert back to epoch, applying FR-7.3.2's nearest-valid-time snap if the wall time doesn't exist.
- Midnight rollover (FR-13.7) is a comparison of `epochMs` against a precomputed `nextLocalMidnightEpoch` — no string date math.

## 4. Asynchronous Operation Management

### 4.1 Domains, epochs, and aborts
Async work is partitioned into domains, each with a **monotonic intent counter** and an `AbortController`:

| Domain | Triggering intents | Superseded by |
|---|---|---|
| A. Location commit | search selection, Locate Me, pin drop, URL hydrate | any newer A intent |
| B. Timezone resolution | successful A commit | any newer A intent |
| C. Autocomplete suggestions | keystrokes in search box | next keystroke, or any A intent |

Rules:
1. Every dispatched request captures the current counter value of its domain.
2. A new intent in a domain **increments the counter and aborts** all in-flight requests in that domain (and, for domain A, also aborts B and C).
3. A resolution is applied **only if its captured counter equals the current counter**; stale resolutions are discarded, not merged.

**Precedence is defined by user-action order, never network resolution order.** The review's scenario — search "London" (A₁), then click Locate Me (A₂), London resolves last — is handled twice over: A₂ aborted A₁'s request, and even an un-abortable late A₁ resolution fails the counter check. The state cannot revert.

### 4.2 Timezone resolution pipeline
On location commit: `tz.status = 'pending'` → the tz source (§6.1) resolves → `TZ_RESOLVED(id, epoch-check)`. Until resolution, wall-clock displays use the longitude approximation (FR-2.5.1) with `status: 'approx'` surfaced in the UI. Solar geometry (pure lat/lng/epoch math) is **not blocked** by tz resolution — only wall-clock labels and day boundaries are provisional, and they reconcile atomically when `TZ_RESOLVED` lands.

### 4.3 Failure semantics
State commits only on successful resolution (NFR-2.7). Timeouts/retries per NFR-2.1–2.2 live inside the service layer; the store sees exactly one terminal action per intent: `*_RESOLVED` or `*_FAILED` (which triggers the FR-defined error states).

## 5. Rendering Pipeline & WebGL Orchestration

### 5.1 One GL context, not two
Custom solar visuals (trajectory arc, sun marker, azimuth ray) render **inside the map library's own context and render loop** via its custom-layer interface (MapLibre/Mapbox `CustomLayerInterface`), not in an overlaid second canvas. This guarantees: shared projection matrices every frame (no 2D/3D coordinate drift), correct depth interaction with buildings/terrain, no cross-context compositing or Z-fighting between canvases, and a single context-loss story.

### 5.2 Coordinate spaces and the single transform path
One transform utility owns `(lat, lng, altitude) → mercator → clip space`, fed by the projection matrix the map hands the custom layer each frame. The trajectory arc is tessellated into a VBO **only when (location, date, tz) changes** (via the §2.3 memo) — per-frame work is just the matrix upload and the sun sprite position.

### 5.3 Reverse-drag raycasting (FR-3.1.1)
True 3D ray/arc intersection is unnecessary. On pointer move during a marker drag:
1. Project the memoized arc samples (§6.3, ~5-minute resolution) to screen space using the current frame's matrix.
2. Find the nearest sample to the pointer (2D distance), then binary-refine between its neighbors to sub-sample precision.
3. Emit `SET_TIME(epoch, origin:'map')`.
This is O(samples) per move, robust under any pitch/bearing, and degrades gracefully when the arc is nearly edge-on.

### 5.4 Z-ordering and x-ray mode (FR-14)
The custom layer is inserted at an explicit position in the style's layer stack (above extrusions, below UI symbols). Above-horizon rendering uses normal depth testing so buildings correctly occlude the distant ray. If product selects FR-14(a) x-ray mode, the below-horizon pass re-renders marker/ray with depth test disabled and the dashed/reduced-opacity treatment; the altitude-0° crossfade (FR-14.3) is a uniform-driven blend, coordinated with the shadow-layer fade (FR-1.5.1) off the same altitude signal.

### 5.5 Shadows
Neither MapLibre nor Mapbox provides dynamic per-building sun shadows natively. Two viable options, decision flagged for a spike:
- **(a) Interleaved deck.gl layer** using its sunlight/shadow effect over the same building extrusion data — proven path, recommended default.
- **(b) Custom shadow-map pass** inside the custom layer — more control, more risk.
Either way, the shadow pass is the *only* per-frame-expensive stage, and it is the stage gated by FR-9.3 (drag-end binding) and the NFR-1.7 quality ladder (resolution caps per NFR-1.4; disabled below horizon per FR-1.5.1).

### 5.6 Context loss (NFR-5.3)
`webglcontextlost` → `preventDefault()`, suspend loop, set `quality` freeze; `webglcontextrestored` → rebuild VBOs/textures from memoized CPU-side data (nothing is *only* GPU-resident) and resume. State store is untouched throughout; recovery is a pure re-render.

## 6. Caching & Offline Strategy

### 6.1 Timezone lookup — library-first (recommended)
FR-2.5 permits "a timezone lookup service **or library**." Architecture recommendation: bundle a compact offline coordinate→IANA lookup library (~tens of KB class, e.g., tz-lookup-style) as the **primary** resolver, with the network service as an optional refinement/fallback. One decision simultaneously satisfies:
- **NFR-2.4/2.5** — timezone resolution works offline;
- **NFR-3.1** — coordinates never leave the device for tz purposes;
- **NFR-4.7 / the rate-limit concern** — panning or rapid location changes can never exhaust an API quota;
- **§4 simplification** — domain B becomes synchronous in the common case.
Known tradeoff: coarse libraries can err within a few km of tz borders; if the product requires border-exact resolution, the network service is invoked only when the library flags low confidence, cached per 6.2.

### 6.2 Network tz cache (if/where the service is used)
Key: **geohash precision 5 (≈ 4.9 km cell) → IANA id**. LRU, 500 entries. Entries carry the tzdb version; cache invalidated on app-release tzdb bump, otherwise effectively immortal (tz *boundaries* change rarely; tz *rules* live in the bundled tzdb, not the cache).

### 6.3 Solar trajectory memo
Key: `(localDate, lat@4dp, lng@4dp, tzId)` → sampled arc (≈ 5-min resolution ⇒ ~288 samples) + event epochs (sunrise/noon/sunset/twilights) + polar/DST flags. LRU, 32 entries (covers scrubbing across nearby dates). Invalidated implicitly by key; midnight rollover (FR-13.7) simply computes the next day's key.

### 6.4 Geocoding
Autocomplete: 250 ms debounce, minimum 3 characters, session-scoped LRU of 50 query→results entries, in-flight aborted per §4 domain C. These bounds also implement NFR-4.7's client-side rate cap.

### 6.5 Tiles
Delegated to the map library, with cache size explicitly configured to the NFR-1.3 GPU budget and offline behavior per NFR-2.5.

## 7. Scheduling (Live Mode, Rollover, Visibility)

- **Live tick cadence (FR-13.6):** clock text at 1 Hz; solar geometry/shadow update every 15 s (sun moves ~0.25°/min — sub-second recompute is waste); theme threshold check every 60 s. All ticks dispatch through the store (`origin:'clock'`); none touch the URL.
- **Midnight rollover (FR-13.7):** no polling. On entering Live (and on any tz/date change), compute `nextLocalMidnightEpoch` and arm a single timer for it; firing dispatches `ROLLOVER` (date increment + memo key change + timeline regen). Timers are re-validated on `visibilitychange`/wake, since suspended tabs drift — on wake, if `now ≥ nextLocalMidnightEpoch`, roll immediately and re-arm.
- **Visibility:** hidden document suspends the render loop and live timers (NFR-1.8); on return, Live mode dispatches `SET_TIME(now)` before resuming so the display never shows stale "live" data.

## 8. Traceability Summary

| Architecture element | Discharges |
|---|---|
| Unidirectional store + origin tagging (§2) | FR-9 without circular updates; review's "death spiral" |
| URL sync adapter (§2.5) | FR-8.4 history discipline; NFR-4.1 on every hydrate |
| Epoch-canonical time (§3) | FR-4.7, FR-7.3.1/7.3.2, FR-13.7 with no special-cased DST logic |
| Intent counters + aborts (§4) | Review's London/Locate-Me race; NFR-2.3, NFR-2.7 |
| Single-context custom layer (§5.1–5.4) | FR-3.1.1 raycasting, FR-14 x-ray, no Z-fighting/projection drift |
| Library-first tz + bounded caches (§6) | FR-2.5, NFR-2.4, NFR-3.1, NFR-4.7; review's quota-exhaustion risk |
| Timer scheduling (§7) | FR-13.6/13.7 correctness across tab sleep |

Open decisions flagged for stakeholders: shadow implementation spike (§5.5 a vs b); whether border-exact tz resolution justifies retaining the network service alongside the bundled library (§6.1).

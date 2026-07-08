# Non-Functional Requirements: Modernized Sun Path Application
*Revision 1 — companion to Functional Requirements Rev. 5. Defines system constraints, degradation behavior, and hardware/network realities.*

## NFR-1: Performance & Resource Constraints

### Reference Hardware Baseline
- **NFR-1.1** All performance targets shall be measured against two defined reference profiles, and both shall be part of the QA sign-off matrix:
  - **Mobile reference:** 2021-class mid-range device (Snapdragon 7-series or equivalent Apple A13-class SoC, 4–6 GB RAM, mid-tier mobile GPU), latest stable OS browser.
  - **Desktop reference:** 2020-class quad-core laptop with integrated graphics (no discrete GPU), 8 GB RAM.
- **NFR-1.2** The 30 FPS floor referenced in FR-1.2/FR-4.3 shall be verified in a **defined test scene**: dense urban viewport (e.g., central Manhattan), zoom ≈ 15.5, pitch 60°, bearing 45°, 3D buildings and shadows enabled, while continuously scrubbing the timeline. Pass criterion: 95th-percentile frame time ≤ 33 ms on the mobile reference; ≤ 18 ms (≈55 FPS) on the desktop reference.

### Memory & GPU Budgets
- **NFR-1.3** Total GPU-resident memory (tile textures, shadow maps, custom layer buffers) shall not exceed **256 MB on mobile** / **512 MB on desktop**. The map library's tile cache shall be explicitly capped (e.g., via `maxTileCacheSize`) to fit this budget.
- **NFR-1.4** Shadow map resolution shall be capped at **2048×2048 on desktop** and **1024×1024 on mobile**.
- **NFR-1.5** JavaScript heap shall remain ≤ 300 MB steady-state, with **no unbounded growth**: a 30-minute soak test (continuous Live mode + periodic scrubbing) shall show no sustained upward heap trend exceeding 5 MB/min. Trajectory memos, tz caches, and geocode caches shall all be LRU-bounded (sizes defined in the Technical Architecture).
- **NFR-1.6** Initial JS payload (including the map rendering library) shall not exceed **800 KB gzipped**; Time-to-Interactive on the mobile reference over a throttled "Fast 3G" profile shall be ≤ 5 seconds.

### Thermal & Sustained-Load Degradation
- **NFR-1.7** The system shall implement a **quality degradation ladder** to respond to thermal throttling or sustained low frame rates (extends FR-9.3):
  - **Q0 (full):** 3D buildings + real-time shadows + terrain.
  - **Q1:** shadow recalculation bound to `dragEnd` only (FR-9.3 behavior made persistent).
  - **Q2:** shadows disabled; 3D buildings retained.
  - **Q3:** flat 2D rendering; solar marker/ray and all calculations remain fully functional.
  - Triggers: sustained 95th-percentile FPS < 30 for 10 s steps down one tier; recovery above 45 FPS for 60 s steps back up one tier. Tier changes shall be logged and, at Q2/Q3, subtly indicated to the user.
- **NFR-1.8** The render loop shall fully suspend when the document is hidden (`visibilitychange`), resuming and re-syncing Live time on return.
- **NFR-1.9** The application shall emit frame-time and tier-change telemetry hooks sufficient to enforce and audit FR-9.3 and NFR-1.7 in the field (implementation per Technical Architecture; data captured must comply with NFR-3).

## NFR-2: Network Resiliency & Offline Degradation

### Timeouts & Retry Policy
- **NFR-2.1** All first-party-initiated API requests shall carry explicit timeouts: **5 s for geocoding**, **5 s for timezone lookup**. Map tile requests are governed by the map library but shall not block application interactivity.
- **NFR-2.2** Failed requests shall retry with **exponential backoff with jitter**: base 500 ms, factor 2, maximum 3 attempts (≈500 ms / 1 s / 2 s). Retries apply only to network-level failures and 5xx/429 responses; 4xx client errors shall not be retried. After final failure, the FR-defined error states (FR-2.5.1, FR-5.2.1) shall surface.
- **NFR-2.3** In-flight requests superseded by newer user intent shall be **aborted, not merely ignored** (cancellation semantics defined in Technical Architecture §4).

### Offline & Degraded-Connection Behavior
- **NFR-2.4** Because all solar mathematics execute client-side, the following shall remain **fully functional with zero connectivity**, for the currently selected location and any date: timeline scrubbing, reverse dragging, date changes, Live/Paused switching, forward and reverse calculation, and all data panels.
- **NFR-2.5** When offline: previously cached map tiles shall continue to display; un-cached tile areas shall render a neutral placeholder without error dialogs; search (FR-5.2.1) and *new-location* timezone resolution (FR-2.5.1) shall show their defined error states; a persistent, non-blocking offline indicator shall be shown.
- **NFR-2.6** On constrained connections (as reported by the Network Information API where available, or inferred from tile latency), the system shall reduce tile prefetch radius and defer non-essential asset loading. Core interaction latency shall never be gated on network round-trips.
- **NFR-2.7** Connectivity loss mid-request shall never corrupt application state: state commits only on successful resolution (see Technical Architecture §2), and a request failing after a connection drop shall leave the prior valid state untouched.

## NFR-3: Data Privacy & Transmission Limits

- **NFR-3.1** Full-precision device coordinates from the Geolocation API shall be used **only client-side** (all solar math is local). Coordinates transmitted to any third-party service (timezone lookup, geocoding proximity bias) shall first be **rounded to 2 decimal places (≈1.1 km)** — sufficient precision for timezone and proximity purposes.
- **NFR-3.2** No first-party backend shall receive, log, or persist user coordinates. Server-side access logs for any first-party proxy shall be configured to exclude coordinate query parameters.
- **NFR-3.3** Geolocation permission shall be requested **only in response to an explicit user gesture** (the "Locate Me" action, FR-5.1) — never on page load.
- **NFR-3.4** Analytics/telemetry (including NFR-1.9 performance data), if present, shall exclude coordinates entirely or round them to 1 decimal place (≈11 km), and shall never capture full page URLs containing FR-8 state parameters at higher precision.
- **NFR-3.5** URL sharing (FR-8) necessarily embeds the selected coordinates; this is an explicit, user-initiated disclosure. The share affordance shall make it evident that the link encodes the viewed location.
- **NFR-3.6** All network transmission shall use TLS 1.2+. Third-party services shall be limited to a documented allowlist (see NFR-4.4).
- **NFR-3.7** The application shall not employ device fingerprinting, and shall not use persistent identifiers beyond what is strictly required for the features specified in the FR.

## NFR-4: Security & Input Sanitization

### URL State Hydration (hardens FR-8.2)
- **NFR-4.1** All URL-derived state shall be validated against a strict schema before hydration:
  - Latitude clamped to [−90, 90]; longitude to [−180, 180]; non-numeric → rejected.
  - Date parsed strictly as ISO-8601 and bounded to the solar algorithm's validity window (e.g., 1900–2100).
  - Time/timestamp validated as a finite epoch within the same window.
  - Map style, Live/Paused flag, and any enum parameters validated against a **whitelist**; unrecognized values rejected.
- **NFR-4.2** Any parameter failing validation shall be **individually discarded and replaced by its default**, with a non-blocking notice; malformed state shall never crash the rendering engine, throw unhandled exceptions, or block load (fail-safe hydration).
- **NFR-4.3** URL-derived values shall be treated strictly as data: never interpolated into HTML/DOM as markup, never passed to `eval`/`Function`, never used to construct selectors or URLs without encoding.

### Platform Hardening
- **NFR-4.4** A Content Security Policy shall be enforced, minimally: `default-src 'self'`; `script-src 'self'` (no `unsafe-inline`, no `unsafe-eval`); `connect-src` restricted to the documented API/tile allowlist; `img-src 'self'` + tile CDN; `worker-src 'self' blob:` (map libraries require worker blobs); `frame-ancestors 'none'` (clickjacking protection).
- **NFR-4.5** Any third-party scripts loaded from a CDN shall use Subresource Integrity hashes; version-pinned dependencies with a routine audit cadence.
- **NFR-4.6** Map/geocoding API keys shall be treated as public identifiers: restricted by HTTP referrer and quota at the provider, or brokered through a rate-limited first-party proxy. No privileged secrets shall ship in the client bundle.
- **NFR-4.7** Client-side outbound rate limiting shall cap geocode/timezone request frequency (in concert with the debounce/caching rules in the Technical Architecture) so a malfunctioning UI loop cannot exhaust provider quotas.

## NFR-5: Compatibility
- **NFR-5.1** Supported browsers: the last two major versions of Chrome, Edge, Firefox, and Safari (desktop and mobile).
- **NFR-5.2** WebGL (WebGL2 preferred, WebGL1 minimum per the chosen map library) is required for map rendering. If WebGL is unavailable or blocked, the system shall present an explicit unsupported-environment message rather than a blank canvas; solar *data* display for a searched location may still function in a reduced, map-less mode if product chooses to support it (decision flagged for stakeholders).
- **NFR-5.3** WebGL context loss shall be handled and recovered without a page reload (mechanics in Technical Architecture §5).

---

### Traceability Notes
- NFR-1 makes FR-1.2/FR-4.3/FR-9.3 testable (hardware baseline, test scene, degradation ladder) and adds the memory ceilings the FR lacked.
- NFR-2 defines the timeout/retry/offline contract behind FR-2.5.1 and FR-5.2.1, and guarantees the client-side solar core works offline.
- NFR-3 constrains the data flows created by FR-5.1 (geolocation) and FR-2.5 (timezone lookup).
- NFR-4 hardens the attack surface created by FR-8 (URL hydration).
- Open stakeholder decisions: exact reference device SKUs (NFR-1.1) and whether a map-less fallback mode ships (NFR-5.2).

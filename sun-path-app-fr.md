## FR-1: Map Display & Rendering
- **FR-1.1** The system shall render an interactive map using a WebGL-based rendering engine (e.g., MapLibre GL JS / Mapbox GL JS).
- **FR-1.2** Users shall be able to zoom, pan, pitch (tilt), and rotate (bearing) the map view, maintaining a minimum of 30 frames per second (FPS) during map manipulation.
- **FR-1.3** The system shall support 3D terrain rendering and 3D building extrusions where such data is available for the selected location.
  - **FR-1.3.1** If 3D building data is unavailable for the selected location (e.g., rural or unmapped areas), the system shall gracefully fall back to flat satellite or vector tile rendering without throwing an error or blocking the UI.
- **FR-1.4** The map's visual style (dark, light, satellite) shall default to matching the currently active application time (see FR-13 for Live vs. Paused semantics).
  - **FR-1.4.1** A user-accessible toggle shall allow overriding this default so the map style instead matches the real-world local time *of the currently selected map location* (per FR-2.5), regardless of the scrubbed time.
  - **FR-1.4.2** The active mode (application-time-driven vs. real-time-driven) shall be clearly indicated in the UI at all times.
- **FR-1.5** The system shall render 3D building shadows, recalculated as the sun's altitude/azimuth changes, subject to the performance rule in FR-9.3.
  - **FR-1.5.1** When the sun's altitude is at or below 0° (between sunset and sunrise), the 3D building shadow layer shall be entirely disabled or set to 0 opacity, preventing rendering-engine anomalies such as upward-casting or inverted shadows. Shadow rendering shall re-enable smoothly (e.g., a brief opacity fade) as the sun crosses back above the horizon, coordinated with the horizon-crossing transition in FR-14.3.
## FR-2: Sun Position Calculation (Forward)
- **FR-2.1** Given a location (lat/long) and a date/time, the system shall calculate and display the sun's altitude and azimuth.
- **FR-2.2** The system shall display sunrise, sunset, solar noon, and twilight phase boundaries (civil, nautical, astronomical) for the selected date and location, subject to the polar edge-case handling in FR-6.
- **FR-2.3** The system shall render a visible ray/vector line on the map from the user's pin toward the sun's current azimuth.
  - **FR-2.3.1** When the sun's altitude is below 0° (below the horizon), the sun marker and ray shall follow the nighttime rendering rule defined in FR-14.
- **FR-2.4** The system shall support underlying calculations via a solar position library (e.g., SunCalc) or equivalent implementation of a recognized solar position algorithm (e.g., SPA).
- **FR-2.5** All time values displayed or calculated shall be resolved in the local timezone of the currently selected location (as defined in FR-2.6), not the user's browser/device timezone. The system shall determine the correct timezone for any selected coordinate via a timezone lookup service or library.
  - **FR-2.5.1** If the timezone lookup service fails or times out, the system shall alert the user (non-blocking) and fall back to an approximate timezone derived from longitude (UTC offset ≈ longitude / 15), clearly indicating the value is approximate.
  - **FR-2.5.2** All relative temporal concepts — "Today," "Tomorrow," "now," and any relative date shortcut — shall be calculated in the local timezone of the currently selected location, completely ignoring the timezone of the user's physical device. (Example: a user in New York at Monday 11:00 PM viewing Tokyo, where it is Tuesday 12:00 PM, who clicks "Today" shall jump to Tuesday — Tokyo's current date.)
- **FR-2.6** **Definition of "selected location":** the selected location (the anchor for all sun calculations and timezone resolution) shall update **only** upon discrete user actions: choosing a search result (FR-5.2), activating "Locate Me" (FR-5.1), explicitly dropping/moving the pin on the map, or restoring from URL state (FR-8). Continuous free-panning, zooming, pitching, or rotating of the map camera shall **not** alter the selected location or its timezone context. The map camera and the selected location are independent concepts: users may pan the camera across timezone boundaries with no effect on the timeline, clock, or data panels.
## FR-3: Sun Position Calculation (Reverse)
- **FR-3.1** The sun marker shall be draggable *only* along the calculated solar trajectory path for the selected date — not to arbitrary map coordinates — since the sun's position is a one-dimensional function of time on any given date.
  - **FR-3.1.1** Because the map may be pitched/rotated into a 3D perspective (FR-1.2) while user input is a 2D pointer/touch coordinate, the system shall determine drag position by finding the closest point on the projected 3D solar trajectory arc to the user's 2D screen-space input (e.g., via raycasting against the arc geometry), rather than requiring exact 3D intersection.
  - **FR-3.1.2** Draggability of the below-horizon portion of the trajectory is governed by the nighttime interaction rule in FR-14.
- **FR-3.2** Dragging the marker along the permitted trajectory shall calculate and display the corresponding time of day at that point on the path.
- **FR-3.3** The reverse-calculated time shall be reflected simultaneously in the timeline control and all data panels (see FR-9).
- **FR-3.4** On days where no solar trajectory exists above the horizon (see FR-6.1, Polar Night), reverse-dragging on the map shall be disabled, with an explanatory message shown to the user.
- **FR-3.5** Initiating a reverse-calculation drag shall disengage Live mode per FR-13.2.
## FR-4: Timeline / Sun-Path Control
- **FR-4.1** The system shall provide a curved (arc-shaped) slider control representing the sun's altitude path across the selected day, rather than a straight-line slider.
- **FR-4.2** The slider's draggable handle (sun icon) shall represent the current application time (see FR-13).
- **FR-4.3** As the user drags the handle, the map's sun position and all data panels shall update in real time, maintaining a minimum of 30 FPS; shadow recalculation is subject to the rule in FR-9.3, and URL updates are subject to FR-8.4.
- **FR-4.4** A time readout shall accompany the handle during dragging:
  - **FR-4.4.1** On pointer (mouse) interfaces, this shall render as a tooltip following the cursor/handle.
  - **FR-4.4.2** On touch interfaces, this shall render as a static readout positioned above the slider or map marker, so it is not obscured by the user's finger.
- **FR-4.5** The slider track shall visually encode twilight/daylight phases using a color gradient, adapted per FR-6.2 for polar-day/polar-night conditions.
- **FR-4.6** The slider shall provide a snapping behavior (visual and/or haptic pulse) when the handle crosses key solar events: sunrise, solar noon, sunset — where those events exist for the selected date/location (see FR-6.1).
- **FR-4.7** For dates on which the selected location observes a Daylight Saving Time transition, the timeline shall represent the day accurately as either 23 or 25 hours:
  - On "spring forward" days, the timeline shall visually skip the non-existent hour (the slider shall not allow scrubbing to a time that does not exist).
  - On "fall back" days, the timeline shall represent the repeated hour distinctly (e.g., "1:30 AM" and "1:30 AM (again)"), and calculations shall correctly disambiguate which instance is selected.
- **FR-4.8** Any user interaction with the timeline shall disengage Live mode per FR-13.2.
## FR-5: Location Input
- **FR-5.1** The system shall provide a "Locate Me" function using the browser's Geolocation API to set the current location automatically.
  - **FR-5.1.1** If geolocation permission is denied, unavailable, or the request times out, the system shall default to a predefined fallback location (e.g., Prime Meridian, London) and display a non-intrusive prompt inviting the user to search for a location manually.
- **FR-5.2** The system shall provide a search bar with autocomplete for cities and named landmarks, backed by a geocoding service.
  - **FR-5.2.1** If the geocoding service fails, times out, or is rate-limited, the search bar shall display an explicit error state (e.g., "Search currently unavailable") rather than failing silently or showing an empty result set.
- **FR-5.3** Setting a new selected location via any of the discrete actions defined in FR-2.6 shall update the map center, sun calculations, timezone context, and all displayed data. (Map camera movement alone shall not — see FR-2.6.)
## FR-6: Temporal & Geographic Edge Cases
- **FR-6.1** For dates/locations where the sun does not rise or set within a 24-hour period (Polar Night) or does not set at all (Midnight Sun / Polar Day), the system shall:
  - Suppress or replace the sunrise/sunset/solar-noon markers that do not apply for that day.
  - Display an explicit indicator (e.g., "Polar Night" / "Midnight Sun") rather than showing empty or misleading data fields.
- **FR-6.2** The timeline gradient (FR-4.5) and snap markers (FR-4.6) shall visually adapt to these conditions rather than displaying a standard day/night cycle.
## FR-7: Date Management
- **FR-7.1** The system shall provide a calendar pop-over/picker for selecting an arbitrary date.
- **FR-7.2** The system shall provide quick-jump shortcuts for the solstices, equinoxes, and relative dates (e.g., "Today").
  - **FR-7.2.1** Solstice labels shall either (a) be dynamically assigned based on the hemisphere of the currently selected location — e.g., the June solstice labeled "Summer Solstice" in the Northern Hemisphere and "Winter Solstice" in the Southern Hemisphere — or (b) use hemisphere-neutral absolute terms ("June Solstice," "December Solstice"). One approach shall be chosen consistently across the app.
  - **FR-7.2.2** Relative date shortcuts ("Today," "Tomorrow," etc.) shall resolve per FR-2.5.2: relative to the local date/time of the currently selected location, never the user's device timezone.
- **FR-7.3** Changing the date shall recalculate the sun path, timeline gradient, and all displayed data for the new date, including re-evaluating polar edge cases (FR-6) and DST status (FR-4.7).
  - **FR-7.3.1** When the date is changed while in a Paused state (FR-13.2), the system shall **retain the exact application time of day** (e.g., 1:00 PM) and apply it to the newly selected date, instantly updating the sun position, shadows, theme, and data panels to reflect that hour's seasonal lighting on the new date. The clock shall not reset to noon or any other default.
  - **FR-7.3.2** If the retained time of day does not exist on the new date (a "spring forward" skipped hour, FR-4.7), the system shall snap to the nearest valid time and indicate the adjustment to the user.
## FR-8: URL State & Deep Linking
- **FR-8.1** The system shall encode the core application state — latitude, longitude, date, time, active map style, and Live/Paused mode (FR-13) — into the URL (query parameters or hash fragment).
- **FR-8.2** On page load, the system shall parse any state present in the URL and restore the corresponding view.
  - **FR-8.2.1** A shared URL containing a specific timestamp shall restore in **Paused** mode, presenting a frozen snapshot of exactly the moment encoded in the link (see FR-13.4). It shall not silently resume ticking from that timestamp.
- **FR-8.3** This shall enable users to bookmark or share a link that reproduces a specific view exactly.
- **FR-8.4** URL update strategy shall be isolated from continuous interaction to protect browser history integrity:
  - During continuous interactions (timeline scrubbing, marker dragging, map panning), URL state updates shall use `history.replaceState` (or be throttled/suppressed entirely until interaction ends), never `history.pushState`.
  - `history.pushState` shall be invoked only on discrete state changes: selecting a new location, choosing a calendar date, toggling map style, or on `dragEnd` of a continuous interaction.
  - Under no circumstances shall continuous scrubbing produce more than one browser history entry, ensuring the browser "Back" button remains meaningful.
## FR-9: State Synchronization & Performance
- **FR-9.1** All UI elements (timeline, data panels, map sun marker, shadows, ray-trace line, theme) shall stay synchronized to a single shared time/location/date state.
- **FR-9.2** Any state change from any single control (map drag, timeline drag, date picker, location search, live clock tick per FR-13) shall propagate to update all other dependent UI elements without requiring a page reload or manual refresh. URL propagation is governed separately by FR-8.4 and is exempt from per-frame propagation.
- **FR-9.3** During low-performance conditions (frame rate below 30 FPS), real-time 3D shadow recalculation shall be bypassed during the continuous drag/scrub event and shall fire only once, on the `dragEnd`/pointer-up event, rather than continuously during `onDrag`. (Note: this is a drag-end-binding behavior, distinct from time-based debouncing, and should be implemented/described as such.)
## FR-10: Data Display & Hierarchy
- **FR-10.1** Primary/critical metrics (current time, sun altitude, sun azimuth) shall be displayed using typography that meets a defined minimum size and WCAG AA contrast ratio, per the project's design system.
- **FR-10.2** Granular/advanced astronomical data (e.g., Julian Ephemeris Date, Right Ascension, Declination) shall be hidden by default behind an expandable "Advanced" toggle.
- **FR-10.3** Data shall be presented in floating panel(s) overlaying the map on desktop viewports.
  - **FR-10.3.1** On viewports below a defined width threshold (e.g., mobile devices), floating panels shall collapse into a bottom sheet or togglable drawer, prioritizing map visibility over persistent panel display.
- **FR-10.4** Panels shall use a semi-transparent, blurred ("glassmorphism") background so the underlying map remains partially visible, provided this does not reduce text contrast below WCAG AA thresholds.
## FR-11: Interaction & Input Modality
- **FR-11.1** Modal/panel open and close transitions shall use smooth, physics-based animation (e.g., spring easing) rather than instant or linear transitions.
- **FR-11.2** All drag-based controls (timeline handle, sun marker) shall support both pointer (mouse) and touch input, with behavior differences specified explicitly (FR-4.4, FR-3.1.1) rather than assuming hover-based interaction universally.
## FR-12: Accessibility
- **FR-12.1** Interactive controls (calendar, toggles, dropdowns) shall be implemented using accessible primitives supporting keyboard navigation and screen reader compatibility.
- **FR-12.2** Color-coded elements (e.g., twilight gradient) shall be supplemented with text or numeric labels so information is not conveyed by color alone.
- **FR-12.3** All text shall meet WCAG AA contrast minimums, including text rendered over glassmorphism/blurred panels (FR-10.4).
- **FR-12.4** The custom arc timeline slider (FR-4) shall implement the W3C ARIA slider pattern (`role="slider"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and a human-readable `aria-valuetext` such as "2:35 PM, 14° above horizon"). It shall be fully operable via keyboard:
  - **Left/Right arrows:** step application time by 1-minute increments.
  - **PageUp/PageDown:** step by 1-hour increments.
  - **Home/End:** jump to the start/end of the day.
  - Keyboard-driven time changes shall disengage Live mode (FR-13.2) identically to drag interactions, and shall announce the new time to screen readers.
- **FR-12.5** Because the WebGL map canvas is inherently opaque to assistive technology, all state manipulable via on-map dragging (the reverse calculation, FR-3) shall be equivalently achievable through the accessible timeline slider (FR-12.4) or other accessible controls; no functionality shall be exclusive to canvas interaction.
## FR-13: Live vs. Paused Time Model
- **FR-13.1** On initial load without URL state, the application shall operate in a **Live** state: application time tracks the real-world clock (resolved in the selected location's timezone per FR-2.5), and the sun position, shadows, theme, and data panels advance automatically as real time passes.
- **FR-13.2** Any user manipulation of time — dragging the timeline handle (FR-4), reverse-dragging the sun marker (FR-3), keyboard time-stepping (FR-12.4), or selecting a date/time via the calendar — shall immediately disengage Live mode and enter a **Paused** state, freezing application time at the user's selected value.
- **FR-13.3** While Paused, the UI shall display a clearly visible, persistent control (e.g., "Return to Live") that, when activated, re-engages Live mode and snaps application time back to the current real-world moment (including the current real-world date, if the paused date differed).
- **FR-13.4** URLs restored with an encoded timestamp (FR-8.2.1) shall load in Paused mode at that exact timestamp; URLs without a timestamp shall load in Live mode.
- **FR-13.5** The current mode (Live or Paused) shall be visually distinguishable at a glance (e.g., a pulsing "LIVE" indicator vs. a static paused-time display).
- **FR-13.6** Live-mode clock ticks shall update the UI at a defined cadence (e.g., once per second or per minute for sun position — sub-second updates are unnecessary given the sun's angular speed) and shall not trigger URL history writes (FR-8.4).
- **FR-13.7** **Midnight rollover:** if Live mode is active and application time crosses local midnight (in the selected location's timezone), the system shall automatically increment the application date, recalculate the solar trajectory path (FR-3.1), regenerate the timeline gradient and snap markers (FR-4.5, FR-4.6), and re-evaluate polar/DST edge cases (FR-6, FR-4.7) for the new day — all without requiring a page reload or user intervention. The rollover shall not produce a browser history entry.
## FR-14: Nighttime (Below-Horizon) Rendering & Interaction
- **FR-14.1** When the sun's altitude is below 0°, the system shall adopt ONE of the following two behaviors, chosen consistently and documented:
  - **(a) X-ray mode:** the sun marker and azimuth ray remain rendered with a visually distinct treatment (e.g., reduced opacity, dashed line, or "x-ray" overlay drawn above terrain/building geometry) so they remain visible and draggable through 3D terrain, clearly signaling the sun is below the horizon; or
  - **(b) Timeline-only mode:** the on-map sun marker and ray are hidden while the sun is below the horizon, and nighttime time manipulation is available exclusively via the 2D timeline slider (FR-4).
- **FR-14.2** In neither behavior shall the ray render as if the sun were above the horizon (i.e., the UI shall never misleadingly depict a below-horizon sun as visible daylight).
- **FR-14.3** The transition between above-horizon and below-horizon rendering shall occur smoothly at the horizon crossing (altitude = 0°), without visual popping or marker teleportation, and shall coordinate with the shadow-layer disable/enable behavior in FR-1.5.1.
---
 
### Summary of Changes from Revision 4
| Area | Change |
|---|---|
| FR-2.6 (new) | Defined "selected location" precisely: updates only on discrete actions (search, Locate Me, pin drop, URL restore). Free map panning never shifts the timezone context, eliminating the cross-boundary panning glitch. FR-5.3 updated to match. |
| FR-1.5.1 (new) | Shadow layer fully disabled (or 0 opacity) when the sun is below the horizon, preventing inverted/upward-cast shadow anomalies; re-enables with a fade coordinated with FR-14.3. |
| FR-13.7 (new) | Defined Live-mode midnight rollover: automatic date increment, trajectory/timeline recalculation, and edge-case re-evaluation with no reload and no history entry. |
| FR-12.4, FR-12.5 (new) | Required W3C ARIA slider pattern for the arc slider with defined keyboard stepping (arrows = 1 min, PageUp/Down = 1 hr, Home/End = day bounds) and `aria-valuetext`; mandated that no functionality be exclusive to the inaccessible WebGL canvas. FR-13.2 updated to include keyboard stepping as a pause trigger. |
| FR-7.3.1 (new) | Date changes while Paused retain the exact time of day, applied to the new date (no reset to noon). |
| FR-7.3.2 (new) | Follow-on rule: if the retained time doesn't exist on the new date (DST skipped hour), snap to nearest valid time with user indication. |
 
Technical stack recommendations remain intentionally excluded from this document, as they describe implementation choices rather than functional behavior.

// FR-4 / FR-12.4-5: the custom arc timeline slider.
//
// Geometry: a stylized semicircular "dome" arc (not an altitude-accurate plot —
// per spec that's an acceptable, established simplification for this control).
// Slider-fraction f in [0,1] maps LINEARLY across the epoch interval
// [localMidnight, nextLocalMidnight), which is naturally 23/24/25h long. That
// linear-epoch mapping is what makes FR-4.7 (DST skip/repeat) fall out for free:
// the skipped hour has no epoch in the interval so it's structurally unreachable,
// and the repeated hour corresponds to two distinct epochs / two distinct slider
// positions, both reachable. We still label the later instance "(again)" per
// FR-4.7's text requirement (see shared.ts#formatWallLabel).
import type { Store } from '../store';
import type { UrlSync } from '../url';
import type { AppState } from '../types';
import type { UiComponent, DayContext } from './shared';
import { dayContext, formatWallLabel, clamp } from './shared';
import { getSunPosition } from '../solar';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VB_W = 300;
const VB_H = 170;
const CX = 150;
const CY = 150;
const R = 130;
const SNAP_TOLERANCE_MS = 2 * 60 * 1000; // FR-4.6 snap-pulse tolerance window

let gradientCounter = 0;

function point(f: number): { x: number; y: number } {
  const theta = Math.PI * (1 - f);
  return { x: CX + R * Math.cos(theta), y: CY - R * Math.sin(theta) };
}

// x is monotonic in f (see point()), so a plain left-to-right gradient stays
// visually aligned with fraction along the arc even though y is not linear.
function fractionFromPoint(px: number, py: number): number {
  const dx = px - CX;
  const dy = Math.max(0, CY - py); // clamp: never go "below" the arc's baseline
  const theta = Math.atan2(dy, dx); // in [0, π] since dy >= 0
  return clamp(1 - theta / Math.PI, 0, 1);
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

interface Stop {
  frac: number;
  color: string;
}

const NIGHT = '#0d1321';
const ASTRO = '#16213e';
const NAUTICAL = '#2b4570';
const CIVIL = '#e08e45';
const DAY_COLOR = '#8ecae6';
const NOON_COLOR = '#ffe08a';

// FR-4.5: twilight/daylight phase gradient built from the day's event boundaries.
function phaseStops(ctx: DayContext): Stop[] {
  const span = ctx.dayEnd - ctx.dayStart;
  const frac = (e: number) => clamp((e - ctx.dayStart) / span, 0, 1);
  const ev = ctx.solarDay.events;
  const stops: Stop[] = [{ frac: 0, color: NIGHT }];
  const add = (e: number | null, color: string) => {
    if (e !== null) stops.push({ frac: frac(e), color });
  };
  add(ev.astronomicalDawn, ASTRO);
  add(ev.nauticalDawn, NAUTICAL);
  add(ev.civilDawn, CIVIL);
  add(ev.sunrise, DAY_COLOR);
  stops.push({ frac: frac(ev.solarNoon), color: NOON_COLOR });
  add(ev.sunset, DAY_COLOR);
  add(ev.civilDusk, CIVIL);
  add(ev.nauticalDusk, NAUTICAL);
  add(ev.astronomicalDusk, ASTRO);
  stops.push({ frac: 1, color: NIGHT });
  stops.sort((a, b) => a.frac - b.frac);
  return stops;
}

// FR-12.4: "2:35 PM, 14° above horizon" — plus the FR-4.7 "(again)" suffix when applicable.
function ariaValueText(epochMs: number, tzId: string, lat: number, lng: number): string {
  const clock = formatWallLabel(epochMs, tzId);
  const alt = getSunPosition(epochMs, lat, lng).altitude;
  const altText = alt >= 0 ? `${Math.round(alt)}° above horizon` : `${Math.round(Math.abs(alt))}° below horizon`;
  return `${clock}, ${altText}`;
}

export function mountTimeline(container: HTMLElement, store: Store, urlSync: UrlSync): UiComponent {
  const gradId = `sp-timeline-grad-${++gradientCounter}`;

  const root = document.createElement('div');
  root.className = 'timeline';
  root.setAttribute('role', 'slider');
  root.setAttribute('tabindex', '0');
  root.setAttribute('aria-orientation', 'horizontal');
  root.setAttribute('aria-label', 'Time of day');

  const svg = svgEl('svg');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('class', 'timeline-arc');
  svg.setAttribute('aria-hidden', 'true');

  const defs = svgEl('defs');
  const gradient = svgEl('linearGradient');
  gradient.setAttribute('id', gradId);
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('x2', '1');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('y2', '0');
  defs.appendChild(gradient);

  const leftPt = point(0);
  const rightPt = point(1);
  const track = svgEl('path');
  track.setAttribute('d', `M ${leftPt.x},${leftPt.y} A ${R},${R} 0 0 1 ${rightPt.x},${rightPt.y}`);
  track.setAttribute('class', 'track');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke-linecap', 'round');
  track.setAttribute('stroke-width', '10');

  const markers = svgEl('g');
  markers.setAttribute('class', 'markers');

  const handle = svgEl('circle');
  handle.setAttribute('class', 'handle');
  handle.setAttribute('r', '9');

  svg.append(defs, track, markers, handle);

  // FR-4.4: tooltip-follows-cursor on mouse, static readout on touch.
  const readout = document.createElement('div');
  readout.className = 'timeline-readout';
  readout.hidden = true;

  // FR-6.1: replaces the normal gradient/markers on polar days.
  const polarIndicator = document.createElement('div');
  polarIndicator.className = 'timeline-polar';
  polarIndicator.hidden = true;

  root.append(svg, readout, polarIndicator);
  container.appendChild(root);

  let dragging = false;
  let pointerKind: 'mouse' | 'touch' = 'mouse';
  let lastDayKey = '';
  let lastSnapKey: string | null = null;

  function rebuildTrack(ctx: DayContext) {
    if (ctx.solarDay.polar) {
      track.setAttribute('stroke', ctx.solarDay.polar === 'midnight-sun' ? '#cfe8ff' : NIGHT);
      markers.innerHTML = '';
      polarIndicator.hidden = false;
      polarIndicator.textContent =
        ctx.solarDay.polar === 'midnight-sun'
          ? 'Midnight Sun — sun stays above the horizon all day'
          : 'Polar Night — sun stays below the horizon all day';
      return;
    }
    polarIndicator.hidden = true;
    track.setAttribute('stroke', `url(#${gradId})`);
    gradient.innerHTML = '';
    for (const s of phaseStops(ctx)) {
      const stop = svgEl('stop');
      stop.setAttribute('offset', String(s.frac));
      stop.setAttribute('stop-color', s.color);
      gradient.appendChild(stop);
    }

    markers.innerHTML = '';
    const span = ctx.dayEnd - ctx.dayStart;
    const addMarker = (e: number | null, cls: string) => {
      if (e === null) return; // FR-6.1: suppress markers that don't apply
      const f = clamp((e - ctx.dayStart) / span, 0, 1);
      const p = point(f);
      const dot = svgEl('circle');
      dot.setAttribute('class', `marker marker-${cls}`);
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.setAttribute('r', '4');
      markers.appendChild(dot);
    };
    addMarker(ctx.solarDay.events.sunrise, 'sunrise');
    addMarker(ctx.solarDay.events.solarNoon, 'noon');
    addMarker(ctx.solarDay.events.sunset, 'sunset');
  }

  // FR-4.6: brief pulse when the handle passes within tolerance of a key event.
  function updateSnap(ctx: DayContext, epochMs: number) {
    const events: [string, number | null][] = [
      ['sunrise', ctx.solarDay.events.sunrise],
      ['solarNoon', ctx.solarDay.events.solarNoon],
      ['sunset', ctx.solarDay.events.sunset],
    ];
    let hit: string | null = null;
    for (const [name, e] of events) {
      if (e !== null && Math.abs(epochMs - e) <= SNAP_TOLERANCE_MS) {
        hit = name;
        break;
      }
    }
    if (hit && hit !== lastSnapKey) {
      handle.classList.remove('snap-pulse');
      void handle.getBoundingClientRect(); // force reflow so the animation restarts
      handle.classList.add('snap-pulse');
    }
    lastSnapKey = hit;
  }

  function dispatchFromPointer(e: PointerEvent) {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const px = (e.clientX - rect.left) * (VB_W / rect.width);
    const py = (e.clientY - rect.top) * (VB_H / rect.height);
    const f = fractionFromPoint(px, py);
    const ctx = dayContext(store.getState());
    const epochMs = Math.round(ctx.dayStart + f * (ctx.dayEnd - ctx.dayStart));
    store.dispatch({ type: 'SET_TIME', epochMs, origin: 'timeline' });
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    dispatchFromPointer(e);
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    render(store.getState()); // hide the readout
    urlSync.commit(); // FR-8.4: pushState only at dragEnd, not during the drag
  }
  function onPointerDown(e: PointerEvent) {
    dragging = true;
    pointerKind = e.pointerType === 'touch' ? 'touch' : 'mouse';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    dispatchFromPointer(e);
  }
  svg.addEventListener('pointerdown', onPointerDown);

  // FR-12.4 keyboard operation.
  function onKeyDown(e: KeyboardEvent) {
    const state = store.getState();
    const ctx = dayContext(state);
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = state.time.epochMs - 60_000;
        break;
      case 'ArrowRight':
        next = state.time.epochMs + 60_000;
        break;
      case 'PageDown':
        next = state.time.epochMs - 3_600_000;
        break;
      case 'PageUp':
        next = state.time.epochMs + 3_600_000;
        break;
      case 'Home':
        next = ctx.dayStart;
        break;
      case 'End':
        next = ctx.dayEnd - 60_000;
        break;
      default:
        return;
    }
    e.preventDefault();
    const epochMs = clamp(next, ctx.dayStart, ctx.dayEnd - 1);
    store.dispatch({ type: 'SET_TIME', epochMs, origin: 'keyboard' });
    // Each key press is already a discrete step (not a continuous drag), so it's
    // fine — and matches FR-8.4's spirit — to commit once per press.
    urlSync.commit();
  }
  root.addEventListener('keydown', onKeyDown);

  function render(state: AppState) {
    const ctx = dayContext(state);
    const span = ctx.dayEnd - ctx.dayStart;
    const f = clamp((state.time.epochMs - ctx.dayStart) / span, 0, 1);

    const dayKey = `${ctx.dayStart}|${ctx.dayEnd}|${ctx.solarDay.polar ?? 'n'}|${state.location.lat.toFixed(4)}|${state.location.lng.toFixed(4)}`;
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      rebuildTrack(ctx);
    }

    const p = point(f);
    handle.setAttribute('cx', String(p.x));
    handle.setAttribute('cy', String(p.y));

    root.setAttribute('aria-valuemin', String(ctx.dayStart));
    root.setAttribute('aria-valuemax', String(ctx.dayEnd));
    root.setAttribute('aria-valuenow', String(state.time.epochMs));
    root.setAttribute('aria-valuetext', ariaValueText(state.time.epochMs, ctx.tzId, state.location.lat, state.location.lng));

    updateSnap(ctx, state.time.epochMs);

    if (dragging) {
      readout.hidden = false;
      readout.textContent = ariaValueText(state.time.epochMs, ctx.tzId, state.location.lat, state.location.lng);
      if (pointerKind === 'touch') {
        readout.classList.add('static');
        readout.style.left = '';
        readout.style.top = '';
      } else {
        readout.classList.remove('static');
        readout.style.left = `${(p.x / VB_W) * 100}%`;
        readout.style.top = `${(p.y / VB_H) * 100}%`;
      }
    } else {
      readout.hidden = true;
    }
  }

  return {
    render,
    destroy() {
      svg.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    },
  };
}

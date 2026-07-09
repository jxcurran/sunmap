// FR-10: primary metrics + collapsible advanced data. Responsive bottom-sheet
// collapse (FR-10.3.1) is mostly CSS (see style.css); the `.collapsed` class
// toggled here is local UI chrome, not app state, so it isn't round-tripped
// through the store.
import type { Store } from '../store';
import type { AppState } from '../types';
import type { UiComponent } from './shared';
import { dayContext, effectiveTzId } from './shared';
import { formatClock } from '../time';
import { getSunPosition } from '../solar';

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

function formatEventTime(epoch: number | null, tzId: string): string {
  return epoch === null ? '—' : formatClock(epoch, tzId);
}

function row(label: string): { row: HTMLElement; value: HTMLElement } {
  const r = document.createElement('div');
  r.className = 'advanced-row';
  const l = document.createElement('span');
  l.className = 'advanced-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'advanced-value';
  r.append(l, v);
  return { row: r, value: v };
}

export function mountPanels(container: HTMLElement, store: Store): UiComponent {
  const wrap = document.createElement('section');
  wrap.className = 'panels';
  wrap.setAttribute('aria-label', 'Sun data');

  const sheetToggle = document.createElement('button');
  sheetToggle.type = 'button';
  sheetToggle.className = 'sheet-toggle';
  sheetToggle.setAttribute('aria-expanded', 'true');
  sheetToggle.textContent = 'Sun Data';
  sheetToggle.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    sheetToggle.setAttribute('aria-expanded', String(!collapsed));
  });

  // FR-10.1: primary metrics — larger type, high contrast (see style.css).
  const primary = document.createElement('div');
  primary.className = 'primary-metrics';
  const timeEl = document.createElement('div');
  timeEl.className = 'metric metric-time';
  const altEl = document.createElement('div');
  altEl.className = 'metric metric-altitude';
  const azEl = document.createElement('div');
  azEl.className = 'metric metric-azimuth';
  primary.append(timeEl, altEl, azEl);

  // FR-6.1 explicit indicator for polar edge cases.
  const polarBanner = document.createElement('div');
  polarBanner.className = 'polar-banner';
  polarBanner.hidden = true;

  // FR-10.2: advanced data hidden by default behind a toggle.
  const advToggle = document.createElement('button');
  advToggle.type = 'button';
  advToggle.className = 'advanced-toggle';
  advToggle.textContent = 'Advanced ▾';
  advToggle.setAttribute('aria-expanded', 'false');
  advToggle.setAttribute('aria-controls', 'sp-advanced-panel');

  const advPanel = document.createElement('div');
  advPanel.id = 'sp-advanced-panel';
  advPanel.className = 'advanced-panel';

  const rSunrise = row('Sunrise');
  const rSunset = row('Sunset');
  const rNoon = row('Solar Noon');
  const rCivil = row('Civil Twilight');
  const rNautical = row('Nautical Twilight');
  const rAstro = row('Astronomical Twilight');
  const rLength = row('Day Length');

  advPanel.append(rSunrise.row, rSunset.row, rNoon.row, rCivil.row, rNautical.row, rAstro.row, rLength.row);

  advToggle.addEventListener('click', () => {
    const state = store.getState();
    store.dispatch({ type: 'SET_ADVANCED_OPEN', open: !state.ui.advancedOpen, origin: 'system' });
  });

  wrap.append(sheetToggle, primary, polarBanner, advToggle, advPanel);
  container.appendChild(wrap);

  function render(state: AppState) {
    const tzId = effectiveTzId(state);
    const ctx = dayContext(state);
    const pos = getSunPosition(state.time.epochMs, state.location.lat, state.location.lng);

    timeEl.textContent = formatClock(state.time.epochMs, tzId);
    altEl.textContent = `${pos.altitude.toFixed(1)}° altitude`;
    azEl.textContent = `${pos.azimuth.toFixed(1)}° azimuth`;

    if (ctx.solarDay.polar) {
      polarBanner.hidden = false;
      polarBanner.textContent = ctx.solarDay.polar === 'midnight-sun' ? 'Midnight Sun' : 'Polar Night';
    } else {
      polarBanner.hidden = true;
    }

    const ev = ctx.solarDay.events;
    rSunrise.value.textContent = formatEventTime(ev.sunrise, tzId);
    rSunset.value.textContent = formatEventTime(ev.sunset, tzId);
    rNoon.value.textContent = formatEventTime(ev.solarNoon, tzId);
    rCivil.value.textContent = `${formatEventTime(ev.civilDawn, tzId)} – ${formatEventTime(ev.civilDusk, tzId)}`;
    rNautical.value.textContent = `${formatEventTime(ev.nauticalDawn, tzId)} – ${formatEventTime(ev.nauticalDusk, tzId)}`;
    rAstro.value.textContent = `${formatEventTime(ev.astronomicalDawn, tzId)} – ${formatEventTime(ev.astronomicalDusk, tzId)}`;
    // "Day Length" means daylight duration (sunrise->sunset), not the calendar-day
    // span — ev.dayLengthMs is the latter (23/24/25h, used for DST timeline math) and
    // would misleadingly read "~24h 0m" on almost every ordinary day.
    const daylightMs =
      ev.sunrise !== null && ev.sunset !== null
        ? ev.sunset - ev.sunrise
        : ctx.solarDay.polar === 'midnight-sun'
          ? ev.dayLengthMs
          : 0;
    rLength.value.textContent = formatDuration(daylightMs);

    // FR-6.1: suppress sunrise/sunset rows that don't apply for the day.
    rSunrise.row.hidden = ev.sunrise === null;
    rSunset.row.hidden = ev.sunset === null;

    const open = state.ui.advancedOpen;
    advPanel.classList.toggle('open', open);
    advToggle.setAttribute('aria-expanded', String(open));
  }

  return {
    render,
    destroy() {
      // Only DOM-scoped listeners on nodes we own; nothing external to release.
    },
  };
}

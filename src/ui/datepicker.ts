// FR-7: date management — native <input type="date"> plus quick-jump shortcuts.
import type { Store } from '../store';
import type { UrlSync } from '../url';
import type { AppState } from '../types';
import type { UiComponent } from './shared';
import { effectiveTzId } from './shared';
import { retainTimeOfDay, localDateOf } from '../time';

// FR-7.2.1: hemisphere-neutral absolute labels, chosen consistently across the
// app (the alternative — deriving "Summer"/"Winter" from the selected location's
// hemisphere — is equally valid per the FR but adds a lookup for no functional
// gain; absolute month names are unambiguous either way).
const SHORTCUTS: { label: string; month: number; day: number }[] = [
  { label: 'March Equinox', month: 3, day: 20 },
  { label: 'June Solstice', month: 6, day: 21 },
  { label: 'September Equinox', month: 9, day: 22 },
  { label: 'December Solstice', month: 12, day: 21 },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function mountDatePicker(container: HTMLElement, store: Store, urlSync: UrlSync): UiComponent {
  const wrap = document.createElement('div');
  wrap.className = 'date-picker';

  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'date-input';
  input.min = '1900-01-01';
  input.max = '2100-12-31';
  input.setAttribute('aria-label', 'Select date');

  const shortcuts = document.createElement('div');
  shortcuts.className = 'date-shortcuts';

  let snapNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  // FR-7.3.1/7.3.2: retain time-of-day across the date change; snap + notify if
  // that wall time doesn't exist on the new date (DST spring-forward gap).
  function applyDate(date: { year: number; month: number; day: number }) {
    const state = store.getState();
    const tzId = effectiveTzId(state);
    const { epochMs, snapped } = retainTimeOfDay(state.time.epochMs, tzId, date);
    store.dispatch({ type: 'SET_TIME', epochMs, origin: 'calendar' });
    if (snapped) {
      store.dispatch({
        type: 'NOTICE',
        key: 'snapNotice',
        message: 'Original time didn’t exist on this date (DST transition) — adjusted to the nearest valid time.',
        origin: 'calendar',
      });
      if (snapNoticeTimer) clearTimeout(snapNoticeTimer);
      snapNoticeTimer = setTimeout(() => {
        store.dispatch({ type: 'NOTICE', key: 'snapNotice', message: null, origin: 'calendar' });
      }, 6000);
    }
    urlSync.commit();
  }

  input.addEventListener('change', () => {
    const val = input.value;
    if (!val) return;
    const [y, m, d] = val.split('-').map(Number);
    if (!y || !m || !d) return;
    applyDate({ year: y, month: m, day: d });
  });

  const todayBtn = document.createElement('button');
  todayBtn.type = 'button';
  todayBtn.textContent = 'Today';
  todayBtn.addEventListener('click', () => {
    // FR-2.5.2: "Today" resolves in the *selected location's* timezone, never the device's.
    const tzId = effectiveTzId(store.getState());
    applyDate(localDateOf(Date.now(), tzId));
  });
  shortcuts.appendChild(todayBtn);

  for (const s of SHORTCUTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = s.label;
    btn.addEventListener('click', () => {
      // Deliberate simplification: fixed approximate calendar dates rather than
      // real astronomical root-finding (solstices/equinoxes drift a day or two
      // year to year) — out of proportion for a quick-jump shortcut.
      const tzId = effectiveTzId(store.getState());
      const year = localDateOf(Date.now(), tzId).year;
      applyDate({ year, month: s.month, day: s.day });
    });
    shortcuts.appendChild(btn);
  }

  wrap.append(input, shortcuts);
  container.appendChild(wrap);

  function render(state: AppState) {
    const tzId = effectiveTzId(state);
    const d = localDateOf(state.time.epochMs, tzId);
    input.value = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  }

  return {
    render,
    destroy() {
      if (snapNoticeTimer) clearTimeout(snapNoticeTimer);
    },
  };
}

// FR-5: location search (autocomplete) + Locate Me.
import type { Store } from '../store';
import type { UrlSync } from '../url';
import type { AppState } from '../types';
import type { UiComponent } from './shared';
import { searchPlaces, type GeocodeResult } from '../services/geocode';
import { commitLocation, currentCommitSeq } from '../locationCommit';
import { debounce } from '../util';

export function mountSearch(container: HTMLElement, store: Store, urlSync: UrlSync): UiComponent {
  const wrap = document.createElement('div');
  wrap.className = 'search-box';

  const listId = 'sp-search-listbox';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'search-input';
  input.placeholder = 'Search for a city or place…';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', 'Search for a location');

  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'locate-btn';
  locateBtn.textContent = '\u{1F4CD} Locate Me';
  locateBtn.setAttribute('aria-label', 'Use my current location');

  const inputRow = document.createElement('div');
  inputRow.className = 'search-input-row';
  inputRow.append(input, locateBtn);

  const list = document.createElement('ul');
  list.id = listId;
  list.className = 'search-results';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  const errorEl = document.createElement('div');
  errorEl.className = 'search-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.hidden = true;

  const locateNotice = document.createElement('div');
  locateNotice.className = 'locate-notice';
  locateNotice.setAttribute('role', 'status');
  locateNotice.hidden = true;

  wrap.append(inputRow, list, errorEl, locateNotice);
  container.appendChild(wrap);

  let results: GeocodeResult[] = [];
  let activeIndex = -1;
  let controller: AbortController | null = null;
  let locateNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  function renderResults() {
    list.innerHTML = '';
    if (results.length === 0) {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `${listId}-opt-${i}`;
      li.className = 'search-result';
      li.setAttribute('role', 'option');
      li.textContent = r.label;
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      if (i === activeIndex) li.classList.add('active');
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus in the input instead of blurring to the list item
        selectResult(r);
      });
      list.appendChild(li);
    });
    if (activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-opt-${activeIndex}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function selectResult(r: GeocodeResult) {
    commitLocation(store, { lat: r.lat, lng: r.lng, label: r.label, source: 'search', origin: 'search' });
    urlSync.commit();
    results = [];
    activeIndex = -1;
    renderResults();
    input.value = r.label;
  }

  // FR-5.2/6.4: debounced 250ms, min 3 chars (searchPlaces also no-ops below that,
  // this just avoids dispatching a loading state for those keystrokes), abort the
  // previous in-flight request on every new one (domain C, Technical Architecture §4).
  const runSearch = debounce(async (query: string) => {
    controller?.abort();
    const q = query.trim();
    if (q.length < 3) {
      controller = null;
      results = [];
      activeIndex = -1;
      store.dispatch({ type: 'SEARCH_STATUS', status: 'idle', error: null, origin: 'search' });
      renderResults();
      return;
    }
    const ac = new AbortController();
    controller = ac;
    store.dispatch({ type: 'SEARCH_STATUS', status: 'loading', error: null, origin: 'search' });
    try {
      const r = await searchPlaces(q, ac.signal);
      if (ac.signal.aborted) return;
      results = r;
      activeIndex = -1;
      store.dispatch({ type: 'SEARCH_STATUS', status: 'idle', error: null, origin: 'search' });
      renderResults();
    } catch {
      if (ac.signal.aborted) return; // superseded, not a failure (FR-5.2.1 only for real failures)
      results = [];
      activeIndex = -1;
      store.dispatch({
        type: 'SEARCH_STATUS',
        status: 'error',
        error: 'Search currently unavailable — try again shortly.',
        origin: 'search',
      });
      renderResults();
    }
  }, 250);

  input.addEventListener('input', () => runSearch(input.value));

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(results.length - 1, activeIndex + 1);
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      renderResults();
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        selectResult(results[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      results = [];
      activeIndex = -1;
      renderResults();
    }
  });

  function onOutsidePointerDown(e: PointerEvent) {
    if (!wrap.contains(e.target as Node)) {
      results = [];
      activeIndex = -1;
      renderResults();
    }
  }
  document.addEventListener('pointerdown', onOutsidePointerDown);

  function showLocateNotice() {
    // FR-5.1.1: non-intrusive, never clobbers an existing selection (see click handler below).
    locateNotice.textContent = "Couldn't get your location — try searching instead.";
    locateNotice.hidden = false;
    if (locateNoticeTimer) clearTimeout(locateNoticeTimer);
    locateNoticeTimer = setTimeout(() => {
      locateNotice.hidden = true;
    }, 6000);
  }

  locateBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      showLocateNotice();
      return;
    }
    // Race guard (Technical Architecture §4 / locationCommit.ts): discard this
    // result if a newer location commit (search select, another Locate Me, a map
    // pin drop) has happened while we were waiting on the browser.
    const seq = currentCommitSeq();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (currentCommitSeq() !== seq) return;
        commitLocation(store, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: null,
          source: 'geoloc',
          origin: 'search',
        });
        urlSync.commit();
      },
      () => {
        if (currentCommitSeq() !== seq) return;
        showLocateNotice();
      },
      { timeout: 8000 },
    );
  });

  function render(state: AppState) {
    const showError = state.ui.searchStatus === 'error' && Boolean(state.ui.searchError);
    errorEl.hidden = !showError;
    errorEl.textContent = state.ui.searchError ?? '';
  }

  return {
    render,
    destroy() {
      document.removeEventListener('pointerdown', onOutsidePointerDown);
      controller?.abort();
      if (locateNoticeTimer) clearTimeout(locateNoticeTimer);
    },
  };
}

// Shared FR-2.6 discrete-location-commit path, used by search selection, Locate Me,
// and map pin-drop alike so all three trigger identical location+tz behavior.
//
// Technical Architecture §4 describes an async domain/abort-counter scheme for location
// commit + tz resolution because it assumed a network tz lookup. Since tz resolution here
// is the offline library (§6.1, services/tz.ts) it is synchronous, so that race structurally
// cannot happen for search-select/pin-drop (both already synchronous user actions). The one
// surviving async op is the Geolocation API call itself (Locate Me can take seconds and a
// user may pick a different location before it resolves) — `commitSeq` guards exactly that:
// callers of Locate Me should capture `currentCommitSeq()` before requesting the position and
// discard the result if the sequence has since advanced.
import type { Store } from './store';
import { resolveTimezone } from './services/tz';
import type { LocationSource, Origin } from './types';

let commitSeq = 0;

export function currentCommitSeq(): number {
  return commitSeq;
}

export function commitLocation(
  store: Store,
  params: { lat: number; lng: number; label: string | null; source: LocationSource; origin: Origin },
): void {
  commitSeq++;
  store.dispatch({ type: 'COMMIT_LOCATION', ...params });
  const res = resolveTimezone(params.lat, params.lng);
  if ('id' in res) {
    store.dispatch({ type: 'TZ_RESOLVED', id: res.id, origin: params.origin });
  } else {
    store.dispatch({ type: 'TZ_APPROX', approxOffsetHours: res.approxOffsetHours, origin: params.origin });
    store.dispatch({
      type: 'NOTICE',
      key: 'tzNotice',
      message: 'Timezone approximated from longitude — lookup could not resolve an exact zone.',
      origin: params.origin,
    });
  }
}

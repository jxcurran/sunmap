// Small helpers shared across the UI subsystem modules. Not part of the frozen
// contract — internal to src/ui/ only.
import type { AppState } from '../types';
import { epochToWallTime, formatClock, localMidnightEpoch, nextLocalMidnightEpoch, localDateOf, wallTimeToEpoch } from '../time';
import { getSolarDay, type SolarDay } from '../solar';

/** Every mounted UI subsystem exposes this shape; index.ts drives them uniformly. */
export interface UiComponent {
  render(state: AppState): void;
  destroy(): void;
}

/**
 * Resolves a usable IANA tz id even in the pathological case where tz-lookup
 * failed and only a longitude-derived UTC offset is available (tz.status ===
 * 'approx' with tz.id still null — see src/services/tz.ts). Etc/GMT zones are
 * fixed-offset with inverted sign vs. common usage (Etc/GMT-5 == UTC+5) but are
 * real IANA ids, which is what every time.ts helper requires. This branch is
 * expected to be effectively unreachable in practice (tz-lookup covers the whole
 * globe via Etc/GMT zones already) but is here as a last-resort anchor.
 */
export function effectiveTzId(state: AppState): string {
  if (state.tz.id) return state.tz.id;
  const offset = state.tz.approxOffsetHours ?? 0;
  const rounded = Math.max(-12, Math.min(14, Math.round(offset)));
  if (rounded === 0) return 'Etc/GMT';
  return `Etc/GMT${rounded > 0 ? '-' : '+'}${Math.abs(rounded)}`;
}

export interface DayContext {
  tzId: string;
  dayStart: number;
  dayEnd: number;
  solarDay: SolarDay;
}

/** The local day `[localMidnight, nextLocalMidnight)` for the current time+location, plus its solar data. */
export function dayContext(state: AppState): DayContext {
  const tzId = effectiveTzId(state);
  const dayStart = localMidnightEpoch(state.time.epochMs, tzId);
  const dayEnd = nextLocalMidnightEpoch(state.time.epochMs, tzId);
  const date = localDateOf(state.time.epochMs, tzId);
  const solarDay = getSolarDay(date, state.location.lat, state.location.lng, tzId);
  return { tzId, dayStart, dayEnd, solarDay };
}

/**
 * True if `epochMs` is the *later* of two epochs that share the same wall-clock
 * minute during a fall-back repeated hour (FR-4.7). Test per the spec: convert
 * epoch -> wall time -> back to epoch disambiguating 'earlier'; if that round
 * trip lands somewhere else, we started from the later instance.
 *
 * `epochToWallTime` formats to whole-second precision (Intl drops milliseconds),
 * so the round trip normally lands on `floor(epochMs / 1000) * 1000`, not
 * `epochMs` itself — compare against the floored value or every live (sub-second)
 * epoch would misreport as "(again)", even in zones with no DST at all.
 */
export function isRepeatedInstance(epochMs: number, tzId: string): boolean {
  const flooredEpoch = Math.floor(epochMs / 1000) * 1000;
  const w = epochToWallTime(epochMs, tzId);
  const earlier = wallTimeToEpoch(w, tzId, 'earlier');
  return earlier.exists && earlier.epochMs !== flooredEpoch;
}

/** formatClock, with " (again)" appended for the later instance of a fall-back repeated hour. */
export function formatWallLabel(epochMs: number, tzId: string): string {
  const clock = formatClock(epochMs, tzId);
  return isRepeatedInstance(epochMs, tzId) ? `${clock} (again)` : clock;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

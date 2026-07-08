// Timezone-aware wall-clock <-> epoch conversion, with DST gap/repeat resolution.
// Canonical time is always a UTC epoch (Technical Architecture §3); wall-clock values
// are derived at the presentation edge. This is the one place that special-cases DST
// so nothing downstream (timeline, panels, midnight rollover) has to.

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tzId: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tzId);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tzId, f);
  }
  return f;
}

export function epochToWallTime(epochMs: number, tzId: string): WallTime {
  const parts = formatter(tzId).formatToParts(new Date(epochMs));
  const g = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour') % 24, minute: g('minute'), second: g('second') };
}

function asUtcEpoch(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

function offsetAt(epochMs: number, tzId: string): number {
  return asUtcEpoch(epochToWallTime(epochMs, tzId)) - epochMs;
}

export function addMinutes(w: WallTime, minutes: number): WallTime {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute + minutes, w.second));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/**
 * Converts local wall-clock fields in tzId to an epoch.
 * `exists: false` means the wall time falls in a spring-forward gap (FR-4.7).
 * `disambiguation` picks between the two valid epochs of a fall-back repeated hour.
 */
export function wallTimeToEpoch(
  w: WallTime,
  tzId: string,
  disambiguation: 'earlier' | 'later' = 'earlier',
): { epochMs: number; exists: boolean } {
  const target = asUtcEpoch(w);
  const guess = target - offsetAt(target, tzId);
  const offset1 = offsetAt(guess, tzId);
  const candidate1 = target - offset1;
  const offset2 = offsetAt(candidate1, tzId);
  const candidate2 = target - offset2;

  const c1Valid = asUtcEpoch(epochToWallTime(candidate1, tzId)) === target;
  const c2Valid = asUtcEpoch(epochToWallTime(candidate2, tzId)) === target;

  if (c1Valid && c2Valid && candidate1 !== candidate2) {
    const earlier = Math.min(candidate1, candidate2);
    const later = Math.max(candidate1, candidate2);
    return { epochMs: disambiguation === 'earlier' ? earlier : later, exists: true };
  }
  if (c1Valid) return { epochMs: candidate1, exists: true };
  if (c2Valid) return { epochMs: candidate2, exists: true };
  return { epochMs: candidate2, exists: false }; // spring-forward gap: no valid epoch
}

export function localMidnightEpoch(epochMs: number, tzId: string): number {
  const w = epochToWallTime(epochMs, tzId);
  return wallTimeToEpoch({ ...w, hour: 0, minute: 0, second: 0 }, tzId, 'earlier').epochMs;
}

export function nextLocalMidnightEpoch(epochMs: number, tzId: string): number {
  const w = epochToWallTime(epochMs, tzId);
  const nextDay = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
  return wallTimeToEpoch(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    tzId,
    'earlier',
  ).epochMs;
}

export interface DstTransition {
  type: 'spring-forward' | 'fall-back';
  atEpochMs: number;
}

/** Locates the DST transition instant within [dayStart, dayEnd), if the day isn't 24h. */
export function findDstTransition(dayStartMs: number, dayEndMs: number, tzId: string): DstTransition | null {
  const hours = Math.round((dayEndMs - dayStartMs) / 3_600_000);
  if (hours === 24) return null;
  let lo = dayStartMs;
  let hi = dayEndMs;
  const offLo = offsetAt(lo, tzId);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, tzId) === offLo) lo = mid;
    else hi = mid;
  }
  return { type: hours < 24 ? 'spring-forward' : 'fall-back', atEpochMs: hi };
}

/** FR-7.3.1/7.3.2: same wall time of day, new local date; snaps forward if it lands in a DST gap. */
export function retainTimeOfDay(
  currentEpochMs: number,
  tzId: string,
  newLocalDate: { year: number; month: number; day: number },
): { epochMs: number; snapped: boolean } {
  const w = epochToWallTime(currentEpochMs, tzId);
  const target: WallTime = { ...newLocalDate, hour: w.hour, minute: w.minute, second: w.second };
  const direct = wallTimeToEpoch(target, tzId, 'earlier');
  if (direct.exists) return { epochMs: direct.epochMs, snapped: false };
  for (let deltaMin = 1; deltaMin <= 120; deltaMin++) {
    const probe = wallTimeToEpoch(addMinutes(target, deltaMin), tzId, 'earlier');
    if (probe.exists) return { epochMs: probe.epochMs, snapped: true };
  }
  return { epochMs: direct.epochMs, snapped: true }; // pathological zone; best effort
}

/** FR-2.5.2: "Today"/"Tomorrow" resolve in the selected location's tz, never the device's. */
export function localDateOf(epochMs: number, tzId: string): { year: number; month: number; day: number } {
  const w = epochToWallTime(epochMs, tzId);
  return { year: w.year, month: w.month, day: w.day };
}

export function addDays(date: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const clockFormatterCache = new Map<string, Intl.DateTimeFormat>();
export function formatClock(epochMs: number, tzId: string): string {
  let f = clockFormatterCache.get(tzId);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tzId, hour: 'numeric', minute: '2-digit', hour12: true });
    clockFormatterCache.set(tzId, f);
  }
  return f.format(new Date(epochMs));
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
export function formatDate(epochMs: number, tzId: string): string {
  let f = dateFormatterCache.get(tzId);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tzId, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    dateFormatterCache.set(tzId, f);
  }
  return f.format(new Date(epochMs));
}

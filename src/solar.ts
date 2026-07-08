// Memoized solar selectors — Technical Architecture §2.3/§6.3. Pure functions of
// (localDate, lat, lng, tzId); computed once per key via `suncalc` and shared by
// every consumer (GL layer, timeline gradient, panels) so they cannot disagree.
import SunCalc from 'suncalc';
import { LRU } from './lru';
import { addDays, findDstTransition, wallTimeToEpoch, type DstTransition } from './time';

export interface SunSample {
  epochMs: number;
  altitude: number; // degrees above horizon
  azimuth: number; // compass bearing, 0 = north, clockwise
}

export interface SolarEvents {
  sunrise: number | null;
  sunset: number | null;
  solarNoon: number;
  civilDawn: number | null;
  civilDusk: number | null;
  nauticalDawn: number | null;
  nauticalDusk: number | null;
  astronomicalDawn: number | null;
  astronomicalDusk: number | null;
  dayLengthMs: number;
}

export interface SolarDay {
  samples: SunSample[]; // ~5-minute resolution across the local day (FR-4.1 arc geometry)
  events: SolarEvents; // FR-2.2
  polar: 'midnight-sun' | 'polar-night' | null; // FR-6.1
  dst: DstTransition | null; // FR-4.7
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function toCompassDeg(azimuthRad: number): number {
  return ((azimuthRad * 180) / Math.PI + 180 + 360) % 360;
}

export function getSunPosition(epochMs: number, lat: number, lng: number): { altitude: number; azimuth: number } {
  const pos = SunCalc.getPosition(new Date(epochMs), lat, lng);
  return { altitude: (pos.altitude * 180) / Math.PI, azimuth: toCompassDeg(pos.azimuth) };
}

function toEpochOrNull(d: Date | undefined): number | null {
  const t = d?.getTime();
  return t === undefined || Number.isNaN(t) ? null : t;
}

function dayBounds(date: LocalDate, tzId: string): [number, number] {
  const start = wallTimeToEpoch({ ...date, hour: 0, minute: 0, second: 0 }, tzId, 'earlier').epochMs;
  const next = addDays(date, 1);
  const end = wallTimeToEpoch({ ...next, hour: 0, minute: 0, second: 0 }, tzId, 'earlier').epochMs;
  return [start, end];
}

const SAMPLE_STEP_MS = 5 * 60 * 1000;

function computeSolarDay(date: LocalDate, lat: number, lng: number, tzId: string): SolarDay {
  const [dayStart, dayEnd] = dayBounds(date, tzId);

  const samples: SunSample[] = [];
  for (let t = dayStart; t <= dayEnd; t += SAMPLE_STEP_MS) {
    const pos = SunCalc.getPosition(new Date(t), lat, lng);
    samples.push({ epochMs: t, altitude: (pos.altitude * 180) / Math.PI, azimuth: toCompassDeg(pos.azimuth) });
  }

  // Feeding local-noon (not UTC midnight) keeps getTimes anchored to the correct
  // calendar day regardless of the location's UTC offset.
  const times = SunCalc.getTimes(new Date(dayStart + 12 * 3_600_000), lat, lng);
  const events: SolarEvents = {
    sunrise: toEpochOrNull(times.sunrise),
    sunset: toEpochOrNull(times.sunset),
    solarNoon: times.solarNoon.getTime(),
    civilDawn: toEpochOrNull(times.dawn),
    civilDusk: toEpochOrNull(times.dusk),
    nauticalDawn: toEpochOrNull(times.nauticalDawn),
    nauticalDusk: toEpochOrNull(times.nauticalDusk),
    astronomicalDawn: toEpochOrNull(times.nightEnd),
    astronomicalDusk: toEpochOrNull(times.night),
    dayLengthMs: dayEnd - dayStart,
  };

  let polar: SolarDay['polar'] = null;
  if (events.sunrise === null && events.sunset === null) {
    const noonAlt = SunCalc.getPosition(times.solarNoon, lat, lng).altitude;
    polar = noonAlt > 0 ? 'midnight-sun' : 'polar-night';
  }

  return { samples, events, polar, dst: findDstTransition(dayStart, dayEnd, tzId) };
}

const memo = new LRU<string, SolarDay>(32); // Technical Architecture §6.3

export function getSolarDay(date: LocalDate, lat: number, lng: number, tzId: string): SolarDay {
  const key = `${date.year}-${date.month}-${date.day}|${lat.toFixed(4)}|${lng.toFixed(4)}|${tzId}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const computed = computeSolarDay(date, lat, lng, tzId);
  memo.set(key, computed);
  return computed;
}

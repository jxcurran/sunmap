// §6.1 (recommended): bundled offline coordinate->IANA lookup as primary resolver.
// Satisfies NFR-2.4/2.5 (works offline), NFR-3.1 (coordinates never leave the device
// for tz purposes), and NFR-4.7 (no network quota to exhaust). tz-lookup covers open
// ocean via Etc/GMT zones, so it practically never fails for a valid lat/lng — the
// longitude/15 fallback below exists for FR-2.5.1's fail-safe contract regardless.
import tzLookup from 'tz-lookup';

export type TzResolution = { id: string } | { approxOffsetHours: number };

export function resolveTimezone(lat: number, lng: number): TzResolution {
  try {
    const id = tzLookup(lat, lng);
    if (id) return { id };
  } catch {
    // fall through
  }
  return { approxOffsetHours: lng / 15 };
}

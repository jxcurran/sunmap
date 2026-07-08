// FR-5.2 search, backed by Nominatim (OSM) — free, keyless, matching NFR-4.6's
// "public identifier restricted by referrer" path (no first-party proxy needed).
import { LRU } from '../lru';
import { fetchWithRetry } from './http';

export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
}

const cache = new LRU<string, GeocodeResult[]>(50); // §6.4: session-scoped LRU of 50 entries
const MIN_QUERY_LENGTH = 3;

// Throws on any failure (network, timeout, non-2xx) other than abort — callers
// should treat `signal.aborted` as "ignore, superseded" and anything else as
// the FR-5.2.1 error state.
export async function searchPlaces(query: string, signal: AbortSignal): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  const cached = cache.get(q);
  if (cached) return cached;

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetchWithRetry(url, { timeoutMs: 5000, signal });
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const results = data.map((d) => ({ lat: Number(d.lat), lng: Number(d.lon), label: d.display_name }));
  cache.set(q, results);
  return results;
}

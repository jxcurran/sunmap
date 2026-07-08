// Pure math helpers shared by the custom GL layer (sunLayer.ts) and the shadow
// approximation (shadows.ts). No DOM/GL/store dependencies so these are trivially
// testable and reusable from either module without creating a coupling between them.

export const DEG2RAD = Math.PI / 180;

// Meters-per-degree approximation (Technical Architecture §5.5 explicitly sanctions
// this over a real geodesy library for the shadow-offset case); reused here for the
// trajectory dome offset too since both are the same "meters near a point" problem.
const METERS_PER_DEG_LAT = 111_320;

export function toRad(deg: number): number {
  return deg * DEG2RAD;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Converts an (east, north) meter offset at `atLatDeg` into a (dLng, dLat) degree offset. */
export function metersToLngLatDelta(eastM: number, northM: number, atLatDeg: number): [number, number] {
  const dLat = northM / METERS_PER_DEG_LAT;
  const dLng = eastM / (METERS_PER_DEG_LAT * Math.cos(toRad(atLatDeg)));
  return [dLng, dLat];
}

// Fixed visual radius (meters) of the sun-path "dome" centered on the pin.
// Deliberately NOT zoom-dependent: Technical Architecture §5.2 requires the arc VBO
// be rebuilt only on (location, date, tz) change, and a zoom-adaptive radius would
// force a rebuild on every zoom tick too. A fixed real-world radius still reads fine
// across the city-scale zoom range this app targets (buildings + shadows), and it's
// the simplest option that respects the rebuild-only-on-change rule.
export const DOME_RADIUS_M = 250;

/**
 * Projects a sun sample (altitude/azimuth, degrees) onto the trajectory dome centered
 * on (pinLat, pinLng): a hemisphere of `radiusM`, height scaled by sin(altitude) so
 * the path dips below the pin's plane at night (standard "sun path diagram" visual).
 */
export function domePoint(
  pinLat: number,
  pinLng: number,
  altitudeDeg: number,
  azimuthDeg: number,
  radiusM: number = DOME_RADIUS_M,
): { lng: number; lat: number; altitudeM: number } {
  const altRad = toRad(altitudeDeg);
  const azRad = toRad(azimuthDeg);
  const horiz = radiusM * Math.cos(altRad);
  const east = horiz * Math.sin(azRad);
  const north = horiz * Math.cos(azRad);
  const up = radiusM * Math.sin(altRad);
  const [dLng, dLat] = metersToLngLatDelta(east, north, pinLat);
  return { lng: pinLng + dLng, lat: pinLat + dLat, altitudeM: up };
}

// FR-14.3: smooth crossfade across the horizon over a ±FADE_BAND_DEG band, rather than
// a hard cut at altitude === 0 (which would pop). Returns 0 well below the horizon, 1
// well above, smoothstep in between. Shared by the sun-marker/ray alpha (sunLayer.ts)
// and the shadow-layer opacity (shadows.ts) per Technical Architecture §5.4's
// "coordinated off the same altitude signal" instruction.
export const FADE_BAND_DEG = 2;

export function fadeFactor(altitudeDeg: number, bandDeg: number = FADE_BAND_DEG): number {
  const t = clamp((altitudeDeg + bandDeg) / (2 * bandDeg), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Column-major mat4 * vec4(x,y,z,1), returning clip-space (x, y, w). */
export function projectToClip(
  matrix: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; w: number } {
  const m = matrix;
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    w: m[3] * x + m[7] * y + m[11] * z + m[15],
  };
}

/** Clip-space -> CSS-pixel screen space. Returns null for points behind the camera. */
export function clipToScreen(
  clip: { x: number; y: number; w: number },
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } | null {
  if (clip.w <= 0) return null;
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  return { x: (ndcX * 0.5 + 0.5) * canvasWidth, y: (1 - (ndcY * 0.5 + 0.5)) * canvasHeight };
}

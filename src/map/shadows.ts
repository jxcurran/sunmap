// Lightweight building-shadow approximation (FR-1.5, FR-9.3, NFR-1.7).
// approximated: footprint-offset shadow, not a true depth-based shadow map — see
// Technical Architecture §5.5 spike note (deck.gl/custom shadow-map both out of scope
// for this pass; deck.gl in particular would blow the NFR-1.6 bundle budget).
//
// For each currently-rendered building footprint we translate the polygon by a 2D
// offset (direction opposite the sun's azimuth, length = height / tan(altitude)) and
// draw it as a separate, semi-transparent fill layer beneath the buildings.
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl';
import { fadeFactor, metersToLngLatDelta, toRad } from './geometry';

const SOURCE_ID = 'sun-shadows-src';
const LAYER_ID = 'sun-shadows-layer';
const DEFAULT_BUILDING_HEIGHT_M = 15;
const MAX_SHADOW_LENGTH_M = 2000; // clamp near-horizon (tan -> 0) blowups
const BASE_OPACITY = 0.35;

function getBuildingHeight(feature: MapGeoJSONFeature): number {
  const props = feature.properties ?? {};
  const h = props['render_height'] ?? props['height'];
  return typeof h === 'number' && h > 0 ? h : DEFAULT_BUILDING_HEIGHT_M;
}

function shiftPositions(coords: unknown, dLng: number, dLat: number): unknown {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    const pos = coords as Position;
    return [pos[0] + dLng, pos[1] + dLat];
  }
  return (coords as unknown[]).map((c) => shiftPositions(c, dLng, dLat));
}

function shiftGeometry(geometry: Geometry, dLng: number, dLat: number): Geometry | null {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
  return {
    ...geometry,
    coordinates: shiftPositions(geometry.coordinates, dLng, dLat),
  } as Geometry;
}

export class ShadowController {
  private map: MapLibreMap | null = null;
  private buildingLayerId: string | null = null;
  private ready = false;
  private suspended = false;

  /** Adds the (initially empty/hidden) shadow source+layer, inserted just below the
   * building extrusion layer. No-ops if no building layer was found (FR-1.3.1-style
   * graceful degradation: this data source simply doesn't have 3D buildings here). */
  init(map: MapLibreMap, buildingLayerId: string | null): void {
    this.map = map;
    this.buildingLayerId = buildingLayerId;
    if (!buildingLayerId) return;
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer(LAYER_ID)) {
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'fill',
          source: SOURCE_ID,
          paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
          layout: { visibility: 'none' },
        },
        buildingLayerId,
      );
    }
    this.ready = true;
  }

  /** FR-9.3/NFR-1.7: while suspended, opacity/visibility still track the horizon
   * crossfade, but the expensive queryRenderedFeatures + geometry rebuild is skipped. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
  }

  /**
   * @param tierAllowsShadows Q0/Q1 show shadows (Q1 gated to dragEnd via setSuspended);
   *   Q2/Q3 hide them entirely per the quality ladder (item 12).
   */
  update(lat: number, altitudeDeg: number, azimuthDeg: number, tierAllowsShadows: boolean): void {
    if (!this.ready || !this.map) return;
    if (!tierAllowsShadows) {
      this.hide();
      return;
    }
    const fade = fadeFactor(altitudeDeg);
    if (fade <= 0) {
      // FR-1.5.1: hard-hide well below the horizon rather than relying on opacity=0
      // alone, so we never even compute a geometrically-nonsensical inverted shadow.
      this.hide();
      return;
    }
    this.show(fade);
    if (this.suspended) return;
    // Inside the fade band but still below the horizon (-2°..0°): tan(altitude) would
    // go negative there, flipping the offset to point toward the sun instead of away
    // from it. Rather than special-case that, just freeze the last-known geometry and
    // let opacity alone carry it through the fade-out — visually indistinguishable
    // and avoids the sign flip entirely.
    if (altitudeDeg <= 0) return;
    this.recompute(lat, altitudeDeg, azimuthDeg);
  }

  private show(fade: number): void {
    if (!this.map) return;
    this.map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
    this.map.setPaintProperty(LAYER_ID, 'fill-opacity', BASE_OPACITY * fade); // FR-1.5.1/FR-14.3 shared fade signal
  }

  private hide(): void {
    if (!this.map || !this.map.getLayer(LAYER_ID)) return;
    this.map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
  }

  private recompute(lat: number, altitudeDeg: number, azimuthDeg: number): void {
    if (!this.map || !this.buildingLayerId) return;
    const features = this.map.queryRenderedFeatures(undefined, { layers: [this.buildingLayerId] });
    const altRad = toRad(altitudeDeg);
    // Shadows fall AWAY from the sun (opposite its azimuth), not toward it.
    const shadowAzRad = toRad(azimuthDeg + 180);
    const east = Math.sin(shadowAzRad);
    const north = Math.cos(shadowAzRad);

    const out: Feature[] = [];
    for (const f of features) {
      if (!f.geometry) continue;
      const height = getBuildingHeight(f);
      const length = Math.min(MAX_SHADOW_LENGTH_M, height / Math.tan(altRad));
      const [dLng, dLat] = metersToLngLatDelta(east * length, north * length, lat);
      const shifted = shiftGeometry(f.geometry, dLng, dLat);
      if (shifted) out.push({ type: 'Feature', properties: {}, geometry: shifted });
    }

    const src = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: out } as FeatureCollection);
  }
}

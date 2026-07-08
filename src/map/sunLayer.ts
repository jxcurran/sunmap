// The custom WebGL layer: trajectory arc, sun marker, azimuth ray, and reverse-drag
// raycasting. Registered as a MapLibre CustomLayerInterface so it shares the map's own
// GL context/render loop/projection matrix (Technical Architecture §5.1) — this is what
// gives us correct depth occlusion against 3D buildings for free.
import maplibregl from 'maplibre-gl';
import type { CustomLayerInterface, Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import type { AppState } from '../types';
import type { Store } from '../store';
import type { UrlSync } from '../url';
import { getSolarDay, getSunPosition, type SolarDay } from '../solar';
import { localDateOf } from '../time';
import { DOME_RADIUS_M, domePoint, fadeFactor, projectToClip, clipToScreen } from './geometry';

// Plain WebGL, one program, one vertex layout (vec3 mercator pos + float alpha) shared
// by the arc/ray/marker — deliberately minimal per Technical Architecture §5.1 (no
// three.js/deck.gl, that would blow the NFR-1.6 bundle budget). Alpha is carried
// per-vertex (rather than as a second uniform-only color) so premultiplied-alpha
// blending works with MapLibre's default blend func without us having to change it.
const VERTEX_SRC = `
attribute vec3 a_pos;
attribute float a_alpha;
uniform mat4 u_matrix;
uniform float u_pointSize;
varying float v_alpha;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  gl_PointSize = u_pointSize;
  v_alpha = a_alpha;
}`;

const FRAGMENT_SRC = `
precision mediump float;
uniform vec3 u_color;
varying float v_alpha;
void main() {
  gl_FragColor = vec4(u_color * v_alpha, v_alpha);
}`;

const HIT_RADIUS_PX = 24;
const ARC_NIGHT_ALPHA = 0.25; // baked per-vertex dimming for the below-horizon half of the static arc
const XRAY_ALPHA_FLOOR = 0.35; // FR-14.1(a): marker/ray never fully disappear below horizon
const MARKER_POINT_SIZE = 14;
const DASH_SEGMENTS = 8; // below-horizon ray: alternating on/off segments approximate a dashed line

const ARC_COLOR: [number, number, number] = [1.0, 0.78, 0.32];
const MARKER_COLOR: [number, number, number] = [1.0, 0.93, 0.55];

function compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`sunLayer: shader compile failed: ${info ?? 'unknown error'}`);
  }
  return shader;
}

function linkProgram(gl: WebGLRenderingContext | WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`sunLayer: program link failed: ${info ?? 'unknown error'}`);
  }
  return program;
}

const STRIDE = 4 * Float32Array.BYTES_PER_ELEMENT; // x,y,z,alpha

export class SunLayer implements CustomLayerInterface {
  id = 'sun-path-layer';
  type = 'custom' as const;
  renderingMode = '3d' as const; // shares the depth buffer with buildings (occlusion, requirement 4)

  private store: Store;
  private urlSync: UrlSync;
  private onDragChange: (dragging: boolean) => void;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private aPos = -1;
  private aAlpha = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private uColor: WebGLUniformLocation | null = null;
  private uPointSize: WebGLUniformLocation | null = null;

  private arcBuffer: WebGLBuffer | null = null;
  private arcVertexCount = 0;
  private rayBuffer: WebGLBuffer | null = null;
  private markerBuffer: WebGLBuffer | null = null;

  private contextLost = false;
  private solarDay: SolarDay | null = null;
  private solarKey: string | null = null;
  private pin = { lat: 0, lng: 0 };
  private lastMatrix = new Float32Array(16);
  private haveMatrix = false;

  private dragging = false;

  constructor(store: Store, urlSync: UrlSync, onDragChange: (dragging: boolean) => void) {
    this.store = store;
    this.urlSync = urlSync;
    this.onDragChange = onDragChange;
  }

  getIsDragging(): boolean {
    return this.dragging;
  }

  /** Called from the map subsystem's central store subscription (Technical Architecture §5.2:
   * the arc VBO is rebuilt only when (location, date, tz) changes, not per frame). */
  update(state: AppState): void {
    this.pin = { lat: state.location.lat, lng: state.location.lng };
    if (state.tz.id == null) {
      // tz resolution is synchronous (services/tz.ts) so this is at most a blank frame.
      this.solarDay = null;
      this.solarKey = null;
      return;
    }
    const localDate = localDateOf(state.time.epochMs, state.tz.id);
    const key = `${localDate.year}-${localDate.month}-${localDate.day}|${state.location.lat.toFixed(4)}|${state.location.lng.toFixed(4)}|${state.tz.id}`;
    // getSolarDay is memoized (src/solar.ts LRU) — cheap to call every dispatch.
    const solarDay = getSolarDay(localDate, state.location.lat, state.location.lng, state.tz.id);
    this.solarDay = solarDay;
    if (key !== this.solarKey) {
      this.solarKey = key;
      this.rebuildArc(solarDay);
    }
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.buildGlObjects(gl);
    map.on('mousedown', this.handleDown);
    map.on('touchstart', this.handleDown);
    map.on('webglcontextlost', this.handleContextLost);
    map.on('webglcontextrestored', this.handleContextRestored);
  }

  onRemove(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    map.off('mousedown', this.handleDown);
    map.off('touchstart', this.handleDown);
    map.off('webglcontextlost', this.handleContextLost);
    map.off('webglcontextrestored', this.handleContextRestored);
    this.teardownPointerDrag();
    if (this.program) gl.deleteProgram(this.program);
    if (this.arcBuffer) gl.deleteBuffer(this.arcBuffer);
    if (this.rayBuffer) gl.deleteBuffer(this.rayBuffer);
    if (this.markerBuffer) gl.deleteBuffer(this.markerBuffer);
    this.program = null;
    this.arcBuffer = this.rayBuffer = this.markerBuffer = null;
  }

  // `matrix` is typed as the broad structural shape MapLibre's `mat4` (gl-matrix) can
  // take (plain array or any indexed/iterable numeric collection) — using `ArrayLike`
  // here (rather than importing gl-matrix's own type from a transitive dependency)
  // keeps the override signature compatible without a direct dependency on gl-matrix.
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>): void {
    this.lastMatrix.set(matrix);
    this.haveMatrix = true;
    if (this.contextLost || !this.program || !this.solarDay) return;

    const state = this.store.getState();
    const sun = getSunPosition(state.time.epochMs, this.pin.lat, this.pin.lng);
    const fade = fadeFactor(sun.altitude);
    const alpha = XRAY_ALPHA_FLOOR + (1 - XRAY_ALPHA_FLOOR) * fade;
    // Alpha crossfades smoothly over the ±2° band (FR-14.3), but depth-test/dash mode
    // toggles at the exact horizon — an acceptable simplification since alpha is
    // already partway through its fade right at that crossing, masking the switch.
    const aboveHorizon = sun.altitude >= 0;

    gl.useProgram(this.program);
    // Use the copied Float32Array (already made above) rather than casting the raw
    // `matrix` param, since MapLibre's mat4 type also allows a plain number[].
    gl.uniformMatrix4fv(this.uMatrix, false, this.lastMatrix);
    gl.depthMask(false); // thin lines/points shouldn't punch holes in the shared depth buffer for later layers

    // --- static trajectory arc: always normal depth test; per-vertex alpha already
    // dims the below-horizon half (baked at build time in rebuildArc). ---
    if (this.arcVertexCount > 1 && this.arcBuffer) {
      gl.enable(gl.DEPTH_TEST);
      gl.uniform1f(this.uPointSize, 1.0);
      gl.uniform3f(this.uColor, ARC_COLOR[0], ARC_COLOR[1], ARC_COLOR[2]);
      this.bindVertexLayout(gl, this.arcBuffer);
      gl.drawArrays(gl.LINE_STRIP, 0, this.arcVertexCount);
    }

    // --- azimuth ray + sun marker: x-ray mode below horizon (FR-14.1a) — depth test
    // disabled and dashed/reduced-alpha so it stays visible & draggable through buildings. ---
    const marker = domePoint(this.pin.lat, this.pin.lng, sun.altitude, sun.azimuth, DOME_RADIUS_M);
    const markerMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: marker.lng, lat: marker.lat }, marker.altitudeM);
    const pinMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: this.pin.lng, lat: this.pin.lat }, 0);

    if (aboveHorizon) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);

    const rayVerts = this.buildRayVertices(pinMc, markerMc, alpha, aboveHorizon);
    if (this.rayBuffer && rayVerts.length > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.rayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, rayVerts, gl.DYNAMIC_DRAW);
      gl.uniform3f(this.uColor, ARC_COLOR[0], ARC_COLOR[1], ARC_COLOR[2]);
      this.bindVertexLayout(gl, this.rayBuffer);
      gl.drawArrays(gl.LINES, 0, rayVerts.length / 4);
    }

    if (this.markerBuffer) {
      const markerVerts = new Float32Array([markerMc.x, markerMc.y, markerMc.z, alpha]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.markerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, markerVerts, gl.DYNAMIC_DRAW);
      gl.uniform1f(this.uPointSize, MARKER_POINT_SIZE);
      gl.uniform3f(this.uColor, MARKER_COLOR[0], MARKER_COLOR[1], MARKER_COLOR[2]);
      this.bindVertexLayout(gl, this.markerBuffer);
      gl.drawArrays(gl.POINTS, 0, 1);
    }

    // restore shared state for subsequent style layers
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private bindVertexLayout(gl: WebGLRenderingContext | WebGL2RenderingContext, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(this.aAlpha);
    gl.vertexAttribPointer(this.aAlpha, 1, gl.FLOAT, false, STRIDE, 3 * Float32Array.BYTES_PER_ELEMENT);
  }

  // Dashed-line approximation (no geometry shaders needed): below the horizon, split
  // the pin->marker segment into alternating on/off pieces via gl.LINES (each vertex
  // pair is a disconnected segment) instead of one continuous gl.LINE_STRIP segment.
  private buildRayVertices(
    pinMc: { x: number; y: number; z: number },
    markerMc: { x: number; y: number; z: number },
    alpha: number,
    solid: boolean,
  ): Float32Array {
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const point = (t: number) => ({
      x: lerp(pinMc.x, markerMc.x, t),
      y: lerp(pinMc.y, markerMc.y, t),
      z: lerp(pinMc.z, markerMc.z, t),
    });
    if (solid) {
      const a = point(0);
      const b = point(1);
      return new Float32Array([a.x, a.y, a.z, alpha, b.x, b.y, b.z, alpha]);
    }
    const out: number[] = [];
    for (let i = 0; i < DASH_SEGMENTS; i += 2) {
      const a = point(i / DASH_SEGMENTS);
      const b = point((i + 1) / DASH_SEGMENTS);
      out.push(a.x, a.y, a.z, alpha, b.x, b.y, b.z, alpha);
    }
    return new Float32Array(out);
  }

  private rebuildArc(solarDay: SolarDay): void {
    const gl = this.gl;
    if (!gl || !this.arcBuffer) return;
    const samples = solarDay.samples;
    const data = new Float32Array(samples.length * 4);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const p = domePoint(this.pin.lat, this.pin.lng, s.altitude, s.azimuth, DOME_RADIUS_M);
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: p.lng, lat: p.lat }, p.altitudeM);
      data[i * 4] = mc.x;
      data[i * 4 + 1] = mc.y;
      data[i * 4 + 2] = mc.z;
      data[i * 4 + 3] = s.altitude >= 0 ? 1.0 : ARC_NIGHT_ALPHA;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.arcVertexCount = samples.length;
  }

  private buildGlObjects(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    this.aPos = gl.getAttribLocation(program, 'a_pos');
    this.aAlpha = gl.getAttribLocation(program, 'a_alpha');
    this.uMatrix = gl.getUniformLocation(program, 'u_matrix');
    this.uColor = gl.getUniformLocation(program, 'u_color');
    this.uPointSize = gl.getUniformLocation(program, 'u_pointSize');
    this.arcBuffer = gl.createBuffer();
    this.rayBuffer = gl.createBuffer();
    this.markerBuffer = gl.createBuffer();
    // A solarDay may already be known (e.g. context restore); re-tessellate against the fresh GL objects.
    if (this.solarDay) this.rebuildArc(this.solarDay);
  }

  // NFR-5.3: MapLibre itself already calls preventDefault() on the underlying
  // 'webglcontextlost' DOM event (it owns the canvas/context) so the browser will
  // offer a restore; we only need to pause our own draw calls and rebuild our own
  // GL objects afterward — nothing here is GPU-only, solarDay is CPU-side memoized state.
  private handleContextLost = (): void => {
    this.contextLost = true;
  };

  private handleContextRestored = (): void => {
    if (this.gl) this.buildGlObjects(this.gl);
    this.contextLost = false;
    this.map?.triggerRepaint();
  };

  // --- reverse-drag raycasting (FR-3.1.1, Technical Architecture §5.3) ---

  private projectDome(altitudeDeg: number, azimuthDeg: number, canvasW: number, canvasH: number): { x: number; y: number } | null {
    const p = domePoint(this.pin.lat, this.pin.lng, altitudeDeg, azimuthDeg, DOME_RADIUS_M);
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: p.lng, lat: p.lat }, p.altitudeM);
    const clip = projectToClip(this.lastMatrix, mc.x, mc.y, mc.z);
    return clipToScreen(clip, canvasW, canvasH);
  }

  private handleDown = (e: MapMouseEvent | MapTouchEvent): void => {
    if (this.dragging || !this.solarDay || !this.map || !this.haveMatrix) return;
    if (this.solarDay.polar === 'polar-night') return; // FR-3.4: no reverse-drag on polar night
    const state = this.store.getState();
    const sun = getSunPosition(state.time.epochMs, this.pin.lat, this.pin.lng);
    const canvas = this.map.getCanvas();
    const screen = this.projectDome(sun.altitude, sun.azimuth, canvas.clientWidth, canvas.clientHeight);
    if (!screen) return;
    const dx = e.point.x - screen.x;
    const dy = e.point.y - screen.y;
    if (dx * dx + dy * dy > HIT_RADIUS_PX * HIT_RADIUS_PX) return;

    e.preventDefault(); // stop the map's own drag-pan/rotate from starting
    this.dragging = true;
    this.onDragChange(true);
    canvas.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.dragging || !this.solarDay || !this.map) return;
    const canvas = this.map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const epochMs = this.raycastToEpoch(px, py, canvas.clientWidth, canvas.clientHeight);
    if (epochMs != null) {
      this.store.dispatch({ type: 'SET_TIME', epochMs, origin: 'map' }); // FR-3.5/13.2: disengages Live via PAUSING_ORIGINS
    }
  };

  private handlePointerUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.onDragChange(false);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    if (this.map) this.map.getCanvas().style.cursor = '';
    this.urlSync.commit(); // FR-8.4: discrete commit point at dragEnd
  };

  private teardownPointerDrag(): void {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.dragging = false;
  }

  // Nearest memoized sample by 2D screen distance, then ternary-refine between its
  // neighbors for sub-sample precision — O(samples) per move, robust at any pitch/bearing
  // since it never needs true 3D ray/arc intersection (Technical Architecture §5.3).
  private raycastToEpoch(px: number, py: number, canvasW: number, canvasH: number): number | null {
    const samples = this.solarDay!.samples;
    if (samples.length === 0) return null;
    const distAt = (epochMs: number): number => {
      const sun = getSunPosition(epochMs, this.pin.lat, this.pin.lng);
      const s = this.projectDome(sun.altitude, sun.azimuth, canvasW, canvasH);
      if (!s) return Infinity;
      const dx = s.x - px;
      const dy = s.y - py;
      return dx * dx + dy * dy;
    };
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const d = distAt(samples[i].epochMs);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    let lo = samples[Math.max(0, bestIdx - 1)].epochMs;
    let hi = samples[Math.min(samples.length - 1, bestIdx + 1)].epochMs;
    for (let i = 0; i < 24 && hi - lo > 1000; i++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (distAt(m1) <= distAt(m2)) hi = m2;
      else lo = m1;
    }
    return Math.round((lo + hi) / 2);
  }
}

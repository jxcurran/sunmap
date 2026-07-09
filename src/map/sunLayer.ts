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

// Point program: used only for the single sun-marker dot (gl.POINTS + gl_PointSize is
// reliably respected across browsers, unlike gl.lineWidth() — see the ribbon program
// below for why the arc/ray need real geometry instead).
const POINT_VERTEX_SRC = `
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

// Ribbon program: renders the arc/ray as a screen-space-constant-width triangle strip.
// gl.lineWidth() is not a usable option here — WebGL only requires implementations to
// support width 1, and every ANGLE-backed browser (Chrome/Edge on Windows and Linux,
// all browsers on Android) clamps it to 1px regardless of what's requested, so no
// tuning of that value could ever have produced a visibly thicker line. Real triangle
// geometry, extruded perpendicular to each vertex's screen-space tangent, is the only
// robust cross-browser way to get a thick line. `a_next` is the neighboring point (in
// the same world space as `a_pos`) used to derive that tangent — always the "forward"
// neighbor along the line (linearly extrapolated past the last point) so the tangent
// direction never flips sign partway along a strip.
const RIBBON_VERTEX_SRC = `
attribute vec3 a_pos;
attribute vec3 a_next;
attribute float a_side;
attribute float a_alpha;
uniform mat4 u_matrix;
uniform vec2 u_resolution;
uniform float u_width;
varying float v_alpha;
void main() {
  vec4 clipA = u_matrix * vec4(a_pos, 1.0);
  vec4 clipB = u_matrix * vec4(a_next, 1.0);
  vec2 ndcA = clipA.xy / clipA.w;
  vec2 ndcB = clipB.xy / clipB.w;
  vec2 screenDir = (ndcB - ndcA) * u_resolution;
  float len = length(screenDir);
  vec2 dir = len > 0.0001 ? screenDir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 offsetPx = normal * (u_width * 0.5) * a_side;
  vec2 offsetNdc = (offsetPx / u_resolution) * 2.0;
  gl_Position = vec4(clipA.xy + offsetNdc * clipA.w, clipA.z, clipA.w);
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
const DASH_SEGMENTS = 8; // below-horizon ray: alternating on/off pieces approximate a dashed line
const ARC_WIDTH_PX = 2.5;
const RAY_WIDTH_PX = 3;

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

const POINT_STRIDE = 4 * Float32Array.BYTES_PER_ELEMENT; // x,y,z,alpha
const RIBBON_STRIDE = 8 * Float32Array.BYTES_PER_ELEMENT; // x,y,z, nx,ny,nz, side, alpha

interface RibbonPoint {
  pos: [number, number, number];
  alpha: number;
}

/** Two vertices (side=+1,-1) per input point, tangent taken from the forward neighbor
 * (linearly extrapolated past the last point) so direction sign is consistent along
 * the whole strip — see RIBBON_VERTEX_SRC's comment for why that consistency matters. */
function buildRibbon(points: RibbonPoint[]): Float32Array {
  const n = points.length;
  const out = new Float32Array(n * 2 * 8);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = points[i].pos;
    let nx: number;
    let ny: number;
    let nz: number;
    if (i < n - 1) {
      [nx, ny, nz] = points[i + 1].pos;
    } else {
      const [px, py, pz] = points[Math.max(0, n - 2)].pos;
      nx = x + (x - px);
      ny = y + (y - py);
      nz = z + (z - pz);
    }
    const alpha = points[i].alpha;
    for (const side of [1, -1]) {
      out[o++] = x;
      out[o++] = y;
      out[o++] = z;
      out[o++] = nx;
      out[o++] = ny;
      out[o++] = nz;
      out[o++] = side;
      out[o++] = alpha;
    }
  }
  return out;
}

export class SunLayer implements CustomLayerInterface {
  id = 'sun-path-layer';
  type = 'custom' as const;
  renderingMode = '3d' as const; // shares the depth buffer with buildings (occlusion, requirement 4)

  private store: Store;
  private urlSync: UrlSync;
  private onDragChange: (dragging: boolean) => void;

  private map: MapLibreMap | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  private pointProgram: WebGLProgram | null = null;
  private pAPos = -1;
  private pAAlpha = -1;
  private pUMatrix: WebGLUniformLocation | null = null;
  private pUColor: WebGLUniformLocation | null = null;
  private pUPointSize: WebGLUniformLocation | null = null;

  private ribbonProgram: WebGLProgram | null = null;
  private rAPos = -1;
  private rANext = -1;
  private rASide = -1;
  private rAAlpha = -1;
  private rUMatrix: WebGLUniformLocation | null = null;
  private rUColor: WebGLUniformLocation | null = null;
  private rUResolution: WebGLUniformLocation | null = null;
  private rUWidth: WebGLUniformLocation | null = null;

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
    if (this.pointProgram) gl.deleteProgram(this.pointProgram);
    if (this.ribbonProgram) gl.deleteProgram(this.ribbonProgram);
    if (this.arcBuffer) gl.deleteBuffer(this.arcBuffer);
    if (this.rayBuffer) gl.deleteBuffer(this.rayBuffer);
    if (this.markerBuffer) gl.deleteBuffer(this.markerBuffer);
    this.pointProgram = this.ribbonProgram = null;
    this.arcBuffer = this.rayBuffer = this.markerBuffer = null;
  }

  // `matrix` is typed as the broad structural shape MapLibre's `mat4` (gl-matrix) can
  // take (plain array or any indexed/iterable numeric collection) — using `ArrayLike`
  // here (rather than importing gl-matrix's own type from a transitive dependency)
  // keeps the override signature compatible without a direct dependency on gl-matrix.
  render(gl: WebGLRenderingContext | WebGL2RenderingContext, matrix: ArrayLike<number>): void {
    this.lastMatrix.set(matrix);
    this.haveMatrix = true;
    if (this.contextLost || !this.ribbonProgram || !this.pointProgram || !this.solarDay) return;

    const state = this.store.getState();
    const sun = getSunPosition(state.time.epochMs, this.pin.lat, this.pin.lng);
    const fade = fadeFactor(sun.altitude);
    const alpha = XRAY_ALPHA_FLOOR + (1 - XRAY_ALPHA_FLOOR) * fade;
    // Alpha crossfades smoothly over the ±2° band (FR-14.3), but depth-test/dash mode
    // toggles at the exact horizon — an acceptable simplification since alpha is
    // already partway through its fade right at that crossing, masking the switch.
    const aboveHorizon = sun.altitude >= 0;
    const resolution: [number, number] = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    // u_resolution is in device pixels (drawingBuffer size); widths below are authored
    // in CSS pixels, so scale by devicePixelRatio to keep the visual width consistent
    // across screens instead of getting thinner on high-DPI displays.
    const dpr = window.devicePixelRatio || 1;

    gl.depthMask(false); // thin lines/points shouldn't punch holes in the shared depth buffer for later layers

    // --- static trajectory arc: always normal depth test; per-vertex alpha already
    // dims the below-horizon half (baked at build time in rebuildArc). ---
    if (this.arcVertexCount > 1 && this.arcBuffer) {
      gl.useProgram(this.ribbonProgram);
      gl.uniformMatrix4fv(this.rUMatrix, false, this.lastMatrix);
      gl.uniform2f(this.rUResolution, resolution[0], resolution[1]);
      gl.uniform1f(this.rUWidth, ARC_WIDTH_PX * dpr);
      gl.enable(gl.DEPTH_TEST);
      gl.uniform3f(this.rUColor, ARC_COLOR[0], ARC_COLOR[1], ARC_COLOR[2]);
      this.bindRibbonLayout(gl, this.arcBuffer);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.arcVertexCount * 2);
    }

    // --- azimuth ray + sun marker: x-ray mode below horizon (FR-14.1a) — depth test
    // disabled and dashed/reduced-alpha so it stays visible & draggable through buildings. ---
    const marker = domePoint(this.pin.lat, this.pin.lng, sun.altitude, sun.azimuth, DOME_RADIUS_M);
    const markerMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: marker.lng, lat: marker.lat }, marker.altitudeM);
    const pinMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: this.pin.lng, lat: this.pin.lat }, 0);

    if (aboveHorizon) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);

    const raySegments = this.buildRaySegments(pinMc, markerMc, alpha, aboveHorizon);
    if (this.rayBuffer && raySegments.length > 0) {
      gl.useProgram(this.ribbonProgram);
      gl.uniformMatrix4fv(this.rUMatrix, false, this.lastMatrix);
      gl.uniform2f(this.rUResolution, resolution[0], resolution[1]);
      gl.uniform1f(this.rUWidth, RAY_WIDTH_PX * dpr);
      gl.uniform3f(this.rUColor, ARC_COLOR[0], ARC_COLOR[1], ARC_COLOR[2]);
      const merged = new Float32Array(raySegments.length * 16); // 4 verts * 8 floats per 2-point segment
      let o = 0;
      for (const seg of raySegments) {
        merged.set(seg, o);
        o += seg.length;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.rayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, merged, gl.DYNAMIC_DRAW);
      this.bindRibbonLayout(gl, this.rayBuffer);
      for (let i = 0; i < raySegments.length; i++) {
        gl.drawArrays(gl.TRIANGLE_STRIP, i * 4, 4);
      }
    }

    if (this.markerBuffer) {
      gl.useProgram(this.pointProgram);
      gl.uniformMatrix4fv(this.pUMatrix, false, this.lastMatrix);
      const markerVerts = new Float32Array([markerMc.x, markerMc.y, markerMc.z, alpha]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.markerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, markerVerts, gl.DYNAMIC_DRAW);
      gl.uniform1f(this.pUPointSize, MARKER_POINT_SIZE);
      gl.uniform3f(this.pUColor, MARKER_COLOR[0], MARKER_COLOR[1], MARKER_COLOR[2]);
      this.bindPointLayout(gl, this.markerBuffer);
      gl.drawArrays(gl.POINTS, 0, 1);
    }

    // restore shared state for subsequent style layers
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private bindPointLayout(gl: WebGLRenderingContext | WebGL2RenderingContext, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(this.pAPos);
    gl.vertexAttribPointer(this.pAPos, 3, gl.FLOAT, false, POINT_STRIDE, 0);
    gl.enableVertexAttribArray(this.pAAlpha);
    gl.vertexAttribPointer(this.pAAlpha, 1, gl.FLOAT, false, POINT_STRIDE, 3 * Float32Array.BYTES_PER_ELEMENT);
  }

  private bindRibbonLayout(gl: WebGLRenderingContext | WebGL2RenderingContext, buffer: WebGLBuffer): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(this.rAPos);
    gl.vertexAttribPointer(this.rAPos, 3, gl.FLOAT, false, RIBBON_STRIDE, 0);
    gl.enableVertexAttribArray(this.rANext);
    gl.vertexAttribPointer(this.rANext, 3, gl.FLOAT, false, RIBBON_STRIDE, 3 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(this.rASide);
    gl.vertexAttribPointer(this.rASide, 1, gl.FLOAT, false, RIBBON_STRIDE, 6 * Float32Array.BYTES_PER_ELEMENT);
    gl.enableVertexAttribArray(this.rAAlpha);
    gl.vertexAttribPointer(this.rAAlpha, 1, gl.FLOAT, false, RIBBON_STRIDE, 7 * Float32Array.BYTES_PER_ELEMENT);
  }

  // Dashed-line approximation (no geometry shaders needed): below the horizon, split
  // the pin->marker segment into alternating on/off pieces, each its own tiny 2-point
  // ribbon (drawn as a separate TRIANGLE_STRIP call — cheap, at most 4 segments).
  private buildRaySegments(
    pinMc: { x: number; y: number; z: number },
    markerMc: { x: number; y: number; z: number },
    alpha: number,
    solid: boolean,
  ): Float32Array[] {
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const point = (t: number): [number, number, number] => [
      lerp(pinMc.x, markerMc.x, t),
      lerp(pinMc.y, markerMc.y, t),
      lerp(pinMc.z, markerMc.z, t),
    ];
    if (solid) {
      return [buildRibbon([{ pos: point(0), alpha }, { pos: point(1), alpha }])];
    }
    const out: Float32Array[] = [];
    for (let i = 0; i < DASH_SEGMENTS; i += 2) {
      const a = point(i / DASH_SEGMENTS);
      const b = point((i + 1) / DASH_SEGMENTS);
      out.push(buildRibbon([{ pos: a, alpha }, { pos: b, alpha }]));
    }
    return out;
  }

  private rebuildArc(solarDay: SolarDay): void {
    const gl = this.gl;
    if (!gl || !this.arcBuffer) return;
    const samples = solarDay.samples;
    const points: RibbonPoint[] = samples.map((s) => {
      const p = domePoint(this.pin.lat, this.pin.lng, s.altitude, s.azimuth, DOME_RADIUS_M);
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: p.lng, lat: p.lat }, p.altitudeM);
      return { pos: [mc.x, mc.y, mc.z], alpha: s.altitude >= 0 ? 1.0 : ARC_NIGHT_ALPHA };
    });
    const data = buildRibbon(points);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.arcVertexCount = samples.length;
  }

  private buildGlObjects(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    const pointVs = compileShader(gl, gl.VERTEX_SHADER, POINT_VERTEX_SRC);
    const ribbonVs = compileShader(gl, gl.VERTEX_SHADER, RIBBON_VERTEX_SRC);
    const fs1 = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const fs2 = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);

    const pointProgram = linkProgram(gl, pointVs, fs1);
    const ribbonProgram = linkProgram(gl, ribbonVs, fs2);
    gl.deleteShader(pointVs);
    gl.deleteShader(ribbonVs);
    gl.deleteShader(fs1);
    gl.deleteShader(fs2);

    this.pointProgram = pointProgram;
    this.pAPos = gl.getAttribLocation(pointProgram, 'a_pos');
    this.pAAlpha = gl.getAttribLocation(pointProgram, 'a_alpha');
    this.pUMatrix = gl.getUniformLocation(pointProgram, 'u_matrix');
    this.pUColor = gl.getUniformLocation(pointProgram, 'u_color');
    this.pUPointSize = gl.getUniformLocation(pointProgram, 'u_pointSize');

    this.ribbonProgram = ribbonProgram;
    this.rAPos = gl.getAttribLocation(ribbonProgram, 'a_pos');
    this.rANext = gl.getAttribLocation(ribbonProgram, 'a_next');
    this.rASide = gl.getAttribLocation(ribbonProgram, 'a_side');
    this.rAAlpha = gl.getAttribLocation(ribbonProgram, 'a_alpha');
    this.rUMatrix = gl.getUniformLocation(ribbonProgram, 'u_matrix');
    this.rUColor = gl.getUniformLocation(ribbonProgram, 'u_color');
    this.rUResolution = gl.getUniformLocation(ribbonProgram, 'u_resolution');
    this.rUWidth = gl.getUniformLocation(ribbonProgram, 'u_width');

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

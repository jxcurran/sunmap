// NFR-1.7 quality degradation ladder + NFR-1.8 visibility suspend + NFR-1.9 telemetry hook.
// p95 frame time is approximated over a rolling window of the last ~180 frames (not a true
// timestamped 10s sliding window) — sufficient to detect sustained degradation without the
// bookkeeping of exact interval percentiles; ponytail: upgrade if audit precision demands it.
import type { QualityTier } from '../types';

const TIERS: QualityTier[] = ['Q0', 'Q1', 'Q2', 'Q3'];
const STEP_DOWN_MS = 10_000;
const STEP_UP_MS = 60_000;
const WINDOW_SIZE = 180;

export interface QualityMonitor {
  start(): void;
  suspend(): void;
  resume(): void;
  getTier(): QualityTier;
}

export function createQualityMonitor(opts: {
  onTierChange: (tier: QualityTier) => void;
  onFrame?: (frameTimeMs: number) => void; // NFR-1.9
}): QualityMonitor {
  let tierIndex = 0;
  let frameTimes: number[] = [];
  let lastFrame = performance.now();
  let lowSince: number | null = null;
  let highSince: number | null = null;
  let rafId: number | null = null;
  let suspended = false;

  function p95Fps(): number {
    if (frameTimes.length < 10) return 60;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const p95FrameTime = sorted[Math.floor(sorted.length * 0.95)];
    return 1000 / p95FrameTime;
  }

  function tick(now: number) {
    const dt = now - lastFrame;
    lastFrame = now;
    frameTimes.push(dt);
    if (frameTimes.length > WINDOW_SIZE) frameTimes.shift();
    opts.onFrame?.(dt);

    const fps = p95Fps();
    if (fps < 30) {
      lowSince ??= now;
      highSince = null;
      if (now - lowSince >= STEP_DOWN_MS && tierIndex < TIERS.length - 1) {
        tierIndex++;
        opts.onTierChange(TIERS[tierIndex]);
        lowSince = null;
        frameTimes = [];
      }
    } else if (fps > 45) {
      highSince ??= now;
      lowSince = null;
      if (now - highSince >= STEP_UP_MS && tierIndex > 0) {
        tierIndex--;
        opts.onTierChange(TIERS[tierIndex]);
        highSince = null;
        frameTimes = [];
      }
    } else {
      lowSince = null;
      highSince = null;
    }

    if (!suspended) rafId = requestAnimationFrame(tick);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) monitor.suspend();
    else monitor.resume();
  });

  const monitor: QualityMonitor = {
    start() {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    suspend() {
      suspended = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      lastFrame = performance.now();
      frameTimes = [];
      rafId = requestAnimationFrame(tick);
    },
    getTier() {
      return TIERS[tierIndex];
    },
  };
  return monitor;
}

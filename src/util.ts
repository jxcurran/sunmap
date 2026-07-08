export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Trailing-edge throttle: at most one call per `ms`, but the last call in a burst
// always fires (used for the <=4Hz URL replaceState cadence, Technical Architecture §2.5).
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  return (...args: A) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = undefined;
          const p = pending;
          pending = null;
          if (p) fn(...p);
        }, remaining);
      }
    }
  };
}

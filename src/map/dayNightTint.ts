// FR-1.4/1.4.1: map style shall default to matching app time (dark at night, light in
// day), with a toggle to instead track the selected location's real-world local time.
//
// OpenFreeMap only ships liberty/bright/positron (no dark preset) — rather than load a
// second full vector style, we keep one `liberty` style loaded and overlay a
// semi-transparent tint div with mix-blend-mode, toggled by a binary day/night check.
// FR-1.4 doesn't require continuous gradient interpolation, so a binary swap recomputed
// on relevant state changes (and a coarse 60s timer for 'real-time' mode drift, since
// that mode tracks the wall clock even while paused/idle) is sufficient.
export function createTintOverlay(container: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;inset:0;pointer-events:none;background:rgba(8,12,28,0.45);' +
    'mix-blend-mode:multiply;opacity:0;transition:opacity 400ms ease;z-index:1;';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(el);
  return el;
}

export function setNight(el: HTMLDivElement, isNight: boolean): void {
  el.style.opacity = isNight ? '1' : '0';
}

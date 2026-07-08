// NFR-5.2: probe for WebGL before even attempting to construct MapLibre.
export function hasWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function renderUnsupportedMessage(container: HTMLElement): void {
  container.textContent = "3D map requires WebGL, which isn't available in this browser.";
  container.style.cssText += 'display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;';
}

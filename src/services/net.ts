// NFR-2.5/2.6: offline indicator + constrained-connection signal for tile prefetch tuning.
export function isOnline(): boolean {
  return navigator.onLine;
}

export function onNetChange(cb: (online: boolean) => void): () => void {
  const on = () => cb(true);
  const off = () => cb(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}

interface NavigatorConnection {
  saveData?: boolean;
  effectiveType?: string;
}

export function isConstrainedConnection(): boolean {
  const nav = navigator as Navigator & { connection?: NavigatorConnection };
  const conn = nav.connection;
  if (!conn) return false;
  return Boolean(conn.saveData) || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
}

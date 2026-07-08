// NFR-2.1/2.2: explicit timeouts, exponential backoff with jitter (base 500ms, factor 2,
// max 3 attempts). Retries only network-level failures/timeouts and 5xx/429 — 4xx is terminal.
export class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url: string, opts: { timeoutMs: number; signal: AbortSignal; attempts?: number }): Promise<Response> {
  const { timeoutMs, signal, attempts = 3 } = opts;
  let delay = 500;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeoutCtrl = new AbortController();
    const onAbort = () => timeoutCtrl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: timeoutCtrl.signal });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(delay + Math.random() * delay);
        delay *= 2;
        continue;
      }
      throw new HttpError(res.status);
    } catch (err) {
      if (signal.aborted) throw err; // superseded by newer intent (NFR-2.3) — no retry
      if (err instanceof HttpError) throw err; // non-retryable 4xx
      if (attempt < attempts) {
        await sleep(delay + Math.random() * delay);
        delay *= 2;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  throw new Error('unreachable');
}

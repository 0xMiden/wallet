// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/circle-http.server.ts (MIT).
import { fetchBoundedJson } from 'lib/remote-json';

/** Public configured Circle endpoints only; no portal deployment, credentials or raw provider diagnostics. */
export async function postCircleJson(url: string, body: unknown, timeoutMs = 15000): Promise<unknown> {
  try {
    return await fetchBoundedJson(
      (endpoint, init) => fetch(endpoint, {
        ...init,
        method: 'POST',
        redirect: 'error',
        headers: { ...init.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
      url,
      { maxBytes: 262144, timeoutMs }
    );
  } catch {
    throw new Error('Circle request unavailable');
  }
}

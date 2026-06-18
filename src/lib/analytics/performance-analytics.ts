import { PerformanceTimings } from 'lib/miden/analytics-types';

export const PERFORMANCE_STORAGE_KEY = 'performance_analytics';

export function setLastPerformanceSent(sent: number) {
  try {
    localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(sent));
  } catch {}
}

export function getLastPerformanceSent() {
  const stored = localStorage.getItem(PERFORMANCE_STORAGE_KEY);
  return stored ? (JSON.parse(stored) as number) : 0;
}

export const MIN_RECORDS_FOR_PERFORMANCE_ANALYTICS = 1000;

export async function sendScanPerformanceEvent(
  _event: string,
  _timings: PerformanceTimings,
  _additionalProperties = {}
) {
  const analytics = localStorage.getItem('analytics');
  if (analytics) {
    const analyticsState = JSON.parse(analytics);
    if (analyticsState.userId && analyticsState.enabled) {
      const lastSent = getLastPerformanceSent();
      if (Date.now() - lastSent > 1000 * 60 * 60 * 24 * 7) {
        // 7 days
        try {
          setLastPerformanceSent(Date.now());
        } catch {
          console.warn('Failed to send performance event');
        }
      }
    }
  }
}

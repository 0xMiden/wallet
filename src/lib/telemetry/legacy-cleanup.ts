/**
 * The removed `src/lib/analytics/` scaffold seeded `localStorage['analytics']`
 * with a `nanoid()` userId that persisted for the life of the install. Deleting
 * the code does not delete the data, so every existing install still carries a
 * dormant long-lived identifier that nothing owns. Clear it at startup.
 */
const LEGACY_ANALYTICS_KEY = 'analytics';

export function clearLegacyAnalyticsStorage(): void {
  try {
    localStorage.removeItem(LEGACY_ANALYTICS_KEY);
  } catch {
    // A storage failure here is not worth failing startup over; the next
    // launch retries.
  }
}

/**
 * No-op teardown — we deliberately leave simulators booted between runs to
 * skip the ~30s cold-boot cost. The reserved pair persists in
 * `test-results-ios/.device-pair.json`. Wipe manually with `simctl erase`
 * if a clean slate is needed.
 */
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty.
}

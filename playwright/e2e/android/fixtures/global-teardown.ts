/**
 * No-op teardown — emulators stay booted between runs (same strategy as
 * iOS). The reserved pair persists in `test-results-android/.device-pair.json`.
 * Wipe manually via `adb emu kill` if a clean slate is needed.
 */
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty.
}

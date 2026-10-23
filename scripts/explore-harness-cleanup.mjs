/**
 * Closes the explore-config harness browser, then deletes the temporary Chromium
 * profile it created. The harness runs on import, so this lives in its own module.
 * The directory is removed only after close settles, including when close rejects.
 */
import { rmSync } from 'node:fs';

export async function closeExploreHarness(context, profile) {
  try {
    await context?.close();
  } finally {
    if (profile !== undefined) {
      rmSync(profile, { recursive: true, force: true });
    }
  }
}

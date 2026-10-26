import type { UpdatePlatform, UpdateUrgency } from './manifest';

export type UpdateAvailability =
  | {
      status: 'available';
      currentVersion: string;
      availableVersion: string;
      action: () => Promise<void>;
    }
  | { status: 'none'; currentVersion: string }
  | { status: 'unknown'; currentVersion?: string };

export interface UpdateAvailabilityAdapter {
  platform: UpdatePlatform;
  check(): Promise<UpdateAvailability>;
  /**
   * Ask the platform to look again because the catalog names a newer build.
   * The adapter decides whether a hint is due before `loadCandidate` runs, so a
   * throttled hint costs no metadata fetch, and it is never awaited by a check.
   */
  hintAvailableVersion?(loadCandidate: () => Promise<string | null>): Promise<void>;
}

export interface UpdateNotice {
  platform: UpdatePlatform;
  currentVersion: string;
  availableVersion: string;
  summary: string | null;
  urgency: UpdateUrgency;
  action: () => Promise<void>;
}

/**
 * What a check concluded. `unknown` is not `none`: the platform could not
 * answer, so a notice it confirmed earlier stays on screen.
 */
export type UpdateCheckResult =
  | { status: 'available'; notice: UpdateNotice }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Why the wallet is re-checking. A foreground reuses the cached answer; a
 * platform event (the service worker saw Chrome announce an update) is new
 * information and supersedes it.
 */
export type UpdateRefreshReason = 'foreground' | 'platform';

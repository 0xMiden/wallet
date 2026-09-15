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
}

export interface UpdateNotice {
  platform: UpdatePlatform;
  currentVersion: string;
  availableVersion: string;
  summary: string | null;
  urgency: UpdateUrgency;
  action: () => Promise<void>;
}

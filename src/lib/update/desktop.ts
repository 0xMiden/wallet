import type { UpdateAvailability, UpdateAvailabilityAdapter } from './types';

export class DesktopUpdateAdapter implements UpdateAvailabilityAdapter {
  readonly platform = 'desktop' as const;

  async check(): Promise<UpdateAvailability> {
    return { status: 'unknown' };
  }
}

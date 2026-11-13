import type { PlatformUnlockState } from 'lib/platform-auth/types';

const unavailable: PlatformUnlockState = { available: false, hasPassword: false, credential: null };

export function usePlatformUnlock() {
  return { state: unavailable, loading: false, refresh: async () => undefined };
}

import { createPersistedSetting } from 'lib/settings/persisted-setting';

const DEFAULT_VALUE = true;

export const getIsLockUpEnabled = () => {
  return DEFAULT_VALUE;
};

export type BackgroundLockDelay = '1' | '5' | '10' | '30';

export const BACKGROUND_LOCK_DELAYS: readonly BackgroundLockDelay[] = ['1', '5', '10', '30'];

// The extension auto-locks after WALLET_AUTOLOCK_TIME, so the apps start from the same 10 minutes. There is no
// "never" or "immediately": a minute keeps a Face ID prompt or a share sheet from locking the wallet.
export const backgroundLockDelay = createPersistedSetting<BackgroundLockDelay>(
  'background_lock_delay_setting',
  BACKGROUND_LOCK_DELAYS,
  '10'
);

export function backgroundLockDelayMs(delay: BackgroundLockDelay): number {
  return Number(delay) * 60_000;
}

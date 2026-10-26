// Only platform/backend boundaries are replaced. Unlock, Input, Button, icons, fonts and CSS are real.
// No extension API, wallet, browser storage, telemetry or network request is used by this fixture.
import React, { useCallback, useState } from 'react';

export { MIDEN_NETWORK_NAME } from '../../../src/lib/miden-chain/networks-config';
export const DEFAULT_NETWORK = 'mainnet';

export enum MidenSharedStorageKey {
  PasswordAttempts = 'PasswordAttempts',
  TimeLock = 'TimeLock'
}

const params = new URLSearchParams(window.location.search);
const stored = new Map<string, number>(
  params.has('locked')
    ? [
        [MidenSharedStorageKey.PasswordAttempts, 3],
        [MidenSharedStorageKey.TimeLock, Date.now()]
      ]
    : []
);

export function readLocalStorage(key: string, fallback: number): number {
  return stored.get(key) ?? fallback;
}

export function writeLocalStorage(key: string, value: number): boolean {
  stored.set(key, value);
  return true;
}

export function useLocalStorage(key: string, fallback: number): [number, (next: number) => void] {
  const [value, setValue] = useState(() => readLocalStorage(key, fallback));
  const set = useCallback(
    (next: number) => {
      writeLocalStorage(key, next);
      setValue(next);
    },
    [key]
  );
  return [value, set];
}

const unlock = (): Promise<void> =>
  params.has('loading') ? new Promise(() => {}) : Promise.reject(new Error('Synthetic incorrect password'));
export const useMidenContext = () => ({ unlock });
export const isExtension = () => true;
export const isMobile = () => false;
export const isDesktop = () => false;
export const useAppEnv = () => ({ compact: true });
export const openInFullPage = () => undefined;
export const navigate = () => undefined;
export const useUserVisibleError = () => undefined;
export const hapticLight = () => undefined;
export const hapticError = () => undefined;
export const hasHardwareKey = async () => false;
export const checkBiometricAvailability = async () => ({ biometryType: 'none' });
export const Vault = { hasPasswordProtector: async () => true };
export const PasscodeScreen = () => null;
export default function UnusedLayout({ children }: React.PropsWithChildren) {
  return <>{children}</>;
}

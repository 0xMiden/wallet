import React from 'react';

const params = new URLSearchParams(location.search);
const mode = params.get('result');
const context = {
  ready: true,
  storageAvailability: { status: 'unavailable', epoch: 1 },
  recoverWalletStorage: async () => {
    if (mode === 'loading') return new Promise(() => undefined);
    if (mode === 'error') throw new Error('fixture failure');
    return { recovered: false };
  },
  exportRecoveryDataFile: async () => '{"fixture":"encrypted"}',
  importRecoveryDataFile: async () => { throw new Error('RecoveryDataFile:malformed'); },
  cancelRecoveryDataOperation: async () => undefined
};
export const useMidenContext = () => {
  const value = params.has('stable') ? context : { ...context, cancelRecoveryDataOperation: async () => undefined };
  const previous = Reflect.get(window, '__fixtureCancel');
  if (previous && previous !== value.cancelRecoveryDataOperation) {
    Reflect.set(window, '__fixtureCancelChanges', (Reflect.get(window, '__fixtureCancelChanges') ?? 0) + 1);
  }
  Reflect.set(window, '__fixtureCancel', value.cancelRecoveryDataOperation);
  return value;
};
export const useMobileBackHandler = () => undefined;
export const useHideNavbarWhileOpen = () => undefined;
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const isMobile = () => false;
export const isIOS = () => false;
export const isAndroid = () => false;
export const isExtension = () => false;
export const StrictActionAuthentication = ({ authenticatedAction, onResult }: {
  authenticatedAction: () => Promise<void>; onResult: (value: string) => void;
}) => <button type="button" onClick={() => { void authenticatedAction().then(() => onResult('authenticated')).catch(() => undefined); }}>Fixture authentication</button>;

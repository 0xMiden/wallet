import React from 'react';
export const useMidenContext = () => ({
  storageAvailability: { status: 'unavailable', epoch: 1 }, ready: true,
  recoverWalletStorage: async () => ({ recovered: true }),
  exportRecoveryDataFile: async () => '{"fixture":true}',
  importRecoveryDataFile: async () => ({ imported: true }),
  cancelRecoveryDataOperation: async () => undefined,
  exportWalletBackupMaterial: async () => { throw new Error('outside fixture'); }
});
export const useMobileBackHandler = () => undefined;
export const StrictActionAuthentication = ({ authenticatedAction, onResult }: any) => <button onClick={async () => { await authenticatedAction('fixture'); onResult('authenticated'); }}>Fixture authenticate</button>;

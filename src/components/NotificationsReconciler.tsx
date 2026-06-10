import { FC } from 'react';

import { useAccount } from 'lib/miden/front';
import { useNotificationReconciler } from 'lib/miden/front/useNotificationReconciler';
import { useTransactionNotificationWatcher } from 'lib/miden/front/useTransactionNotificationWatcher';

/**
 * Null-rendering component that keeps the persisted notification center in
 * sync with the current account's claimable notes and terminal-status
 * transactions on all platforms.
 */
export const NotificationsReconciler: FC = () => {
  const account = useAccount();
  useNotificationReconciler(account.publicKey);
  useTransactionNotificationWatcher(account.publicKey);
  return null;
};

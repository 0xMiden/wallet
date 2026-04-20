import React, { FC, useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { showExtensionNotification } from 'lib/extension/notifications';
import { useAccount } from 'lib/miden/front';
import { useNoteToastMonitor } from 'lib/miden/front/useNoteToast';
import { initNativeNotifications, showNoteReceivedNotification } from 'lib/mobile/native-notifications';
import { isExtension, isMobile } from 'lib/platform';
import { useWalletStore } from 'lib/store';

/**
 * Provider component that monitors for new notes and displays notifications.
 * Active on both mobile (native notifications) and extension (desktop notifications).
 */
export const NoteToastProvider: FC = () => {
  if (!isMobile() && !isExtension()) {
    return null;
  }

  return <NoteToastProviderInner />;
};

/**
 * Inner component that handles the actual notification logic.
 * On mobile: uses native local notifications.
 * On extension: uses Web Notifications API (with chrome.notifications fallback).
 */
const NoteToastProviderInner: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const isNoteToastVisible = useWalletStore(state => state.isNoteToastVisible);
  const noteToastShownAt = useWalletStore(state => state.noteToastShownAt);
  const dismissNoteToast = useWalletStore(state => state.dismissNoteToast);

  // Initialize native notifications on mount (mobile only)
  useEffect(() => {
    if (isMobile()) {
      initNativeNotifications();
    }
  }, []);

  // Monitor for new notes
  useNoteToastMonitor(account.publicKey);

  // Show notification when toast should be visible
  useEffect(() => {
    if (isNoteToastVisible && noteToastShownAt) {
      if (isMobile()) {
        showNoteReceivedNotification(t('noteReceivedTitle'), t('noteReceivedTapToClaim'));
      } else if (isExtension()) {
        showExtensionNotification(t('noteReceivedTitle'), t('noteReceivedClickToClaim'));
      }
      // Dismiss the store state since we've shown the notification
      dismissNoteToast();
    }
  }, [isNoteToastVisible, noteToastShownAt, dismissNoteToast, t]);

  // This component doesn't render anything - notifications are native/system
  return null;
};

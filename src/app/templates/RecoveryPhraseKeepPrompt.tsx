import React, { FC, Suspense, useCallback, useEffect, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { AlertSheet } from 'components/ui/AlertSheet';
import { ButtonVariant } from 'components/ui/Button';
import { putToStorage, useStorage } from 'lib/miden/front/storage';
import type { SeedPhraseStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { useAlert } from 'lib/ui/dialog';

/** The storage key that holds the public key of the account the prompt is armed for, or an empty string. */
export const RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY = 'recovery_phrase_keep_prompt';

/**
 * Arms the prompt for an account. The device-role step of the everyday key gate calls this when the user starts
 * the activation, so the prompt shows after the activation lands. The write goes through `putToStorage`, so the
 * storage hooks see the new value at once.
 */
export const armRecoveryPhraseKeepPrompt = (accountPublicKey: string): Promise<void> =>
  putToStorage(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, accountPublicKey);

const clearRecoveryPhraseKeepPrompt = (): Promise<void> => putToStorage(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, '');

/**
 * After a recovery with the recovery phrase, asks once whether the phrase stays on this device.
 *
 * The prompt shows only when all of these are true: it is armed for the current account, the account has an
 * everyday key (`hotPublicKey`), no everyday key rotation is necessary, no pending-note scan runs, and the phrase
 * is stored. Daily transactions do not need the phrase, so the user can remove it. Remove removes the phrase at
 * once, with no verification step: the user typed the phrase minutes ago, so a quiz on it proves nothing. The
 * backend unlocks with the hardware protector; a failure (a password-only wallet, or transactions still running)
 * shows its message and keeps the prompt armed. Keep clears the flag. When the phrase is not stored, the prompt
 * has nothing to ask, so it clears the flag and shows nothing.
 */
export const RecoveryPhraseKeepPrompt: FC = () => {
  const currentAccount = useWalletStore(s => s.currentAccount);
  const seedPhraseStatus = useWalletStore(s => s.seedPhraseStatus);

  if (
    !currentAccount?.hotPublicKey ||
    currentAccount.requiresHotKeyRotation ||
    currentAccount.guardianNoteRecoveryPending
  ) {
    return null;
  }

  // The storage hook suspends for its first read. The fallback is empty, so the read never shows the root fallback.
  return (
    <Suspense fallback={null}>
      <RecoveryPhraseKeepSheet accountPublicKey={currentAccount.publicKey} seedPhraseStatus={seedPhraseStatus} />
    </Suspense>
  );
};

interface SheetProps {
  accountPublicKey: string;
  seedPhraseStatus?: SeedPhraseStatus;
}

const RecoveryPhraseKeepSheet: FC<SheetProps> = ({ accountPublicKey, seedPhraseStatus }) => {
  const { t } = useTranslation();
  const alert = useAlert();
  const removeSeedPhrase = useWalletStore(s => s.removeSeedPhrase);
  const [armedFor] = useStorage<string>(RECOVERY_PHRASE_KEEP_PROMPT_STORAGE_KEY, '');
  // Held from the first tap until the write ends, so a second tap does not run the action two times.
  const inFlight = useRef(false);
  const armed = armedFor === accountPublicKey;
  // The status is not known before the first state sync. Only a known status that is not `stored` clears the flag.
  const phraseGone = seedPhraseStatus !== undefined && seedPhraseStatus !== 'stored';

  useEffect(() => {
    if (!armed || !phraseGone) return;
    clearRecoveryPhraseKeepPrompt().catch(error =>
      console.warn('[RecoveryPhraseKeepPrompt] could not clear the prompt flag:', error)
    );
  }, [armed, phraseGone]);

  const answer = useCallback(
    async (removePhrase: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        if (removePhrase) {
          // The removal runs first: a failure keeps the prompt armed, so the question comes back.
          await removeSeedPhrase(undefined);
        }
        await clearRecoveryPhraseKeepPrompt();
      } catch (error) {
        console.warn('[RecoveryPhraseKeepPrompt] the answer did not apply:', error);
        const message = error instanceof Error && error.message ? error.message : t('seedRemovalFailed');
        await alert({ errorId: null, title: t('error'), children: message });
      } finally {
        inFlight.current = false;
      }
    },
    [alert, removeSeedPhrase, t]
  );

  if (!armed || seedPhraseStatus !== 'stored') return null;

  // The Button of each action gives the light haptic.
  return (
    <AlertSheet
      open
      dismissible={false}
      variant="explanation"
      title={t('keepRecoveryPhraseTitle')}
      actionLabel={t('keepRecoveryPhraseRemove')}
      actionVariant={ButtonVariant.Destructive}
      onAction={() => answer(true)}
      secondaryLabel={t('keepRecoveryPhraseKeep')}
      onSecondary={() => answer(false)}
      screenKey="recovery-phrase-keep"
      actionTestId="recovery-phrase-keep-remove"
      secondaryTestId="recovery-phrase-keep-keep"
    >
      {t('keepRecoveryPhraseBody')}
    </AlertSheet>
  );
};

export default RecoveryPhraseKeepPrompt;

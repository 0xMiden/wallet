import React, { FC, useCallback, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { AlertSheet } from 'components/ui/AlertSheet';
import { ButtonVariant } from 'components/ui/Button';
import { ListRow } from 'components/ui/ListRow';
import { useDeviceRevocation } from 'lib/miden/front/useDeviceRevocation';
import { isHotKeyRotatedOut } from 'lib/miden/guardian/sync-guard';
import { resetWalletAndReload } from 'lib/miden/reset-and-reload';
import { getExplorerTxUrl } from 'lib/miden-chain/constants';
import { hapticLight } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { useAlert, useConfirm } from 'lib/ui/dialog';

/**
 * Another device holds the current account's hot key: the persisted verdict
 * (`WalletAccount.hotKeyRotatedOut`, written by the guardian sync's cold signer
 * check and by the direct guardian switch) names the key this device still
 * uses. `isGuardianSyncBlocked` refuses every write, and the sheet holds the
 * wallet until the user picks a way forward: it cannot be dismissed (no drag,
 * outside press, Escape or mobile back), like the seed backup requirement.
 *
 * Two ways forward:
 * - Make this device the main one. Retires the stale key and flags the account
 *   for a rotation; `HotKeyRotationGate` then runs the cold-signed rotation that
 *   installs a new key here and, through its post-rotation re-register, revokes
 *   the other device. Needs the recovery (cold) key, so a hot-key-only import
 *   gets only the second option.
 * - Remove the wallet from this device: the rotation gate's own wipe back to
 *   onboarding.
 *
 * Only the current account is gated, like `HotKeyRotationGate`. The retire step
 * clears the verdict, so the sheet leaves on its own once the rotation gate takes
 * over.
 */
export const HotKeyRotatedOutGate: FC = () => {
  const currentAccount = useWalletStore(s => s.currentAccount);
  if (!currentAccount || !isHotKeyRotatedOut(currentAccount)) return null;
  // Keyed by account so switching between flagged accounts resets the busy state.
  return (
    <HotKeyRotatedOutSheet
      key={currentAccount.publicKey}
      accountPublicKey={currentAccount.publicKey}
      hotPublicKey={currentAccount.hotPublicKey ?? ''}
      canMakeMain={Boolean(currentAccount.coldPublicKey)}
    />
  );
};

interface SheetProps {
  accountPublicKey: string;
  hotPublicKey: string;
  canMakeMain: boolean;
}

const HotKeyRotatedOutSheet: FC<SheetProps> = ({ accountPublicKey, hotPublicKey, canMakeMain }) => {
  const { t } = useTranslation();
  // Read the receipt only after the Guardian verdict has confirmed revocation.
  const transactionId = useDeviceRevocation(accountPublicKey, hotPublicKey);
  const retireRotatedOutHotKey = useWalletStore(s => s.retireRotatedOutHotKey);
  const confirm = useConfirm();
  const alert = useAlert();
  const [busy, setBusy] = useState(false);
  // Held from the first tap through the confirm dialog: `busy` alone only flips after it, so a second tap
  // would open a second dialog and run the action twice.
  const inFlight = useRef(false);

  const onMakeMain = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    hapticLight();
    try {
      const accepted = await confirm({
        title: t('hotKeyRotatedOutMakeMainTitle'),
        variant: 'explanation',
        children: t('hotKeyRotatedOutMakeMainBody'),
        confirmLabel: t('hotKeyRotatedOutMakeMain')
      });
      if (!accepted) return;
      setBusy(true);
      await retireRotatedOutHotKey(accountPublicKey, hotPublicKey);
    } catch (e) {
      console.error('[HotKeyRotatedOutGate] could not retire the rotated-out key:', e);
      await alert({
        errorId: 'smthWentWrong',
        title: t('error'),
        children:
          typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string'
            ? e.message
            : t('smthWentWrong')
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [accountPublicKey, alert, confirm, hotPublicKey, retireRotatedOutHotKey, t]);

  // The same exit as the rotation gate's Start over (#1648): nothing of this wallet survives.
  const onRemove = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    hapticLight();
    try {
      const accepted = await confirm({
        title: t('hotKeyRotationStartOverTitle'),
        variant: 'explanation',
        children: t('hotKeyRotationStartOverBody'),
        confirmLabel: t('hotKeyRotationStartOver'),
        destructive: true
      });
      if (!accepted) return;
      await resetWalletAndReload(async () => {
        await alert({ errorId: 'resetDidNotFinish', title: t('error'), children: t('resetDidNotFinish') });
      });
    } catch {
      await alert({ errorId: 'resetDidNotFinish', title: t('error'), children: t('resetDidNotFinish') });
    } finally {
      inFlight.current = false;
    }
  }, [alert, confirm, t]);

  if (!canMakeMain) {
    return (
      <AlertSheet
        open
        dismissible={false}
        variant="explanation"
        title={t('thisDeviceRevoked')}
        actionLabel={t('hotKeyRotatedOutRemove')}
        actionVariant={ButtonVariant.Destructive}
        onAction={onRemove}
        screenKey="hot-key-rotated-out"
        actionTestId="hot-key-rotated-out-remove"
      >
        {t('deviceRevokedBodyNoRecoveryKey')}
        {transactionId && (
          <ListRow
            title={t('deviceRevocationTransaction')}
            subtitle={transactionId}
            href={getExplorerTxUrl(transactionId)}
          />
        )}
      </AlertSheet>
    );
  }

  return (
    <AlertSheet
      open
      dismissible={false}
      variant="explanation"
      title={t('thisDeviceRevoked')}
      actionLabel={busy ? t('loading') : t('hotKeyRotatedOutMakeMain')}
      onAction={onMakeMain}
      secondaryLabel={t('hotKeyRotatedOutRemove')}
      onSecondary={onRemove}
      screenKey="hot-key-rotated-out"
      actionTestId="hot-key-rotated-out-make-main"
      secondaryTestId="hot-key-rotated-out-remove"
    >
      {t('deviceRevokedBody')}
      {transactionId && (
        <ListRow
          title={t('deviceRevocationTransaction')}
          subtitle={transactionId}
          href={getExplorerTxUrl(transactionId)}
        />
      )}
    </AlertSheet>
  );
};

export default HotKeyRotatedOutGate;

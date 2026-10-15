import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { MainnetCodeEntryFields, useMainnetCodeEntry } from 'components/MainnetCodeEntry';
import { Button, ButtonVariant } from 'components/ui/Button';
import { checkMainnetAccessCodeBeforeSwitch } from 'lib/mainnet-access';
import { resetWalletAndReload } from 'lib/miden/reset-and-reload';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { useAlert, useConfirm } from 'lib/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface MainnetSwitchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SheetBody: FC = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const alert = useAlert();

  const switchToMainnet = async (code: string) => {
    try {
      const accepted = await confirm({
        title: t('switchToMainnet'),
        variant: 'explanation',
        children: t('switchToMainnetConfirm'),
        confirmLabel: t('resetAndSwitchToMainnet'),
        destructive: true
      });
      if (!accepted) return;
      await resetWalletAndReload(
        async () => {
          await alert({ title: t('error'), children: t('resetDidNotFinish') });
        },
        MIDEN_NETWORK_NAME.MAINNET,
        code
      );
    } catch {
      await alert({ title: t('error'), children: t('resetDidNotFinish') });
    }
  };

  const entry = useMainnetCodeEntry({ check: checkMainnetAccessCodeBeforeSwitch, onGranted: switchToMainnet });

  return (
    <form className="flex flex-col gap-5 px-4 pb-4" noValidate onSubmit={entry.submit}>
      <MainnetCodeEntryFields entry={entry} testIdPrefix="mainnet-switch" />
      <Button
        type="submit"
        title={t('continue')}
        variant={ButtonVariant.Primary}
        disabled={!entry.complete || entry.pasting}
        isLoading={entry.submitting}
        data-testid="mainnet-switch-submit"
        className="w-full max-w-none"
      />
    </form>
  );
};

/**
 * Moves a wallet on a test network to mainnet, code first: the mainnet node checks the access code
 * while the wallet is still on its network, and only an accepted code reaches the confirmation and the
 * reset, which carries the code to the mainnet code step. The banner and Developer Settings open it.
 */
export const MainnetSwitchSheet: FC<MainnetSwitchSheetProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="mainnet-switch">
      <DrawerContent data-testid="mainnet-switch-sheet">
        <DrawerHeader>
          <DrawerTitle>{t('switchToMainnet')}</DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>{t('mainnetSwitchCodeBody')}</DrawerDescription>
        <div className="flex min-h-0 flex-col overflow-y-auto no-scrollbar">
          <SheetBody />
        </div>
      </DrawerContent>
    </Drawer>
  );
};

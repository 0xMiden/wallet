import React from 'react';

import { useWalletInfo } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { truncateHash } from 'utils/string';

interface EvmSwitchWalletDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Connected EVM address of the current wallet. */
  address: string;
  /** Formatted native-ETH balance of the current wallet (e.g. "0.00"). */
  ethBalance: string;
  ethLoading?: boolean;
  /** Opens the wallet picker to connect (switch to) a different wallet. */
  onConnectAnother: () => void;
}

/**
 * Bottom-sheet shown from the bridge-deposit wallet header's switch button:
 * lists the currently-connected wallet (logo + name from AppKit's
 * `useWalletInfo`, address, native-ETH balance, selected check) and a
 * "Connect another wallet" action that reopens the wallet picker.
 */
export const EvmSwitchWalletDrawer: React.FC<EvmSwitchWalletDrawerProps> = ({
  open,
  onOpenChange,
  address,
  ethBalance,
  ethLoading,
  onConnectAnother
}) => {
  const { t } = useTranslation();
  const { walletInfo } = useWalletInfo('eip155');
  const name = walletInfo?.name ?? t('connectedWallet');
  const icon = walletInfo?.icon;

  const handleConnectAnother = () => {
    hapticLight();
    onOpenChange(false);
    onConnectAnother();
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-switch-wallet">
      <DrawerContent className="px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('switchWallet')}</DrawerTitle>
        </DrawerHeader>

        <span className="px-1 text-xs font-bold uppercase tracking-wide text-text-tertiary-token">{t('current')}</span>

        <div className="mt-3 flex w-full items-center gap-3 px-1">
          {icon ? (
            <img
              src={icon}
              alt={name}
              className="h-11 w-11 shrink-0 rounded-xl border border-border-faint object-cover"
            />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border-faint bg-gray-100">
              <Icon name={IconName.Wallet} className="h-5 w-5 text-heading-gray" fill="currentColor" />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-heading text-base font-bold text-heading-gray">{name}</span>
            <span className="text-sm text-text-tertiary-token">{truncateHash(address, 6, 4)}</span>
          </div>
          <span className="shrink-0 text-sm font-semibold text-text-tertiary-token">
            {ethLoading ? t('loading') : `${ethBalance} ETH`}
          </span>
          <Icon name={IconName.CheckboxCircleFill} className="h-5 w-5 shrink-0 text-primary-500" fill="currentColor" />
        </div>

        <button
          type="button"
          onClick={handleConnectAnother}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gray-100 py-4 font-heading text-base font-bold text-heading-gray transition-colors active:bg-gray-200"
        >
          <Icon name={IconName.Add} className="h-5 w-5" fill="currentColor" />
          {t('connectAnotherWallet')}
        </button>
      </DrawerContent>
    </Drawer>
  );
};

import React from 'react';

import { useWalletInfo } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
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

  // `ListRow` fires the tap haptic itself, so this only closes and hands over.
  const handleConnectAnother = () => {
    onOpenChange(false);
    onConnectAnother();
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-switch-wallet">
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('switchWallet')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-5 px-4">
          <section>
            <SectionHeader>{t('current')}</SectionHeader>
            <ListGroup>
              <ListRow
                title={name}
                subtitle={truncateHash(address, 6, 4)}
                avatar={
                  icon ? (
                    <img src={icon} alt="" className="h-10 w-10 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-page text-ink">
                      <Icon name={IconName.Wallet} size="sm" fill="currentColor" />
                    </span>
                  )
                }
                value={ethLoading ? t('loading') : `${ethBalance} ETH`}
                checked
              />
            </ListGroup>
          </section>

          <ListGroup>
            <ListRow
              title={t('connectAnotherWallet')}
              icon={<Icon name={IconName.Add} fill="currentColor" />}
              chevron
              onClick={handleConnectAnother}
            />
          </ListGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

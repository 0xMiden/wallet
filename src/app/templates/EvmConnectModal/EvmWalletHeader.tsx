import React from 'react';

import { useWalletInfo } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

interface EvmWalletHeaderProps {
  /** Connected EVM address, shown front-truncated. */
  address: string;
  /** Switch/disconnect the connected EVM wallet. */
  onSwitch: () => void;
}

/**
 * Connected-wallet row for the bridge-deposit screen: the wallet company logo
 * (from AppKit's `useWalletInfo`, when available — native mobile has no icon and
 * falls back to a generic glyph), the front-truncated address, and a switch
 * button that hands off to the disconnect flow.
 */
export const EvmWalletHeader: React.FC<EvmWalletHeaderProps> = ({ address, onSwitch }) => {
  const { t } = useTranslation();
  const { walletInfo } = useWalletInfo('eip155');
  const icon = walletInfo?.icon;

  return (
    <div className="flex items-center gap-2">
      {icon && (
        <img
          src={icon}
          alt={walletInfo?.name ?? t('connectedWallet')}
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      )}

      <span className="font-heading text-xl font-bold text-gray opacity-50">{`${address.slice(0, 15)}…`}</span>

      <button
        type="button"
        onClick={() => {
          hapticLight();
          onSwitch();
        }}
        aria-label={t('switchWallet')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-text-tertiary-token"
      >
        <Icon name={IconName.Switch} className="h-3.5 w-3.5" fill="currentColor" />
      </button>
    </div>
  );
};

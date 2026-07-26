import React from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/** The two EVM source tokens a deposit can bridge: native ETH or USDC. */
export type DepositToken = 'ETH' | 'USDC';

interface TokenRow {
  token: DepositToken;
  /** Formatted balance for display (from the connected EVM wallet). */
  balance: string;
  loading?: boolean;
}

export interface EvmBridgeTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: DepositToken;
  ethBalance: string;
  usdcBalance: string;
  ethLoading?: boolean;
  usdcLoading?: boolean;
  onSelect: (token: DepositToken) => void;
}

/**
 * Bottom-sheet picker for the deposit source token (ETH / USDC). The chosen
 * token drives the amount screen's balance and constrains the available bridge
 * routes (USDC can't use the native-only Agglayer/Slow route).
 */
export const EvmBridgeTokenDrawer: React.FC<EvmBridgeTokenDrawerProps> = ({
  open,
  onOpenChange,
  selected,
  ethBalance,
  usdcBalance,
  ethLoading,
  usdcLoading,
  onSelect
}) => {
  const { t } = useTranslation();

  const rows: TokenRow[] = [
    { token: 'ETH', balance: ethBalance, loading: ethLoading },
    { token: 'USDC', balance: usdcBalance, loading: usdcLoading }
  ];

  const handleSelect = (token: DepositToken) => {
    hapticLight();
    onSelect(token);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="px-4 pb-6">
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-2">
          {rows.map(({ token, balance, loading }) => (
            <button
              key={token}
              type="button"
              onClick={() => handleSelect(token)}
              className={classNames(
                'flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
                token === selected ? 'border-primary-500 bg-surface-interactive' : 'border-rule-default bg-pure-white'
              )}
            >
              <TokenLogo symbol={token} size="md" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-heading text-base font-bold text-heading-gray">{token}</span>
                <span className="text-xs font-semibold text-heading-gray/60">
                  {loading ? t('loading') : `${balance} ${token}`}
                </span>
              </div>
              {token === selected && (
                <Icon name={IconName.Checkmark} className="h-5 w-5 shrink-0 text-primary-500" fill="currentColor" />
              )}
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

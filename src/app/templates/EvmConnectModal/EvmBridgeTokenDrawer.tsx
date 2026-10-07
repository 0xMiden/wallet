import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/** The two EVM source tokens a deposit can bridge: native ETH or USDC. */
export type DepositToken = 'ETH' | 'USDC';

interface TokenRow {
  token: DepositToken;
  /** The row's title and balance unit: the token, or the USDC token's display label. */
  name: string;
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
  /** The USDC row's name, such as the testnet label (`evmUsdcLabel`). */
  usdcLabel: string;
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
  usdcLabel,
  ethLoading,
  usdcLoading,
  onSelect
}) => {
  const { t } = useTranslation();

  const rows: TokenRow[] = [
    { token: 'ETH', name: 'ETH', balance: ethBalance, loading: ethLoading },
    { token: 'USDC', name: usdcLabel, balance: usdcBalance, loading: usdcLoading }
  ];

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-bridge-token">
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>

        {/* One grouped list on the shared `fill`, with the design system's round check on the
            chosen token — the same picker the send and swap flows draw. */}
        <ListGroup className="mx-4">
          {rows.map(({ token, name, balance, loading }) => (
            <ListRow
              key={token}
              title={name}
              subtitle={loading ? t('loading') : `${balance} ${name}`}
              avatar={<TokenLogo symbol={token} size="lg" />}
              checked={token === selected}
              onClick={() => onSelect(token)}
              data-testid={`bridge-token-${token}`}
            />
          ))}
        </ListGroup>
      </DrawerContent>
    </Drawer>
  );
};

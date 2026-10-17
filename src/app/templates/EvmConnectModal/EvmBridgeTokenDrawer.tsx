import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/**
 * New deposits use Circle USDC or configured native ETH. `USDC` identifies the retired Epoch test token
 * in existing engine states; it is never offered by this picker.
 */
export type DepositToken = 'ETH' | 'USDC' | 'CIRCLE_USDC';

interface TokenRow {
  token: DepositToken;
  /** The row's title and balance unit. */
  name: string;
  /** Keys the row's logo. */
  logoSymbol: string;
  /** Formatted balance for display (from the connected EVM wallet). */
  balance: string;
  loading?: boolean;
}

export interface EvmBridgeTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: DepositToken;
  /** Native ETH, which bridges only through AggLayer. The row is drawn only when the balance is given. */
  ethBalance?: string;
  ethLoading?: boolean;
  /**
   * Circle's USDC, which bridges only through Circle xReserve. The row is
   * drawn only when the balance is given, which the host does where that route can start.
   */
  circleUsdcBalance?: string;
  /** The Circle USDC row's name: the token's symbol and its network. */
  circleUsdcLabel?: string;
  circleUsdcLoading?: boolean;
  onSelect: (token: DepositToken) => void;
}

/**
 * Bottom-sheet picker for the deposit source token. The chosen token drives the
 * amount screen's balance and route. Circle USDC arrives as USDCx on Miden; native ETH
 * uses AggLayer where configured.
 */
export const EvmBridgeTokenDrawer: React.FC<EvmBridgeTokenDrawerProps> = ({
  open,
  onOpenChange,
  selected,
  ethBalance,
  ethLoading,
  circleUsdcBalance,
  circleUsdcLabel,
  circleUsdcLoading,
  onSelect
}) => {
  const { t } = useTranslation();

  const rows: TokenRow[] = [];
  if (ethBalance !== undefined) {
    rows.push({ token: 'ETH', name: 'ETH', logoSymbol: 'ETH', balance: ethBalance, loading: ethLoading });
  }
  if (circleUsdcBalance !== undefined) {
    rows.push({
      token: 'CIRCLE_USDC',
      name: circleUsdcLabel ?? 'USDC',
      logoSymbol: 'USDC',
      balance: circleUsdcBalance,
      loading: circleUsdcLoading
    });
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-bridge-token">
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>

        {/* One grouped list on the shared `fill`, with the design system's round check on the
            chosen token — the same picker the send and swap flows draw. */}
        <ListGroup className="mx-4">
          {rows.map(({ token, name, logoSymbol, balance, loading }) => (
            <ListRow
              accent="receive"
              key={token}
              title={name}
              subtitle={loading ? t('loading') : `${balance} ${name}`}
              avatar={<TokenLogo symbol={logoSymbol} size="lg" />}
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

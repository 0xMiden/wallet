import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

/**
 * The EVM source tokens a deposit can bridge: native ETH through AggLayer, the Epoch bridge's own test USDC
 * (`USDC`, a testnet-only ERC-20 the document names under `epoch.tokens.USDC`), or Circle's USDC through
 * xReserve (`CIRCLE_USDC`). On mainnet there is one USDC, Circle's, so only `CIRCLE_USDC` is offered there.
 */
export type DepositToken = 'ETH' | 'USDC' | 'CIRCLE_USDC';

interface TokenRow {
  token: DepositToken;
  /** The row's title and balance unit: the token, or the USDC token's display label. */
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
  /**
   * The Epoch bridge's own test USDC. The row is drawn only when the balance is given, which the host does only
   * when the document names that token; a mainnet document never does, since Circle's USDC is the one USDC there.
   */
  usdcBalance?: string;
  /** The USDC row's name, such as the testnet label (`evmUsdcLabel`). */
  usdcLabel: string;
  ethLoading?: boolean;
  usdcLoading?: boolean;
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
 * amount screen's balance and selects the bridge routes: ETH and the Epoch bridge's
 * own test USDC pick Fast (Epoch) or Slow (Agglayer); Circle's USDC bridges only
 * through Circle xReserve to USDCx on Miden. A row is drawn only when the document
 * names a route its token can take, so a mainnet document lists Circle's USDC alone.
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
  if (usdcBalance !== undefined) {
    rows.push({ token: 'USDC', name: usdcLabel, logoSymbol: 'USDC', balance: usdcBalance, loading: usdcLoading });
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

import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { UsdValue } from 'components/TokenUsdValue';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { evmQuote } from 'lib/prices/evm';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { type DepositToken, depositTokenKey, type OfferedErc20, sameDepositToken } from './deposit-token';

export type { DepositToken, OfferedErc20 } from './deposit-token';

/** An ERC-20 row the host draws: the offered token and the connected wallet's balance of it. */
export interface DepositErc20Row {
  token: OfferedErc20;
  /** The row's title and balance unit; the symbol unless the host names it otherwise. */
  name: string;
  balance: string;
  /** Balance in base units. Null means that the balance is not available. */
  value: bigint | null;
  loading?: boolean;
}

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
  chainId?: number;
  circleUsdcAddress?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: DepositToken;
  /** Native ETH uses Agglayer. Show the row only when its base-unit balance is positive. */
  ethBalance?: string;
  ethBalanceValue?: bigint | null;
  ethLoading?: boolean;
  /**
   * Circle's USDC, which bridges only through Circle xReserve. The row is
   * drawn only when the balance is given, which the host does where that route can start.
   */
  circleUsdcBalance?: string;
  /** The Circle USDC row's name: the token's symbol and its network. */
  circleUsdcLabel?: string;
  circleUsdcLoading?: boolean;
  /**
   * The ERC-20s the AggLayer bridge registers on the chosen chain, each bridging through AggLayer alone. Drawn after
   * ETH and Circle USDC, in registry order. Show only tokens with a positive base-unit balance.
   */
  erc20Rows?: DepositErc20Row[];
  /** True while the registered token list could not be read: the drawer says so instead of showing fewer tokens. */
  erc20Unavailable?: boolean;
  onSelect: (token: DepositToken) => void;
}

/**
 * Bottom-sheet picker for the deposit source token. The chosen token drives the
 * amount screen's balance and route. Circle USDC arrives as USDCx on Miden; native ETH
 * and every registered ERC-20 use AggLayer where configured.
 */
export const EvmBridgeTokenDrawer: React.FC<EvmBridgeTokenDrawerProps> = ({
  chainId,
  circleUsdcAddress,
  open,
  onOpenChange,
  selected,
  ethBalance,
  ethBalanceValue,
  ethLoading,
  circleUsdcBalance,
  circleUsdcLabel,
  circleUsdcLoading,
  erc20Rows = [],
  erc20Unavailable = false,
  onSelect
}) => {
  const { t } = useTranslation();
  const prices = useWalletStore(state => state.tokenPrices);

  const rows: TokenRow[] = [];
  const balancesLoading = ethLoading || erc20Rows.some(row => row.loading);
  if (ethBalance !== undefined && ethBalanceValue !== null && ethBalanceValue !== undefined && ethBalanceValue > 0n) {
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
  for (const { token, name, balance, value, loading } of erc20Rows) {
    if (value === null || value <= 0n) continue;
    rows.push({
      token: { kind: 'erc20', contractAddress: token.contractAddress },
      name,
      logoSymbol: token.symbol,
      balance,
      loading
    });
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-bridge-token">
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>

        <div className="min-h-0 overflow-y-auto overscroll-y-contain px-4" data-testid="bridge-token-scroll">
          <ListGroup>
            {rows.map(({ token, name, logoSymbol, balance, loading }) => (
              <ListRow
                accent="receive"
                key={depositTokenKey(token)}
                title={name}
                subtitle={
                  loading ? (
                    t('loading')
                  ) : (
                    <div>
                      {`${balance} ${name}`}
                      <div>
                        <UsdValue
                          amount={balance}
                          quote={evmQuote(
                            prices,
                            chainId,
                            typeof token !== 'string'
                              ? token.contractAddress
                              : token === 'ETH'
                                ? '0x0000000000000000000000000000000000000000'
                                : circleUsdcAddress
                          )}
                        />
                      </div>
                    </div>
                  )
                }
                avatar={<TokenLogo symbol={logoSymbol} size="lg" />}
                checked={sameDepositToken(token, selected)}
                onClick={() => onSelect(token)}
                data-testid={`bridge-token-${depositTokenKey(token)}`}
              />
            ))}
          </ListGroup>
          {erc20Unavailable && (
            <Notice variant="inline" tone="warning" className="mt-4" data-testid="bridge-token-list-unavailable">
              {t('bridgeDepositTokensUnavailable')}
            </Notice>
          )}
          {balancesLoading && (
            <Notice variant="inline" role="status" className="mt-4">
              {t('loading')}
            </Notice>
          )}
          {rows.length === 0 && !balancesLoading && !erc20Unavailable && (
            <Notice variant="inline" role="status">
              {t('bridgeDepositNoTokenBalance')}
            </Notice>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

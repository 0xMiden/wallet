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

/** A token of the picked chain's Epoch route the host draws, with the connected wallet's balance of it. */
export interface DepositEpochRow {
  /** The document's key on the route. */
  key: string;
  /** The token's symbol, which keys its logo. */
  symbol: string;
  /** The token's address on the chain; the zero address for the native coin. */
  address: string;
  /** The Miden faucet it arrives in: the logo falls back to that faucet's token-list logo (POL, USDG). */
  midenFaucetId: string;
  /** The row's title and balance unit. */
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
  /** Prices the row's balance on the drawer's chain. */
  priceAddress?: string;
  /** The faucet whose token-list logo is drawn when the wallet ships no mark for `logoSymbol`. */
  logoFaucetId?: string;
  /** Formatted balance for display (from the connected EVM wallet). */
  balance: string;
  loading?: boolean;
  unreadable?: boolean;
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
  /** Circle USDC's base-unit balance; null marks a settled read failure. */
  circleUsdcBalanceValue?: bigint | null;
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
  /** True while the wallet holdings request is unresolved. */
  erc20ListLoading?: boolean;
  /** The tokens the chosen chain's Epoch route takes, each bridging through Epoch alone. Drawn after Circle USDC. */
  epochRows?: DepositEpochRow[];
  onSelect: (token: DepositToken) => void;
}

/**
 * Bottom-sheet picker for the deposit source token. The chosen token drives the
 * amount screen's balance and route. Circle USDC arrives as USDCx on Miden; an Epoch
 * token arrives as its Miden faucet's token; native ETH and every registered ERC-20
 * use AggLayer where configured.
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
  circleUsdcBalanceValue,
  circleUsdcLabel,
  circleUsdcLoading,
  erc20Rows = [],
  erc20Unavailable = false,
  erc20ListLoading,
  epochRows = [],
  onSelect
}) => {
  const { t } = useTranslation();
  const prices = useWalletStore(state => state.tokenPrices);

  const rows: TokenRow[] = [];
  const balancesLoading =
    ethLoading ||
    circleUsdcLoading ||
    erc20ListLoading ||
    erc20Rows.some(row => row.loading) ||
    epochRows.some(row => row.loading);
  if (
    ethBalance !== undefined &&
    !ethLoading &&
    ethBalanceValue !== null &&
    ethBalanceValue !== undefined &&
    ethBalanceValue > 0n
  ) {
    rows.push({
      token: 'ETH',
      name: 'ETH',
      logoSymbol: 'ETH',
      priceAddress: '0x0000000000000000000000000000000000000000',
      balance: ethBalance
    });
  } else if (ethBalance !== undefined && !ethLoading && ethBalanceValue === null) {
    rows.push({
      token: 'ETH',
      name: 'ETH',
      logoSymbol: 'ETH',
      priceAddress: '0x0000000000000000000000000000000000000000',
      balance: ethBalance,
      unreadable: true
    });
  }
  if (circleUsdcBalance !== undefined) {
    rows.push({
      token: 'CIRCLE_USDC',
      name: circleUsdcLabel ?? 'USDC',
      logoSymbol: 'USDC',
      priceAddress: circleUsdcAddress,
      balance: circleUsdcBalance,
      loading: circleUsdcLoading,
      unreadable: !circleUsdcLoading && circleUsdcBalanceValue === null
    });
  }
  for (const { key, symbol, address, midenFaucetId, name, balance, value, loading } of epochRows) {
    if (loading) {
      rows.push({
        token: { kind: 'epoch', key },
        name,
        logoSymbol: symbol,
        logoFaucetId: midenFaucetId,
        priceAddress: address,
        balance,
        loading
      });
      continue;
    }
    rows.push({
      token: { kind: 'epoch', key },
      name,
      logoSymbol: symbol,
      logoFaucetId: midenFaucetId,
      priceAddress: address,
      balance,
      unreadable: value === null
    });
  }
  for (const { token, name, balance, value, loading } of erc20Rows) {
    if (loading) continue;
    if (value === null) {
      rows.push({
        token: { kind: 'erc20', contractAddress: token.contractAddress },
        name,
        logoSymbol: token.symbol,
        priceAddress: token.contractAddress,
        balance,
        unreadable: true
      });
      continue;
    }
    if (value <= 0n) continue;
    rows.push({
      token: { kind: 'erc20', contractAddress: token.contractAddress },
      name,
      logoSymbol: token.symbol,
      priceAddress: token.contractAddress,
      balance,
      loading: false
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
            {rows.map(({ token, name, logoSymbol, logoFaucetId, priceAddress, balance, loading, unreadable }) => (
              <ListRow
                accent="receive"
                key={depositTokenKey(token)}
                title={name}
                subtitle={
                  loading ? (
                    t('loading')
                  ) : unreadable ? (
                    t('unavailable')
                  ) : (
                    <div>
                      {`${balance} ${name}`}
                      <div>
                        <UsdValue amount={balance} quote={evmQuote(prices, chainId, priceAddress)} />
                      </div>
                    </div>
                  )
                }
                avatar={<TokenLogo symbol={logoSymbol} faucetId={logoFaucetId} size="lg" />}
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

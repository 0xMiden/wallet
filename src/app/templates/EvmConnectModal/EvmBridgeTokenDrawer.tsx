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
  loading?: boolean;
}

/** A token of the picked chain's Epoch route the host draws, with the connected wallet's balance of it. */
export interface DepositEpochRow {
  /** The document's key on the route. */
  key: string;
  /** The token's address on the chain; the zero address for the native coin. */
  address: string;
  /** The Miden faucet it arrives in, which keys its token-list logo (POL, USDG). */
  midenFaucetId: string;
  /** The row's title and balance unit. */
  name: string;
  balance: string;
  loading?: boolean;
}

interface TokenRow {
  token: DepositToken;
  /** The row's title and balance unit. */
  name: string;
  /** Prices the row's balance on the drawer's chain. */
  priceAddress?: string;
  /** The Miden faucet the token arrives in, which keys its token-list logo; undefined while that faucet does not exist. */
  logoFaucetId: string | undefined;
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
  /** Native ETH, which bridges only through AggLayer. The row is drawn only when the balance is given. */
  ethBalance?: string;
  ethLoading?: boolean;
  /** The Miden faucet AggLayer delivers native ETH into, which keys the ETH row's logo. */
  ethFaucetId?: string;
  /**
   * Circle's USDC, which bridges only through Circle xReserve. The row is
   * drawn only when the balance is given, which the host does where that route can start.
   */
  circleUsdcBalance?: string;
  /** The Circle USDC row's name: the token's symbol and its network. */
  circleUsdcLabel?: string;
  circleUsdcLoading?: boolean;
  /** The USDCx faucet Circle USDC arrives in, which keys the Circle USDC row's logo. */
  circleUsdcFaucetId?: string;
  /**
   * The ERC-20s the AggLayer bridge registers on the chosen chain, each bridging through AggLayer alone. Drawn after
   * ETH and Circle USDC, in the registry's order; absent while the host offers no AggLayer chain.
   */
  erc20Rows?: DepositErc20Row[];
  /** True while the registered token list could not be read: the drawer says so instead of showing fewer tokens. */
  erc20Unavailable?: boolean;
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
  ethLoading,
  ethFaucetId,
  circleUsdcBalance,
  circleUsdcLabel,
  circleUsdcLoading,
  circleUsdcFaucetId,
  erc20Rows = [],
  erc20Unavailable = false,
  epochRows = [],
  onSelect
}) => {
  const { t } = useTranslation();
  const prices = useWalletStore(state => state.tokenPrices);

  const rows: TokenRow[] = [];
  if (ethBalance !== undefined) {
    rows.push({
      token: 'ETH',
      name: 'ETH',
      logoFaucetId: ethFaucetId,
      priceAddress: '0x0000000000000000000000000000000000000000',
      balance: ethBalance,
      loading: ethLoading
    });
  }
  if (circleUsdcBalance !== undefined) {
    rows.push({
      token: 'CIRCLE_USDC',
      name: circleUsdcLabel ?? 'USDC',
      logoFaucetId: circleUsdcFaucetId,
      priceAddress: circleUsdcAddress,
      balance: circleUsdcBalance,
      loading: circleUsdcLoading
    });
  }
  for (const { key, address, midenFaucetId, name, balance, loading } of epochRows) {
    rows.push({
      token: { kind: 'epoch', key },
      name,
      logoFaucetId: midenFaucetId,
      priceAddress: address,
      balance,
      loading
    });
  }
  for (const { token, name, balance, loading } of erc20Rows) {
    rows.push({
      token: { kind: 'erc20', contractAddress: token.contractAddress },
      name,
      // A token the bridge has never carried has no faucet until its first deposit, so it draws the default mark.
      logoFaucetId: token.delivery?.midenFaucetId,
      priceAddress: token.contractAddress,
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

        {/* One grouped list on the shared `fill`, with the design system's round check on the
            chosen token — the same picker the send and swap flows draw. */}
        <ListGroup className="mx-4">
          {rows.map(({ token, name, logoFaucetId, priceAddress, balance, loading }) => (
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
                      <UsdValue amount={balance} quote={evmQuote(prices, chainId, priceAddress)} />
                    </div>
                  </div>
                )
              }
              avatar={<TokenLogo faucetId={logoFaucetId} size="lg" />}
              checked={sameDepositToken(token, selected)}
              onClick={() => onSelect(token)}
              data-testid={`bridge-token-${depositTokenKey(token)}`}
            />
          ))}
        </ListGroup>
        {erc20Unavailable && (
          <Notice variant="inline" tone="warning" className="mx-4 mt-4" data-testid="bridge-token-list-unavailable">
            {t('bridgeDepositTokensUnavailable')}
          </Notice>
        )}
      </DrawerContent>
    </Drawer>
  );
};

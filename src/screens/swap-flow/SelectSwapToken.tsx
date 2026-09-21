import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { AssetListItem } from 'components/ui/AssetListItem';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getSwapTokens, SwapToken } from 'lib/miden/swap/tokens';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface SelectSwapTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Faucet id currently chosen for this side, rendered as selected. */
  currentFaucetId?: string;
  onSelect: (token: SwapToken) => void;
}

/**
 * Token picker for a swap side, presented as a bottom sheet (vaul) over the amounts step like the
 * send flow's SelectTokenDrawer.
 *
 * Drawn the way the home tab's Assets section draws a token: the shared `AssetListItem` on the
 * sheet's own surface (no grey card), 72px rows divided by a hairline, a 36px logo, the symbol over
 * the held balance and the value on the right. The DEX exposes a fixed set of test tokens
 * (`SWAP_TOKENS`), and a token the account holds nothing of is still listed with a zero balance —
 * the list is the pair chooser, not an inventory.
 *
 * Balances come from the same path home and the send picker use, `useAllBalances` keyed by the
 * faucet id, so the number here is the one the rest of the wallet shows. Fiat is rendered only
 * where the price feed actually has that symbol: `getTokenPrice`'s $1 fallback would turn every
 * unlisted DEX token into a dollar figure equal to its token count.
 *
 * The chosen side carries the design system's round check in the swap flow's purple, and
 * `AssetListItem` fires the tap haptic itself.
 */
export const SelectSwapTokenDrawer: React.FC<SelectSwapTokenDrawerProps> = ({
  open,
  onOpenChange,
  currentFaucetId,
  onSelect
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [] } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const onSelectToken = (token: SwapToken) => {
    onSelect(token);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="swap-token">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <div className="no-scrollbar min-h-0 overflow-y-auto">
            <div className="flex flex-col divide-y divide-rule-default">
              {getSwapTokens().map(token => {
                const held = balanceData.find(b => b.tokenId === token.faucetId);
                // An unheld token is a zero of a registry token, whose decimals we know; a held one
                // is only a quantity if its own metadata carries real decimals.
                const scaleIsKnown = held ? hasKnownScale(held.metadata) : true;
                const balance = held?.balance ?? 0;
                const price = tokenPrices[token.symbol]?.price;
                const fiatValue = scaleIsKnown && price !== undefined && balance > 0 ? balance * price : undefined;
                const formatQuantity = adaptiveFormatterFor(balance);
                const formatFiat = adaptiveFormatterFor(fiatValue ?? 0);

                return (
                  <AssetListItem
                    key={token.faucetId}
                    icon={<TokenLogo symbol={token.logoSymbol} />}
                    name={token.symbol}
                    amount={
                      scaleIsKnown ? (
                        <AnimatedNumber value={balance} format={value => `${formatQuantity(value)} ${token.symbol}`} />
                      ) : (
                        token.symbol
                      )
                    }
                    price={
                      fiatValue === undefined ? undefined : (
                        <AnimatedNumber value={fiatValue} format={value => `$${formatFiat(value)}`} />
                      )
                    }
                    selected={token.faucetId === currentFaucetId}
                    accent="swap"
                    onClick={() => onSelectToken(token)}
                    data-testid={`swap-token-${token.symbol}`}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

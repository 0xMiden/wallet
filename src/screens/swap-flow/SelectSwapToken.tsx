import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { AssetListItem } from 'components/ui/AssetListItem';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getSwapTokens, normalizedFaucetId, SwapToken } from 'lib/miden/swap/tokens';
import { listedFiatValue } from 'lib/prices';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
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
 * Balances come from the same path home and the send picker use, `useAllBalances`, keyed by the
 * SDK's bech32 form of the faucet id, so a registry id is normalized before the match (with the raw
 * id as a fallback), as SwapManager does. A token is priced as the asset it stands for (its
 * priceSymbol: IETH at ETH) through `listedFiatValue`, shared with the send picker: IMIDEN and
 * IUSDT, which stand for nothing the feed quotes, show no fiat unless the nominal rate is on.
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
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const onSelectToken = (token: SwapToken) => {
    onSelect(token);
    onOpenChange(false);
  };

  // SwapManager's back handler closes this sheet, so the sheet does not register its own.
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="swap-token" closeOnBack={false}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <div className="no-scrollbar min-h-0 overflow-y-auto">
            <div className="flex flex-col divide-y divide-rule-default">
              {getSwapTokens().map(token => {
                const balanceKey = normalizedFaucetId(token.faucetId);
                const held = balanceData.find(b => b.tokenId === balanceKey || b.tokenId === token.faucetId);
                // An unheld token is a zero of a registry token, whose decimals we know; a held one
                // is only a quantity if its own metadata carries real decimals.
                const scaleIsKnown = held ? hasKnownScale(held.metadata) : true;
                const balance = held?.balance ?? 0;
                // By priceSymbol, never by logoSymbol: IUSDT borrows the USDC logo, not its price. A
                // token without one is unquoted, so it is valued only at the nominal rate.
                const label = midenTokenLabel(bridgeConfig, token.faucetId, token.symbol);
                const fiatValue = listedFiatValue(tokenPrices, token.priceSymbol, balance, scaleIsKnown);
                const formatQuantity = adaptiveFormatterFor(balance);
                const formatFiat = adaptiveFormatterFor(fiatValue ?? 0);

                return (
                  <AssetListItem
                    key={token.faucetId}
                    icon={
                      <TokenLogo symbol={token.symbol} faucetId={token.faucetId} fallbackSymbol={token.logoSymbol} />
                    }
                    name={label}
                    amount={
                      scaleIsKnown ? (
                        <AnimatedNumber value={balance} format={value => `${formatQuantity(value)} ${label}`} />
                      ) : (
                        label
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

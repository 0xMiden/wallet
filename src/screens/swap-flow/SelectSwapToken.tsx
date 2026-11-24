import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { AssetListItem } from 'components/ui/AssetListItem';
import { Popover } from 'components/ui/Popover';
import { SearchInput } from 'components/ui/SearchInput';
import { TokenAmount, UsdAmount } from 'components/ui/TokenAmount';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { normalizedFaucetId, SwapToken } from 'lib/miden/swap/tokens';
import { useSwapPickerTokens } from 'lib/miden/swap/use-swap-tokens';
import { listedFiatValue } from 'lib/prices';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface SelectSwapTokenDrawerProps {
  open: boolean;
  anchorRef?: React.RefObject<HTMLButtonElement>;
  onOpenChange: (open: boolean) => void;
  /** Faucet id currently chosen for this side, rendered as selected. */
  currentFaucetId?: string;
  /**
   * The faucet on the other side, for the "To" side: the sheet then lists only the tokens that share
   * a solver pair with it. The "From" side passes none and lists every token that has a pair.
   */
  partnersOf?: string;
  onSelect: (token: SwapToken) => void;
}

/**
 * Token picker for a swap side, presented as a bottom sheet (vaul) over the amounts step like the
 * send flow's SelectTokenDrawer.
 *
 * Drawn like the home tab's Assets section: the shared `AssetListItem` on the sheet's own surface,
 * without a grey card. Rows have a 72px floor and grow when the quantity wraps, with hairline dividers,
 * a 36px logo, the symbol over its balance and the value on the right. Solver pairs filter the tokens
 * (`useSwapPickerTokens`). A token the account does not hold still shows zero; this list chooses pairs.
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
  anchorRef,
  onOpenChange,
  currentFaucetId,
  partnersOf,
  onSelect
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [], isLoading: balancesLoading } = useAllBalances(publicKey, allTokensBaseMetadata);
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const swapTokens = useSwapPickerTokens(partnersOf);
  const [query, setQuery] = useState('');
  const visibleTokens =
    anchorRef && query.trim()
      ? swapTokens.filter(token =>
          midenTokenLabel(bridgeConfig, token.faucetId, token.symbol).toLowerCase().includes(query.trim().toLowerCase())
        )
      : swapTokens;
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const pricesStatus = useWalletStore(s => s.tokenPricesStatus);

  const closePicker = () => {
    setQuery('');
    onOpenChange(false);
  };
  const onSelectToken = (token: SwapToken) => {
    onSelect(token);
    closePicker();
  };

  const picker = (
    <div className={anchorRef ? 'flex min-h-0 flex-col gap-2 p-3' : 'flex h-120 min-h-0 flex-col px-4 pb-4'}>
      {anchorRef && <SearchInput value={query} onChange={setQuery} placeholder={t('searchForTokens')} />}
      <div className={anchorRef ? 'min-w-0' : 'no-scrollbar min-h-0 overflow-y-auto'}>
        <div className="flex flex-col divide-y divide-rule-default">
          {visibleTokens.map(token => {
            const balanceKey = normalizedFaucetId(token.faucetId);
            const held = balanceData.find(b => b.tokenId === balanceKey || b.tokenId === token.faucetId);
            // An unheld token is a zero of a registry token, whose decimals we know; a held one
            // is only a quantity if its own metadata carries real decimals.
            const scaleIsKnown = held ? hasKnownScale(held.metadata) : true;
            const balance = held?.balance ?? 0;
            // By priceSymbol, never by the ticker: a solver token can stand in for another asset. A
            // token without one is unquoted, so it is valued only at the nominal rate.
            const label = midenTokenLabel(bridgeConfig, token.faucetId, token.symbol);
            const fiatValue = balancesLoading
              ? undefined
              : listedFiatValue(tokenPrices, token.priceSymbol, balance, scaleIsKnown);
            const priceStatus = balancesLoading
              ? token.priceSymbol
                ? t('loading')
                : t('assetPriceUnsupported')
              : !scaleIsKnown
                ? t('assetValueUnknownScale')
                : fiatValue === undefined
                  ? token.priceSymbol
                    ? pricesStatus === 'loading'
                      ? t('loading')
                      : t('unavailable')
                    : t('assetPriceUnsupported')
                  : undefined;

            return (
              <AssetListItem
                key={token.faucetId}
                icon={<TokenLogo faucetId={token.faucetId} />}
                name={label}
                amount={
                  !balancesLoading && scaleIsKnown ? (
                    <TokenAmount
                      amount={balance}
                      symbol={label}
                      animated
                      rounding="down"
                      trimTrailingZeros={false}
                      minimumFractionDigits={2}
                    />
                  ) : (
                    label
                  )
                }
                price={fiatValue === undefined ? undefined : <UsdAmount amount={fiatValue} animated grouping={false} />}
                priceStatus={priceStatus}
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
  );
  if (anchorRef)
    return (
      <Popover
        open={open}
        onClose={closePicker}
        anchorRef={anchorRef}
        align="start"
        aria-label={t('selectAToken')}
        screenKey="swap-token"
      >
        {picker}
      </Popover>
    );
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="swap-token" closeOnBack={false}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        {picker}
      </DrawerContent>
    </Drawer>
  );
};

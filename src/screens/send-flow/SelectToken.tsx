import React, { useCallback, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { Icon, IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { AssetListItem, AssetListItemSkeleton } from 'components/ui/AssetListItem';
import { Notice } from 'components/ui/Notice';
import { SearchInput } from 'components/ui/SearchInput';
import { TokenAmount, UsdAmount } from 'components/ui/TokenAmount';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { listedFiatValue } from 'lib/prices';
import { isNewTransferTokenHeld, isRetiredTransferToken } from 'lib/remote-config/token-availability';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';

import { canSendTokenToChain } from './send-token-routes';
import { UIToken } from './types';
import { uiTokenFromBalance } from './ui-token';

export interface SelectTokenDrawerProps {
  open: boolean;
  usdcxOnly?: boolean;
  destinationChainId?: number;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: UIToken) => void;
}

/**
 * Token picker for the send flow, presented as a bottom sheet (vaul) over the
 * Amount step instead of a pushed sub-screen. Fixed at a comfortable height
 * even when the token list is short.
 *
 * Rows use the home tab's shared `AssetListItem`: a 72px floor that grows for a wrapped quantity,
 * the sheet's own surface, hairline dividers, a 36px logo, token name over its balance and fiat value
 * on the right. The swap picker uses the same row so the two sheets read as one list.
 */
export const SelectTokenDrawer: React.FC<SelectTokenDrawerProps> = ({
  open,
  onOpenChange,
  onSelect,
  usdcxOnly = false,
  destinationChainId
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [], isLoading: balancesLoading } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const pricesStatus = useWalletStore(s => s.tokenPricesStatus);
  const { isHidden } = useHiddenTokens(publicKey);
  const bridgeConfig = useBridgeConfigSnapshot();
  const nativeFaucetId = useNativeFeeFaucetId();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredBalances = useMemo(() => {
    // Hidden from Home, hidden here; the token's own page still sends it, preselected by id.
    const visible = balanceData.filter(
      b =>
        !isHidden(b.tokenId) &&
        !isNewTransferTokenHeld(bridgeConfig, b.tokenId, nativeFaucetId) &&
        canSendTokenToChain(bridgeConfig, b.tokenId, destinationChainId)
    );
    if (!searchQuery.trim()) return visible;
    const query = searchQuery.toLowerCase();
    return visible.filter(
      b =>
        b.metadata.symbol.toLowerCase().includes(query) ||
        b.metadata.name?.toLowerCase().includes(query) ||
        midenTokenLabel(bridgeConfig, b.tokenId, b.metadata.symbol).toLowerCase().includes(query)
    );
  }, [balanceData, bridgeConfig, nativeFaucetId, isHidden, searchQuery, destinationChainId]);
  // A row held until the document arrives is left out with a reason; a retired one is left out silently.
  const holdsPendingToken =
    !balancesLoading &&
    balanceData.some(
      b =>
        !isHidden(b.tokenId) &&
        isNewTransferTokenHeld(bridgeConfig, b.tokenId, nativeFaucetId) &&
        !isRetiredTransferToken(bridgeConfig, b.tokenId, nativeFaucetId)
    );

  const onSelectToken = useCallback(
    (token: UIToken) => {
      onSelect(token);
      setSearchQuery('');
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  // SendManager's back handler closes this sheet, so the sheet does not register its own.
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="token" closeOnBack={false}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectAToken')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('searchForTokens')}
            data-testid="send-token-search"
            className="shrink-0"
          />
          {usdcxOnly && <p className="shrink-0 pt-3 text-caption text-muted">{t('sendUsdcxOnlyDestination')}</p>}
          {holdsPendingToken && (
            <Notice
              tone="warning"
              icon={<Icon name={IconName.Information} size="xs" fill="currentColor" />}
              className="mt-3 shrink-0"
              data-testid="send-picker-held-notice"
            >
              {t('sendTokenAvailabilityChecking')}
            </Notice>
          )}
          <div className="no-scrollbar min-h-0 overflow-y-auto pt-5">
            <div className="flex flex-col divide-y divide-rule-default">
              {balancesLoading ? (
                <AssetListItemSkeleton data-testid="send-token-skeleton" />
              ) : (
                filteredBalances.map(b => {
                  const scaleIsKnown = hasKnownScale(b.metadata);
                  const priceSymbol = priceSymbolFor(b.tokenId, b.metadata.symbol);
                  const fiatValue = listedFiatValue(tokenPrices, priceSymbol, b.balance, scaleIsKnown);
                  const priceStatus = !scaleIsKnown
                    ? t('assetValueUnknownScale')
                    : fiatValue === undefined
                      ? priceSymbol
                        ? pricesStatus === 'loading'
                          ? t('loading')
                          : t('unavailable')
                        : t('assetPriceUnsupported')
                      : undefined;
                  const name = midenTokenLabel(bridgeConfig, b.tokenId, b.metadata.name || b.metadata.symbol);
                  const unit = midenTokenLabel(bridgeConfig, b.tokenId, b.metadata.symbol);
                  return (
                    <AssetListItem
                      key={b.tokenId}
                      disabled={usdcxOnly && !isUsdcxWithdrawalAvailable(b.tokenId)}
                      icon={<TokenLogo faucetId={b.tokenId} />}
                      name={name}
                      amount={
                        scaleIsKnown ? (
                          <TokenAmount
                            amount={b.balance}
                            symbol={unit}
                            animated
                            rounding="down"
                            trimTrailingZeros={false}
                            minimumFractionDigits={2}
                          />
                        ) : (
                          unit
                        )
                      }
                      price={
                        fiatValue === undefined ? undefined : <UsdAmount amount={fiatValue} animated grouping={false} />
                      }
                      priceStatus={priceStatus}
                      data-testid={`send-token-${b.metadata.symbol}`}
                      data-token-id={b.tokenId}
                      onClick={() => onSelectToken(uiTokenFromBalance(b, tokenPrices))}
                    />
                  );
                })
              )}
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

import React, { useCallback, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { Icon, IconName } from 'app/icons/v2';
import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { AssetListItem } from 'components/ui/AssetListItem';
import { Notice } from 'components/ui/Notice';
import { SearchInput } from 'components/ui/SearchInput';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
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

import { UIToken } from './types';
import { uiTokenFromBalance } from './ui-token';

export interface SelectTokenDrawerProps {
  open: boolean;
  usdcxOnly?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: UIToken) => void;
}

/**
 * Token picker for the send flow, presented as a bottom sheet (vaul) over the
 * Amount step instead of a pushed sub-screen. Fixed at a comfortable height
 * even when the token list is short.
 *
 * Rows are the home tab's Assets rows (`AssetListItem`): 72px on the sheet's own
 * surface, divided by a hairline rather than boxed, a 36px logo, the token name
 * over its balance and the fiat value on the right — the same shape the swap
 * picker draws, so the two sheets read as one list.
 */
export const SelectTokenDrawer: React.FC<SelectTokenDrawerProps> = ({
  open,
  onOpenChange,
  onSelect,
  usdcxOnly = false
}) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData = [] } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const pricesStatus = useWalletStore(s => s.tokenPricesStatus);
  const { isHidden } = useHiddenTokens(publicKey);
  const bridgeConfig = useBridgeConfigSnapshot();
  const nativeFaucetId = useNativeFeeFaucetId();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredBalances = useMemo(() => {
    // Hidden from Home, hidden here; the token's own page still sends it, preselected by id.
    const visible = balanceData.filter(
      b => !isHidden(b.tokenId) && !isNewTransferTokenHeld(bridgeConfig, b.tokenId, nativeFaucetId)
    );
    if (!searchQuery.trim()) return visible;
    const query = searchQuery.toLowerCase();
    return visible.filter(
      b =>
        b.metadata.symbol.toLowerCase().includes(query) ||
        b.metadata.name?.toLowerCase().includes(query) ||
        midenTokenLabel(bridgeConfig, b.tokenId, b.metadata.symbol).toLowerCase().includes(query)
    );
  }, [balanceData, bridgeConfig, nativeFaucetId, isHidden, searchQuery]);
  // A row held until the document arrives is left out with a reason; a retired one is left out silently.
  const holdsPendingToken = balanceData.some(
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
              {filteredBalances.map(b => {
                const scaleIsKnown = hasKnownScale(b.metadata);
                const priceSymbol = priceSymbolFor(b.tokenId, b.metadata.symbol);
                const fiatValue = listedFiatValue(tokenPrices, priceSymbol, b.balance, scaleIsKnown);
                const formatQuantity = adaptiveFormatterFor(b.balance);
                const formatFiat = adaptiveFormatterFor(fiatValue ?? 0);
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
                    icon={<TokenLogo symbol={b.metadata.symbol} faucetId={b.tokenId} />}
                    name={name}
                    amount={
                      scaleIsKnown ? (
                        <AnimatedNumber value={b.balance} format={value => `${formatQuantity(value)} ${unit}`} />
                      ) : (
                        unit
                      )
                    }
                    price={
                      fiatValue === undefined ? undefined : (
                        <AnimatedNumber value={fiatValue} format={value => `$${formatFiat(value)}`} />
                      )
                    }
                    priceStatus={priceStatus}
                    data-testid={`send-token-${b.metadata.symbol}`}
                    data-token-id={b.tokenId}
                    onClick={() => onSelectToken(uiTokenFromBalance(b, tokenPrices))}
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

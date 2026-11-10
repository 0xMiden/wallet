import React, { useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { NetworkChip, NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SearchInput } from 'components/ui/SearchInput';
import { hapticSelection } from 'lib/mobile/haptics';
import type { NearIntentsCatalog } from 'lib/one-click/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { chainLogoNetwork } from './chains';
import { NetworkSheet } from './NetworkSheet';

export interface SendTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: NearIntentsCatalog;
  /** The chain and token that the form uses now. */
  selectedChainId: string;
  selectedTokenAssetId: string;
  onSelect: (chainId: string, tokenAssetId: string) => void;
}

/**
 * The tokens that the user can send, for one origin chain at a time. The network pill opens the
 * network sheet, which changes the chain that the list shows. A tap on a token selects that chain
 * and that token for the form.
 */
export const SendTokenDrawer: React.FC<SendTokenDrawerProps> = ({
  open,
  onOpenChange,
  catalog,
  selectedChainId,
  selectedTokenAssetId,
  onSelect
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filterChainId, setFilterChainId] = useState(selectedChainId);
  const [networkOpen, setNetworkOpen] = useState(false);

  // The drawer stays mounted while it is closed. Each open starts on the chain of the form, with
  // no search text.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFilterChainId(selectedChainId);
  }, [open, selectedChainId]);

  const filterChain = catalog.chains.find(chain => chain.id === filterChainId) ?? catalog.chains[0];
  const search = query.trim().toLowerCase();
  const tokens = useMemo(() => {
    const all = filterChain?.tokens ?? [];
    return search ? all.filter(token => token.symbol.toLowerCase().includes(search)) : all;
  }, [filterChain, search]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="near-intents-send-token">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('nearIntentsSendTokenTitle')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4" data-testid="near-intents-send-token-drawer">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('nearIntentsFindToken')}
            className="shrink-0"
            data-testid="near-intents-token-search"
          />
          <div className="flex shrink-0 items-center justify-between gap-3 pt-4">
            <span className="flex items-center gap-2 text-body-sm text-muted">
              <Icon name={IconName.Globe} size="xs" aria-hidden="true" />
              {t('nearIntentsFilterByNetwork')}
            </span>
            {filterChain && (
              <NetworkChip
                kind="ethereum"
                network={chainLogoNetwork(filterChain.id)}
                label={filterChain.name}
                onClick={() => setNetworkOpen(true)}
                data-testid="near-intents-network-filter"
              />
            )}
          </div>
          <div className="no-scrollbar flex min-h-0 flex-col overflow-y-auto pt-4">
            {tokens.length === 0 ? (
              <p className="py-4 text-center text-body-sm text-muted" data-testid="near-intents-no-tokens">
                {t('nearIntentsNoTokensFound')}
              </p>
            ) : (
              <ListGroup>
                {tokens.map(token => (
                  <ListRow
                    key={token.asset.assetId}
                    variant="choice"
                    title={token.symbol}
                    subtitle={filterChain?.name}
                    avatar={
                      <TokenLogo
                        symbol={token.symbol}
                        size="lg"
                        badge={<NetworkLogo kind="ethereum" network={chainLogoNetwork(filterChain?.id ?? '')} />}
                      />
                    }
                    checked={filterChain?.id === selectedChainId && token.asset.assetId === selectedTokenAssetId}
                    accent="receive"
                    haptic={false}
                    onClick={() => {
                      hapticSelection();
                      if (filterChain) onSelect(filterChain.id, token.asset.assetId);
                      onOpenChange(false);
                    }}
                    data-testid={`near-intents-token-${token.asset.assetId}`}
                  />
                ))}
              </ListGroup>
            )}
          </div>
        </div>
        <NetworkSheet
          open={networkOpen}
          onOpenChange={setNetworkOpen}
          chains={catalog.chains}
          selectedChainId={filterChain?.id ?? ''}
          onSelect={setFilterChainId}
        />
      </DrawerContent>
    </Drawer>
  );
};

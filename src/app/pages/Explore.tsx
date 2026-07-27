import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import Balance from 'app/templates/Balance';
import HomePrompts from 'app/templates/HomePrompts';
import { AssetRow } from 'components/AssetRow';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { AccountsDrawer, BalanceCard, SearchInput } from 'components/ui';
import { toLocalFormat } from 'lib/i18n/numbers';
import {
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import {
  setFaucetIdSetting,
  useAccount,
  useAllBalances,
  useAllTokensBaseMetadata,
  useMidenContext
} from 'lib/miden/front';
import type { TokenBalanceData } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { MIDEN_NETWORK_NAME, MIDEN_FAUCET_ENDPOINTS } from 'lib/miden-chain/constants';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';
import { truncateAddress } from 'utils/string';

const Explore: FC = () => {
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const { signTransaction } = useMidenContext();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [], isLoading: balancesLoading } = useAllBalances(
    account.publicKey,
    allTokensBaseMetadata
  );
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;

  const [search, setSearch] = useState('');

  const midenNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return [];
    }

    // Swap-managed notes have their own lineage-aware settlement path. This
    // explicit guard also protects native-asset swap notes whose per-order
    // auto-consume setting is off: they remain available for manual settlement
    // without being picked up by the wallet-wide native-note auto-consumer.
    return claimableNotes.filter(note => note!.faucetId === midenFaucetId && !note!.swapOrder);
  }, [claimableNotes, midenFaucetId, shouldAutoConsume]);

  const hasAutoConsumableNotes = useMemo(() => {
    return midenNotes.length > 0;
  }, [midenNotes]);

  const autoConsumeMidenNotes = useCallback(async () => {
    if (!shouldAutoConsume || !hasAutoConsumableNotes) {
      return;
    }

    const notesToClaim = midenNotes!.filter(note => !note.isBeingClaimed);
    if (notesToClaim.length === 0) {
      return;
    }

    const promises = notesToClaim.map(async note => {
      await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
    });
    await Promise.all(promises);
    mutateClaimableNotes();

    if (isExtension()) {
      requestSWTransactionProcessing();
    } else {
      startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    }
  }, [
    midenNotes,
    isDelegatedProvingEnabled,
    mutateClaimableNotes,
    account.publicKey,
    shouldAutoConsume,
    hasAutoConsumableNotes,
    signTransaction
  ]);

  useEffect(() => {
    if (hasAutoConsumableNotes) {
      autoConsumeMidenNotes();
    }
  }, [autoConsumeMidenNotes, hasAutoConsumableNotes]);

  useEffect(() => {
    if (isHexAddress(address)) {
      navigate('/reset-required');
    }
  }, [address]);

  const fetchFaucetState = useCallback(async () => {
    fetch(`${MIDEN_FAUCET_ENDPOINTS.get(MIDEN_NETWORK_NAME.DEVNET)}/get_metadata`)
      .then(response => response.json())
      .then(data => {
        if (data.id !== midenFaucetId) {
          setFaucetIdSetting(data.id);
        }
      })
      .catch(error => {
        console.error('Error fetching faucet metadata:', error);
      });
  }, [midenFaucetId]);

  useEffect(() => {
    //fetchFaucetState();
  }, [fetchFaucetState]);

  const filteredTokens = useMemo(() => {
    const sorted = [...allTokenBalances].sort(a => (a.tokenId === midenFaucetId ? -1 : 1));
    if (!search.trim()) return sorted;
    const query = search.toLowerCase();
    return sorted.filter(
      asset => asset.metadata.symbol.toLowerCase().includes(query) || asset.metadata.name?.toLowerCase().includes(query)
    );
  }, [allTokenBalances, midenFaucetId, search]);

  if (isHexAddress(address)) {
    return null;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-bg font-inter" data-testid="explore-page">
      <div className="shrink-0">
        <ConnectivityIssueBanner />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-3 px-4 pt-3 pb-32">
          <HomeOverview
            address={address}
            tokenPrices={tokenPrices}
            balances={allTokenBalances}
            filteredTokens={filteredTokens}
            search={search}
            onSearchChange={setSearch}
            account={account}
            balancesLoading={balancesLoading}
          />
        </div>
      </div>
    </div>
  );
};

export default Explore;

interface HomeOverviewProps {
  address: string;
  tokenPrices: TokenPrices;
  balances: TokenBalanceData[];
  filteredTokens: TokenBalanceData[];
  search: string;
  onSearchChange: (v: string) => void;
  account: WalletAccount;
  balancesLoading: boolean;
}

const HomeOverview: FC<HomeOverviewProps> = ({
  address,
  tokenPrices,
  balances,
  filteredTokens,
  search,
  onSearchChange,
  account,
  balancesLoading
}) => {
  const [accountsOpen, setAccountsOpen] = useState(false);
  const { t } = useTranslation();
  return (
    <>
      <Balance>
        {balance => (
          <BalanceCard
            accountNumber={truncateAddress(address, false, 8)}
            accountId={address}
            amount={`$${toLocalFormat(balance, { decimalPlaces: 2 })}`}
            currency="USD"
            delta={{ absolute: '+0.00', percentage: '0.00%', direction: 'positive' }}
            onMore={() => setAccountsOpen(true)}
          />
        )}
      </Balance>

      <AccountsDrawer open={accountsOpen} onOpenChange={setAccountsOpen} />

      <HomePrompts account={account} balances={balances} balancesLoading={balancesLoading} />

      <div className="flex items-center justify-between pt-2">
        <span className="text-2xl font-bold text-text-primary-token">{t('assets')}</span>
      </div>

      <SearchInput value={search} onChange={onSearchChange} placeholder="Search for tokens" />

      <div className="flex flex-col divide-y divide-rule-default">
        {filteredTokens.map(asset => (
          <AssetRow
            key={asset.tokenId}
            asset={asset}
            tokenPrices={tokenPrices}
            onClick={() => navigate(`/token-detail/${asset.tokenId}`)}
          />
        ))}
      </div>
    </>
  );
};

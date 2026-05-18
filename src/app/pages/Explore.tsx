import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ActivateHotKeyBanner } from 'app/templates/ActivateHotKeyBanner';
import Balance from 'app/templates/Balance';
import { AssetRow } from 'components/AssetRow';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { BalanceCard, PromptCard, SearchInput } from 'components/ui';
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
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';
import { truncateAddress } from 'utils/string';

const Explore: FC = () => {
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const { signTransaction } = useMidenContext();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
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

    return claimableNotes.filter(note => note!.faucetId === midenFaucetId);
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
    <div className="flex flex-col h-full overflow-hidden bg-app-bg font-inter">
      <div className="shrink-0">
        <ConnectivityIssueBanner />
        <ActivateHotKeyBanner />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-3 px-4 pt-3 pb-32">
          <HomeOverview
            address={address}
            tokenPrices={tokenPrices}
            filteredTokens={filteredTokens}
            search={search}
            onSearchChange={setSearch}
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
  filteredTokens: TokenBalanceData[];
  search: string;
  onSearchChange: (v: string) => void;
}

const HomeOverview: FC<HomeOverviewProps> = ({ address, tokenPrices, filteredTokens, search, onSearchChange }) => (
  <>
    <Balance>
      {balance => (
        <BalanceCard
          accountNumber={truncateAddress(address, false, 8)}
          accountId={address}
          amount={`$${balance.toFormat(2)}`}
          currency="USD"
          delta={{ absolute: '+0.00', percentage: '0.00%', direction: 'positive' }}
          onMore={() => undefined}
        />
      )}
    </Balance>

    <PromptCard
      title="Set up your Guardian"
      body="Make sure to set up your Guardian to ensure your wallet back-up."
      onClick={() => navigate('/settings')}
    />

    <div className="flex items-center justify-between pt-2">
      <span className="text-2xl font-bold text-text-primary-token">Assets</span>
      <span className="text-sm font-medium text-text-tertiary-token">All</span>
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

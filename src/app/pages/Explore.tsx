import React, { FC, useCallback, useEffect, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import Header from 'app/layouts/PageLayout/Header';
import { ChainInstabilityBanner } from 'components/ChainInstabilityBanner';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { ActionButtons } from 'components/explore/ActionButtons';
import { PriceChangeBadge } from 'components/explore/PriceChangeBadge';
import { MIDEN_NETWORK_NAME, MIDEN_FAUCET_ENDPOINTS } from 'lib/miden-chain/constants';
import {
  hasQueuedTransactions,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { setFaucetIdSetting, useAccount, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { openFaucetWebview } from 'lib/mobile/faucet-webview';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import { navigate } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';

import MainBanner from './Explore/MainBanner';
import Tokens from './Explore/Tokens';

const Explore: FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const { signTransaction } = useMidenContext();

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;

  const midenNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return [];
    }

    return claimableNotes.filter(note => note!.faucetId === midenFaucetId);
  }, [claimableNotes, midenFaucetId, shouldAutoConsume]);

  const selfClaimableNotes = useMemo(() => {
    if (!claimableNotes) return [];
    return claimableNotes.filter(note => note!.faucetId !== midenFaucetId);
  }, [claimableNotes, midenFaucetId]);

  const hasAutoConsumableNotes = useMemo(() => {
    return midenNotes.length > 0;
  }, [midenNotes]);

  const autoConsumeMidenNotes = useCallback(async () => {
    if (!shouldAutoConsume || !hasAutoConsumableNotes) {
      return;
    }

    // Filter to only notes not already being claimed
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
      // On extension: fire-and-forget — SW handles processing
      requestSWTransactionProcessing();
    } else {
      // Process auto-consume transactions silently in the background (no modal/tab)
      startBackgroundTransactionProcessing(signTransaction);
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

  const { data: queuedDbTransactions } = useRetryableSWR(
    [`has-queued-transactions`, address],
    async () => hasQueuedTransactions(),
    {
      revalidateOnMount: true,
      refreshInterval: 15_000,
      dedupingInterval: 5_000
    }
  );

  // Check if user explicitly dismissed the transaction modal (prevents auto-reopen)
  const isTransactionModalDismissedByUser = useWalletStore(state => state.isTransactionModalDismissedByUser);

  useEffect(() => {
    // On mobile, don't auto-open the modal - it's intrusive and blocks UI
    // The modal is opened explicitly when user initiates send/claim
    if (isMobile()) return;
    // Don't auto-open if user explicitly dismissed the modal (they clicked Hide)
    if (isTransactionModalDismissedByUser) return;
    if (queuedDbTransactions) useWalletStore.getState().openTransactionModal();
  }, [queuedDbTransactions, isTransactionModalDismissedByUser]);

  useEffect(() => {
    // 6-17-25 Force wallet reset if account is still using hex address
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

  if (isHexAddress(address)) {
    return null;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden text-heading-gray font-geist">
      <div className="flex-shrink-0">
        <ConnectivityIssueBanner />
        <ChainInstabilityBanner />
        <Header />
        <div className={classNames('flex flex-col justify-start', 'pt-4 px-4')}>
          <div className="flex flex-col justify-center items-center pb-4">
            <MainBanner />
            <PriceChangeBadge account={account} />
          </div>
          <ActionButtons address={address} claimableCount={selfClaimableNotes.length} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pt-2">
        <div className={classNames('bg-transparent')}>
          <Tokens />
        </div>
      </div>
    </div>
  );
};

export default Explore;

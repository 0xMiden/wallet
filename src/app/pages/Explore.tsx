import React, { FC, useCallback, useEffect, useMemo } from 'react';

import classNames from 'clsx';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import Header from 'app/layouts/PageLayout/Header';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { ActionButtons } from 'components/explore/ActionButtons';
import { PriceChangeBadge } from 'components/explore/PriceChangeBadge';
import { MIDEN_NETWORK_NAME, MIDEN_FAUCET_ENDPOINTS } from 'lib/miden-chain/constants';
import {
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { setFaucetIdSetting, useAccount, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { isExtension } from 'lib/platform';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';
import { navigate } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';

import MainBanner from './Explore/MainBanner';
import Tokens from './Explore/Tokens';

const Explore: FC = () => {
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

  // NOTE: We used to auto-open the transaction-progress modal on Explore mount
  // whenever `hasQueuedTransactions()` returned true. That was meant to restore
  // tx progress visibility after a page reload, but it has a nasty side effect:
  // after ANY reload (including one triggered from a claim flow or the popup
  // reopening), the user lands on Explore, the modal auto-opens over whatever
  // they were trying to do next, and — because it's a z-index:9999 portal with
  // `shouldCloseOnOverlayClick` gated on transactionComplete — it blocks the
  // entire UI until the SW finishes processing. Surfaced by the E2E stress
  // suite: wallet-B op#24 send stayed queued, B's page reloaded during the next
  // claim cycle, Explore auto-opened the modal, and every subsequent navigate
  // to /send found the TST token row behind an unclickable overlay. Dropped
  // here; background tx processing continues in the SW regardless, and any
  // explicit user send still opens the modal via SendManager.

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
        <Header />
        <div className={classNames('flex flex-col justify-start', 'pt-4 px-4')}>
          <div className="flex flex-col justify-center items-center pb-4">
            <MainBanner />
            <PriceChangeBadge account={account} />
          </div>
          <ActionButtons address={address} claimableCount={selfClaimableNotes.length} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pt-2 pb-20">
        <Tokens />
      </div>
    </div>
  );
};

export default Explore;

import React, { useMemo } from 'react';

import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import { useClaimFloorBaseFee } from 'app/hooks/useVerificationBaseFee';
import HomePrompts from 'app/templates/HomePrompts';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { excludeAutoManagedNotes } from 'lib/miden/front/auto-managed-notes';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { isAutoConsumeEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';

import { useCommandPrivacy } from './useCommandPrivacy';

/** This remains Command's single balance-polling owner and keeps the real Home notice lifecycle. */
export function CommandHomePrompts(): React.ReactElement {
  const [maskMonetaryValues] = useCommandPrivacy();
  const account = useAccount();
  const metadata = useAllTokensBaseMetadata();
  const { data: balances = [], isLoading: balancesLoading } = useAllBalances(account.publicKey, metadata);
  const { data: claimableNotes, isFallback: claimableNotesAreCached } = useClaimableNotes(account.publicKey);
  const feeFaucetId = useNativeFeeFaucetId();
  const claimFloorBaseFee = useClaimFloorBaseFee();
  const shouldAutoConsume = isAutoConsumeEnabled();
  const tokenPrices = useWalletStore(state => state.tokenPrices);
  const manuallyClaimableNotes = useMemo(
    () => excludeAutoManagedNotes(claimableNotes, feeFaucetId, shouldAutoConsume, claimFloorBaseFee),
    [claimableNotes, feeFaucetId, shouldAutoConsume, claimFloorBaseFee]
  );

  return (
    <HomePrompts
      account={account}
      balances={balances}
      balancesLoading={balancesLoading}
      claimableNotes={manuallyClaimableNotes}
      fundingNotes={claimableNotesAreCached ? undefined : claimableNotes}
      tokenPrices={tokenPrices}
      maskMonetaryValues={maskMonetaryValues}
      requireReadableHiddenNotes
    />
  );
}

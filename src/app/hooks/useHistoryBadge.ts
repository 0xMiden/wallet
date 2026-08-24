import { useMemo } from 'react';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { isAutoConsumeActive } from 'lib/settings/helpers';

/**
 * Hook that returns whether there are auto-consumable notes (for the history badge).
 * Extracted from Explore page logic to share with TabLayout.
 */
export function useHistoryBadge(): boolean {
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);
  const shouldAutoConsume = isAutoConsumeActive();

  const hasAutoConsumableNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return false;
    }

    const midenNotes = claimableNotes.filter(note => note!.faucetId === midenFaucetId);
    return midenNotes.length > 0;
  }, [claimableNotes, midenFaucetId, shouldAutoConsume]);

  return hasAutoConsumableNotes;
}

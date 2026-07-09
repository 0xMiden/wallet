import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';

/**
 * Whether the account has any claimable (unclaimed) notes.
 * Drives the red-dot indicators on the Activity tab and the
 * pending-notes header button.
 */
export function useHasUnclaimedNotes(): boolean {
  const account = useAccount();
  const { data: claimableNotes } = useClaimableNotes(account.publicKey);
  return (claimableNotes?.length ?? 0) > 0;
}

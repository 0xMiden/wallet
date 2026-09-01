import { useAccount } from 'lib/miden/front';
import { useManuallyClaimableNotes } from 'lib/miden/front/auto-managed-notes';

/**
 * Whether the account has any notes the user has to claim by hand.
 * Drives the red-dot indicators on the Activity tab and the
 * pending-notes header button. Notes the wallet auto-consumes are
 * excluded — there is nothing for the user to do about them (#811).
 */
export function useHasUnclaimedNotes(): boolean {
  const account = useAccount();
  const { data: claimableNotes } = useManuallyClaimableNotes(account.publicKey);
  return (claimableNotes?.length ?? 0) > 0;
}

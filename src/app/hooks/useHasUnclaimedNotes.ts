import { useAccount } from 'lib/miden/front';
import { useManuallyClaimableNotes } from 'lib/miden/front/auto-managed-notes';

/**
 * Whether the account has any notes the user has to claim by hand. Notes the
 * wallet auto-consumes are excluded, since there is nothing for the user to do
 * about them (#811).
 */
export function useHasUnclaimedNotes(): boolean {
  const account = useAccount();
  const { data: claimableNotes } = useManuallyClaimableNotes(account.publicKey);
  return (claimableNotes?.length ?? 0) > 0;
}

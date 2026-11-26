import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import { GUARDIAN_PENDING_HOLD_SEC } from 'lib/miden/transaction/verdict-rules';

export { DEFAULT_NETWORK, MIDEN_NETWORK_NAME } from '../../../src/lib/miden-chain/networks-config';
export { holdsNotes } from '../../../src/lib/miden/transaction/verdict-rules';

const account = { publicKey: 'fixture-account' };
const claimId = 'fixture-claim';
const noteId = 'fixture-note';
const notes: ClaimableNoteWithMetadata[] = [
  {
    id: noteId,
    faucetId: 'fixture-faucet',
    amount: '5000000',
    isBeingClaimed: true,
    claimingTxId: claimId,
    type: 'unknown',
    metadata: { name: 'Example token', symbol: 'TOK', decimals: 6 }
  }
];
const now = Math.floor(Date.now() / 1000);
const row: ITransaction = {
  id: claimId,
  type: 'consume',
  noteId,
  accountId: account.publicKey,
  status: ITransactionStatus.Failed,
  initiatedAt: now - 600,
  completedAt: now - 2,
  faucetId: 'fixture-faucet',
  amount: 0n,
  displayMessage: 'Synthetic failed claim',
  displayIcon: 'FAILED',
  error: 'Transaction was interrupted when the browser closed',
  submitEvidence: [
    { attemptId: 'fixture-attempt', capturedAt: now - GUARDIAN_PENDING_HOLD_SEC + 90, source: 'stage', candidateKept: true }
  ]
};
const nothing = new Set<string>();
const claim = {
  account,
  safeClaimableNotes: notes,
  isFetchingNotes: false,
  isDelegatedProvingEnabled: false,
  checkingNoteIds: nothing,
  invalidNoteIds: nothing,
  retriableNoteIds: nothing,
  retriableTxIds: new Map<string, string>()
};
const balances = { data: [], isLoading: false };
const metadata = {};
const bridge = { network: 'fixture', status: 'ready', config: null, derived: null, lastFetch: null };

function unavailable(): never {
  throw new Error('Live wallet operations are unavailable in this fixture');
}

export default function useUnavailableFee() {
  return null;
}

export class ClaimFeeRefusedError extends Error {}
export class CalendarRecallReviewRequiredError extends Error {}

export const isGuardianUnreachableError = () => false;
export const isGuardianRequestTimeout = () => false;
export const pendingNoteUnreadKey = (id: string) => `note:${id}`;

export const useClaimNotes = () => claim;
export const useAllBalances = () => balances;
export const useAllTokensBaseMetadata = () => metadata;
export const useMidenContext = () => ({ signTransaction: unavailable });
export const useBridgeConfigSnapshot = () => bridge;
export const midenTokenLabel = (_snapshot: unknown, _faucetId: string, symbol: string) => symbol;
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const useUserVisibleError = () => undefined;
export const getEffectiveRpcUrl = () => 'fixture://local';
export const getEffectiveNetworkName = () => 'fixture';
export const agglayerDeliverySenders = async () => new Set();
export const reportNoteClaim = unavailable;
export const initiateConsumeTransaction = unavailable;
export const queueConsumeNotes = unavailable;
export const requestSWTransactionProcessing = unavailable;
export const requeueFailedTransaction = unavailable;
export const startBackgroundTransactionProcessing = unavailable;
export const zustandProvider = {};
export const transactions = {
  where(field: string) {
    return {
      anyOf(ids: string[]) {
        return { toArray: async () => (field === 'id' && ids.includes(row.id) ? [row] : []) };
      }
    };
  }
};
export const subscribeToLiveQuery = <T,>(
  source: () => Promise<T>,
  observer: { next: (result: T) => void; error: (error: unknown) => void }
) => {
  let active = true;
  void source().then(
    result => {
      if (active) observer.next(result);
    },
    error => {
      if (active) observer.error(error);
    }
  );
  return () => {
    active = false;
  };
};

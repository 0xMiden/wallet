import { v4 as uuid } from 'uuid';
import { isHash, parseUnits, type Hash } from 'viem';

import type { IBridgedReceiveExtraInputs, IBridgedSendExtraInputs, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { walletBridgeProvider } from './core/provider';
import { quoteAmounts } from './core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from './core/review';
import { configKey } from './core/routes';
import { isValidAmount } from './core/rules';
import { parseBridgeApproval, type BridgeApproval } from './evm/approval';
import { parseSourceTransaction, replacementReason, type SourceTransaction } from './evm/source-transaction';

export interface BridgeOperationInput {
  operationId: string;
  review: ReviewedTransfer;
}
export interface BridgeSourceAttempt {
  phase: 'running' | 'known' | 'uncertain';
  hash?: Hash;
  intentNonce?: string;
  transaction?: SourceTransaction;
}
export interface BridgeOperationSnapshot extends BridgeOperationInput {
  version: 1;
  owner: 'wallet';
  revision: string;
  walletScope?: Pick<AccountScope, 'network' | 'rpcUrl'>;
  sourceAttempt?: BridgeSourceAttempt;
  approvals?: BridgeApproval[];
}

export const captureBridgeWalletScope = (): Pick<AccountScope, 'network' | 'rpcUrl'> => ({
  network: getEffectiveNetworkName(),
  rpcUrl: getEffectiveRpcUrl()
});

function metadataOf(row: ITransaction): unknown {
  const inputs: unknown = row.extraInputs;
  return inputs && typeof inputs === 'object' ? Reflect.get(inputs, 'bridgeOperation') : undefined;
}
export function hasBridgeOperation(row: ITransaction): boolean {
  const inputs: unknown = row.extraInputs;
  return (
    inputs !== null && typeof inputs === 'object' && Object.prototype.hasOwnProperty.call(inputs, 'bridgeOperation')
  );
}
function isOperation(value: unknown): value is BridgeOperationSnapshot {
  return (
    value !== null &&
    typeof value === 'object' &&
    Reflect.get(value, 'version') === 1 &&
    Reflect.get(value, 'owner') === 'wallet' &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'revision') === 'string' &&
    Reflect.get(value, 'review') !== null &&
    typeof Reflect.get(value, 'review') === 'object'
  );
}
/** Shape alone is never source permission; admission/claim also checks provenance, terms and current scope. */
export function bridgeOperationOf(row: ITransaction): BridgeOperationSnapshot | undefined {
  const value = metadataOf(row);
  return isOperation(value) ? value : undefined;
}
function localBridgeRow(row: ITransaction): boolean {
  return (row.type === 'bridged-receive' || row.type === 'bridged-send') && !row.restoredFromBackup && !row.recovered;
}
function assertScope(scope: BridgeOperationSnapshot['walletScope']): void {
  if (!scope || scope.network !== getEffectiveNetworkName() || !scope.rpcUrl || scope.rpcUrl !== getEffectiveRpcUrl())
    throw new Error('Bridge wallet scope changed');
}
function reviewKey(review: ReviewedTransfer): string {
  const quote = review.quote;
  return configKey({
    ...review,
    quote:
      quote?.kind === 'cctp'
        ? {
            ...quote,
            authorization: { ...quote.authorization, feeTotalAmount: quote.authorization.feeTotalAmount.toString() }
          }
        : quote
  });
}

function assertRowBinding(row: ITransaction, review: ReviewedTransfer): void {
  const { route, accounts, amount, quote } = review;
  const inputs: IBridgedReceiveExtraInputs | IBridgedSendExtraInputs | undefined = row.extraInputs;
  const receiving = route.mode === 'receive';
  const miden = receiving ? route.destination : route.source;
  const evm = receiving ? route.source : route.destination;
  const chain = route.recovery.config.supportedEvmChains[evm.network];
  const nativeAmount = receiving ? quote?.received : amount;
  if (
    !localBridgeRow(row) ||
    !quote ||
    !inputs ||
    !chain ||
    miden.kind !== 'miden' ||
    row.type !== (receiving ? 'bridged-receive' : 'bridged-send') ||
    inputs.provider !== walletBridgeProvider(route.provider) ||
    !sameWalletAccountId(row.accountId, accounts.midenAccount) ||
    !row.faucetId ||
    !sameWalletAccountId(row.faucetId, miden.faucetId) ||
    typeof nativeAmount !== 'string' ||
    !isValidAmount(nativeAmount) ||
    row.amount !== parseUnits(nativeAmount, miden.decimals)
  )
    throw new Error('Bridge operation terms changed');
  if (receiving) {
    const receive: IBridgedReceiveExtraInputs = row.extraInputs;
    if (
      receive.sourceAddress.toLowerCase() !== accounts.evmAddress.toLowerCase() ||
      (receive.sourceChainId ?? receive.agglayerRoute?.chainId) !== chain.chainId ||
      receive.sourceAmount !== quoteAmounts(route, quote).sourceTotal
    )
      throw new Error('Bridge operation terms changed');
  } else {
    const send: IBridgedSendExtraInputs = row.extraInputs;
    const destinationNetwork = route.provider === 'agglayer' ? send.agglayerRoute?.evmNetworkId : chain.chainId;
    if (
      send.destinationAddress.toLowerCase() !== accounts.evmAddress.toLowerCase() ||
      send.destinationNetwork !== destinationNetwork
    )
      throw new Error('Bridge operation terms changed');
  }
  if (route.provider === 'agglayer') {
    const expected = selectAgglayerRecoveryConfig(
      {
        network: route.recovery.network,
        config: route.recovery.config,
        derived: route.recovery.derived,
        status: 'ready',
        lastFetch: null
      },
      chain.chainId
    );
    if (!expected || configKey(inputs.agglayerRoute) !== configKey(expected))
      throw new Error('Bridge operation route changed');
  }
  if (
    route.provider === 'epoch' &&
    inputs.epochAllocatorUrl !== route.recovery.config['bridge-providers'].epoch.allocatorUrl
  )
    throw new Error('Bridge operation route changed');
}

function assertBridgeMinimum(row: ITransaction, review: ReviewedTransfer): void {
  const received = review.quote?.received;
  if (
    row.amount === undefined ||
    row.amount <= 0n ||
    (review.route.mode === 'receive' &&
      (typeof received !== 'string' ||
        /[1-9]/.test((received.split('.')[1] ?? '').slice(review.route.destination.decimals))))
  )
    throw new Error('Bridge minimum is not representable');
}

export function assertBridgeOperationCurrent(row: ITransaction, operation: BridgeOperationSnapshot): void {
  assertRowBinding(row, operation.review);
  assertBridgeMinimum(row, operation.review);
  assertScope(operation.walletScope);
  assertReviewedBridge(operation.review, operation.review, Date.now());
}

// shortcut: scans every row kind for historical aliases; add an operation-id index if large histories slow admission.
async function operationRows(operationId: string): Promise<ITransaction[]> {
  return Repo.transactions
    .filter(row => {
      const metadata = metadataOf(row);
      return metadata !== null && typeof metadata === 'object' && Reflect.get(metadata, 'operationId') === operationId;
    })
    .toArray();
}
export class BridgeOperationAlreadyAdmittedError extends Error {
  constructor(readonly rowId: string) {
    super('Bridge operation is already admitted');
  }
}

/** Called only inside the native admission's transaction; it never inserts or bypasses spending admission. */
export async function prepareBridgeOperation(
  row: ITransaction,
  input: BridgeOperationInput,
  capturedScope: Pick<AccountScope, 'network' | 'rpcUrl'>
): Promise<BridgeOperationSnapshot> {
  if (!input.operationId.trim()) throw new Error('Missing bridge operation identity');
  assertRowBinding(row, input.review);
  const existing = await operationRows(input.operationId);
  if (existing.length) {
    const previous = existing[0];
    const operation = previous && bridgeOperationOf(previous);
    if (
      existing.length !== 1 ||
      !previous ||
      !operation ||
      !localBridgeRow(previous) ||
      reviewKey(operation.review) !== reviewKey(input.review)
    )
      throw new Error('Bridge operation identity changed');
    assertRowBinding(previous, operation.review);
    throw new BridgeOperationAlreadyAdmittedError(previous.id);
  }
  assertBridgeMinimum(row, input.review);
  assertScope(capturedScope);
  assertReviewedBridge(input.review, input.review, Date.now());
  if (capturedScope.network !== input.review.route.recovery.network) throw new Error('Bridge wallet scope changed');
  return {
    version: 1,
    owner: 'wallet',
    operationId: input.operationId,
    revision: uuid(),
    walletScope: { ...capturedScope },
    review: structuredClone(input.review)
  };
}

export async function claimBridgeSourceAttempt(
  operationId: string,
  expectedRevision: string
): Promise<'claimed' | 'already-running' | 'uncertain'> {
  try {
    return await Repo.db.transaction('rw', Repo.transactions, async () => {
      const rows = await operationRows(operationId);
      const row = rows[0];
      const operation = row && bridgeOperationOf(row);
      if (rows.length !== 1 || !row || row.type !== 'bridged-receive' || !operation || !localBridgeRow(row))
        return 'uncertain';
      if (operation.sourceAttempt)
        return operation.sourceAttempt.phase === 'uncertain' ? 'uncertain' : 'already-running';
      const inputs: IBridgedReceiveExtraInputs = row.extraInputs;
      if (
        operation.revision !== expectedRevision ||
        inputs.phase !== 'submitting' ||
        inputs.evmTxHash ||
        inputs.intentNonce
      )
        return 'uncertain';
      assertBridgeOperationCurrent(row, operation);
      await Repo.transactions.update(row.id, {
        'extraInputs.bridgeOperation': {
          ...operation,
          revision: uuid(),
          sourceAttempt: { phase: 'running' }
        }
      });
      return 'claimed';
    });
  } catch {
    return 'uncertain';
  }
}

export async function recordBridgeSourceAttempt(
  operationId: string,
  revision: string,
  known: Omit<BridgeSourceAttempt, 'phase'> & { phase?: 'uncertain' }
): Promise<boolean> {
  if (
    (known.hash !== undefined && !isHash(known.hash)) ||
    (known.intentNonce !== undefined && !known.intentNonce.trim())
  )
    throw new Error('Invalid bridge source identity');
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const rows = await operationRows(operationId);
    const row = rows[0];
    const operation = row && bridgeOperationOf(row);
    if (
      rows.length !== 1 ||
      !row ||
      !operation ||
      !localBridgeRow(row) ||
      operation.revision !== revision ||
      !operation.sourceAttempt
    )
      return false;
    assertRowBinding(row, operation.review);
    const previous = operation.sourceAttempt;
    if (
      (previous.hash && known.hash && previous.hash.toLowerCase() !== known.hash.toLowerCase()) ||
      (previous.intentNonce && known.intentNonce && previous.intentNonce !== known.intentNonce)
    )
      return false;
    const transaction = known.transaction === undefined ? undefined : parseSourceTransaction(known.transaction);
    if (transaction) {
      const route = operation.review.route;
      const chain = route.recovery.config.supportedEvmChains[route.source.network];
      if (
        transaction.hash.toLowerCase() !== (known.hash ?? previous.hash)?.toLowerCase() ||
        transaction.chainId !== chain?.chainId ||
        transaction.from.toLowerCase() !== operation.review.accounts.evmAddress.toLowerCase()
      )
        return false;
      if (previous.transaction) {
        try {
          if (replacementReason(previous.transaction, transaction) !== 'repriced') return false;
        } catch {
          return false;
        }
      }
    }
    const attempt: BridgeSourceAttempt = {
      ...previous,
      ...known,
      hash: previous.hash ?? known.hash,
      intentNonce: previous.intentNonce ?? known.intentNonce,
      transaction: previous.transaction ?? transaction,
      phase: previous.hash || previous.intentNonce || known.hash || known.intentNonce ? 'known' : 'uncertain'
    };
    await Repo.transactions.update(row.id, {
      'extraInputs.bridgeOperation': { ...operation, sourceAttempt: attempt },
      ...(attempt.hash && { 'extraInputs.evmTxHash': attempt.hash }),
      ...(attempt.intentNonce && { 'extraInputs.intentNonce': attempt.intentNonce })
    });
    return true;
  });
}

/** True means a reference was persisted, never consent, sufficient allowance or permission to fund/retry. */
export async function recordBridgeApproval(
  operationId: string,
  revision: string,
  approval: BridgeApproval
): Promise<boolean> {
  return Repo.db.transaction('rw', Repo.transactions, async () => {
    const rows = await operationRows(operationId);
    const row = rows[0];
    const operation = row && bridgeOperationOf(row);
    if (
      rows.length !== 1 ||
      !row ||
      !operation ||
      !localBridgeRow(row) ||
      operation.revision !== revision ||
      !operation.sourceAttempt
    )
      return false;
    assertRowBinding(row, operation.review);
    const reference = parseBridgeApproval(approval);
    const { route, accounts } = operation.review;
    const chain = route.recovery.config.supportedEvmChains[route.source.network];
    if (
      route.source.kind !== 'erc20' ||
      reference.chainId !== chain?.chainId ||
      reference.account.toLowerCase() !== accounts.evmAddress.toLowerCase() ||
      reference.token.toLowerCase() !== route.source.address.toLowerCase()
    )
      throw new Error('Token approval terms changed');
    const approvals = operation.approvals ?? [];
    const original = reference.originalTransaction;
    if (original) {
      const first = approvals.find(item => {
        const known = item.originalTransaction ?? (item.replacementReason === undefined ? item.transaction : undefined);
        return (
          known &&
          (known.hash.toLowerCase() === original.hash.toLowerCase() ||
            (item.chainId === reference.chainId &&
              item.account.toLowerCase() === reference.account.toLowerCase() &&
              item.token.toLowerCase() === reference.token.toLowerCase() &&
              item.spender.toLowerCase() === reference.spender.toLowerCase() &&
              BigInt(item.amount) === BigInt(reference.amount) &&
              known.nonce === original.nonce))
        );
      });
      const known = first?.originalTransaction ?? first?.transaction;
      if (
        known &&
        (known.hash.toLowerCase() !== original.hash.toLowerCase() || replacementReason(known, original) !== 'repriced')
      )
        throw new Error('Original token approval identity changed');
    }
    const previous = approvals.find(item => item.hash.toLowerCase() === reference.hash.toLowerCase());
    if (previous) return configKey(previous) === configKey(reference);
    await Repo.transactions.update(row.id, {
      'extraInputs.bridgeOperation': { ...operation, approvals: [...approvals, reference] }
    });
    return true;
  });
}

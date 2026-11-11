import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MAINNET_LOOP_LOSS_CAP, realizedMainnetLoopLoss } from './mainnet-loop-budget';
import { tokenValueUsdMicro } from './mainnet-one-click-plan';
import { holding, mainnetSwapNextAction, type SavedSwapHolding, type SwapLoopPhase } from './mainnet-swap-checkpoint';

export interface EpochEvmSnapshot {
  chainId: 1 | 42161;
  account: string;
  token: string;
  compact: string;
  allocator: string;
  tokenBalance: string;
  nativeBalance: string;
  tokenUsdMicros: string;
  nativeUsdMicros: string;
}
export interface EpochEvmTransaction {
  kind: 'approve' | 'deposit' | 'withdraw' | 'cancel';
  nonce: number;
  hash: string;
  feeWei?: string;
}
export interface MainnetEpochCheckpoint {
  version: 1;
  network: 'mainnet';
  account: string;
  accountHex: string;
  sourceRunId: string;
  authorizationRunId: string;
  phase: SwapLoopPhase;
  createdAt: string;
  pricedAt: string;
  updatedAt: string;
  native: SavedSwapHolding;
  evm: EpochEvmSnapshot;
  allocatorUrl: string;
  virtualChainId: number;
  principal: string;
  forwardMinimum: string;
  reverseMinimum: string;
  lossBudgetUsdMicros: string;
  feeBudget: string;
  evmFeeBudget: string;
  paidMidenFees: string;
  paidEvmFees: string;
  forwardNonce: string;
  forwardNoteId?: string;
  forwardMidenTxId?: string;
  forwardEvmTxHash?: string;
  forwardReceived?: string;
  reverseNonce?: string;
  returnAmount?: string;
  evmNonceBefore?: number;
  transactions?: EpochEvmTransaction[];
  returnNoteId?: string;
  returnMidenTxId?: string;
  reverseReceived?: string;
  after?: { native: string; evmToken: string; evmNative: string };
  realizedCostUsdMicros?: string;
}
export interface EpochIntentEvidence {
  nonce: string;
  sponsor: string;
  midenAccount: string;
  tokenIn: string;
  tokenOut: string;
  tokenInAmount: string;
  minTokenOut: string;
  destinationChainId: number;
  recipient: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < (1n << 256n);
const positive = (value: unknown): value is string => amount(value) && BigInt(value) > 0n;
const evmAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const midenId = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{30}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const ROOT_KEYS = [
  'version', 'network', 'account', 'accountHex', 'sourceRunId', 'authorizationRunId', 'phase',
  'createdAt', 'pricedAt', 'updatedAt', 'native', 'evm', 'allocatorUrl', 'virtualChainId',
  'principal', 'forwardMinimum', 'reverseMinimum', 'lossBudgetUsdMicros', 'feeBudget', 'evmFeeBudget',
  'paidMidenFees', 'paidEvmFees', 'forwardNonce', 'forwardNoteId', 'forwardMidenTxId', 'forwardEvmTxHash',
  'forwardReceived', 'reverseNonce', 'returnAmount', 'evmNonceBefore', 'transactions', 'returnNoteId',
  'returnMidenTxId', 'reverseReceived', 'after', 'realizedCostUsdMicros'
];

function evmSnapshot(value: unknown): value is EpochEvmSnapshot {
  if (!record(value)) return false;
  return onlyKeys(value, ['chainId', 'account', 'token', 'compact', 'allocator', 'tokenBalance',
    'nativeBalance', 'tokenUsdMicros', 'nativeUsdMicros']) &&
    (value.chainId === 1 || value.chainId === 42161) &&
    ['account', 'token', 'compact', 'allocator'].every(key => evmAddress(value[key])) &&
    amount(value.tokenBalance) && amount(value.nativeBalance) &&
    positive(value.tokenUsdMicros) && positive(value.nativeUsdMicros);
}

function assertCheckpoint(value: unknown): asserts value is MainnetEpochCheckpoint {
  if (!record(value) || !onlyKeys(value, ROOT_KEYS) || value.version !== 1 || value.network !== 'mainnet' ||
      typeof value.account !== 'string' || !/^mm1[a-z0-9]{20,150}(?:_[a-z0-9]{1,50})?$/.test(value.account) ||
      !midenId(value.accountHex) || typeof value.sourceRunId !== 'string' || !/^\d{1,25}$/.test(value.sourceRunId) ||
      typeof value.authorizationRunId !== 'string' || !/^\d{1,25}$/.test(value.authorizationRunId) ||
      typeof value.phase !== 'string' || !['forward-authorized', 'forward-settled', 'reverse-authorized',
        'complete', 'cancelled', 'unspent', 'recovery-required'].includes(value.phase) ||
      !timestamp(value.createdAt) || !timestamp(value.pricedAt) || !timestamp(value.updatedAt) ||
      !holding(value.native) || value.native.symbol !== 'USDCX' || value.native.decimals !== 6 ||
      !evmSnapshot(value.evm) ||
      typeof value.allocatorUrl !== 'string' || value.allocatorUrl.length > 512 ||
      typeof value.virtualChainId !== 'number' || !Number.isSafeInteger(value.virtualChainId) || value.virtualChainId <= 0 ||
      !positive(value.principal) || !positive(value.forwardMinimum) || !positive(value.reverseMinimum) ||
      !positive(value.lossBudgetUsdMicros) || BigInt(value.lossBudgetUsdMicros) > MAINNET_LOOP_LOSS_CAP ||
      !positive(value.feeBudget) || !positive(value.evmFeeBudget) || !amount(value.paidMidenFees) ||
      !amount(value.paidEvmFees) || !amount(value.forwardNonce)) {
    throw new Error('Invalid mainnet Epoch authorization checkpoint');
  }
  const url = new URL(value.allocatorUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      BigInt(value.principal) + BigInt(value.feeBudget) > BigInt(value.native.balance) ||
      tokenValueUsdMicro(BigInt(value.principal), 6, BigInt(value.native.usdMicros), true) > 10_000_000n ||
      BigInt(value.paidMidenFees) > BigInt(value.feeBudget) || BigInt(value.paidEvmFees) > BigInt(value.evmFeeBudget) ||
      tokenValueUsdMicro(BigInt(value.feeBudget), 6, BigInt(value.native.usdMicros), true) +
        tokenValueUsdMicro(BigInt(value.evmFeeBudget), 18, BigInt(value.evm.nativeUsdMicros), true) > BigInt(value.lossBudgetUsdMicros)) {
    throw new Error('Epoch authorization exceeds its balance, fee or loss bounds');
  }
  for (const key of ['forwardNoteId', 'forwardMidenTxId', 'forwardEvmTxHash', 'returnNoteId', 'returnMidenTxId']) {
    if (value[key] !== undefined && !hash(value[key])) throw new Error('Invalid Epoch note or transaction identity');
  }
  for (const key of ['forwardReceived', 'reverseNonce', 'returnAmount', 'reverseReceived', 'realizedCostUsdMicros']) {
    if (value[key] !== undefined && !amount(value[key])) throw new Error('Invalid Epoch amount or protocol nonce');
  }
  if (value.evmNonceBefore !== undefined && (typeof value.evmNonceBefore !== 'number' ||
      !Number.isSafeInteger(value.evmNonceBefore) || value.evmNonceBefore < 0)) throw new Error('Invalid Epoch EVM nonce');
  if (value.transactions !== undefined) {
    if (!Array.isArray(value.transactions) || value.transactions.length > 8) throw new Error('Invalid Epoch transactions');
    const seen = new Set<string>();
    for (const tx of value.transactions) {
      if (!record(tx) || !onlyKeys(tx, ['kind', 'nonce', 'hash', 'feeWei']) || typeof tx.kind !== 'string' ||
          !['approve', 'deposit', 'withdraw', 'cancel'].includes(tx.kind) || !hash(tx.hash) || seen.has(tx.hash.toLowerCase()) ||
          typeof tx.nonce !== 'number' || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
          (tx.feeWei !== undefined && !amount(tx.feeWei))) throw new Error('Invalid or duplicate Epoch EVM transaction');
      seen.add(tx.hash.toLowerCase());
    }
  }
  if (value.after !== undefined && (!record(value.after) || !onlyKeys(value.after, ['native', 'evmToken', 'evmNative']) ||
      !amount(value.after.native) || !amount(value.after.evmToken) || !amount(value.after.evmNative))) {
    throw new Error('Invalid Epoch final portfolio');
  }
  if (['forward-settled', 'reverse-authorized', 'complete'].includes(value.phase) &&
      (!hash(value.forwardNoteId) || !hash(value.forwardMidenTxId) || !hash(value.forwardEvmTxHash) ||
       !positive(value.forwardReceived) || BigInt(value.forwardReceived) < BigInt(value.forwardMinimum))) {
    throw new Error('Missing Epoch forward settlement evidence');
  }
  if (['reverse-authorized', 'complete'].includes(value.phase) &&
      (!amount(value.reverseNonce) || !positive(value.returnAmount) || !positive(value.forwardReceived) ||
       BigInt(value.returnAmount) > BigInt(value.forwardReceived) || typeof value.evmNonceBefore !== 'number')) {
    throw new Error('Missing or oversized Epoch reverse authorization');
  }
  if (value.phase === 'complete') {
    if (!hash(value.returnNoteId) || !hash(value.returnMidenTxId) || !positive(value.reverseReceived) ||
        BigInt(value.reverseReceived) < BigInt(value.reverseMinimum) || !amount(value.realizedCostUsdMicros) ||
        !record(value.after) || !amount(value.after.native) || !amount(value.after.evmToken) || !amount(value.after.evmNative) ||
        !Array.isArray(value.transactions) || !value.transactions.some(tx => tx.kind === 'deposit') ||
        !value.transactions.every(tx => amount(tx.feeWei)) || !positive(value.forwardReceived) || !positive(value.returnAmount)) {
      throw new Error('Incomplete Epoch round-trip receipts or balances');
    }
    let fees = 0n;
    for (const tx of value.transactions) {
      if (!amount(tx.feeWei)) throw new Error('Missing all-in Epoch receipt fee');
      fees += BigInt(tx.feeWei);
    }
    if (fees !== BigInt(value.paidEvmFees) || BigInt(value.evm.nativeBalance) - BigInt(value.after.evmNative) !== fees ||
        BigInt(value.native.balance) - BigInt(value.principal) + BigInt(value.reverseReceived) - BigInt(value.paidMidenFees) !== BigInt(value.after.native) ||
        BigInt(value.evm.tokenBalance) + BigInt(value.forwardReceived) - BigInt(value.returnAmount) !== BigInt(value.after.evmToken)) {
      throw new Error('Epoch portfolio contains unattributed credits or debits');
    }
    const cost = realizedMainnetLoopLoss([
      { identity: `miden:${value.native.hex}`, decimals: 6, usdMicros: BigInt(value.native.usdMicros), before: BigInt(value.native.balance), after: BigInt(value.after.native) },
      { identity: `evm:${value.evm.chainId}:token`, decimals: 6, usdMicros: BigInt(value.evm.tokenUsdMicros), before: BigInt(value.evm.tokenBalance), after: BigInt(value.after.evmToken) },
      { identity: `evm:${value.evm.chainId}:native`, decimals: 18, usdMicros: BigInt(value.evm.nativeUsdMicros), before: BigInt(value.evm.nativeBalance), after: BigInt(value.after.evmNative) }
    ]);
    if (cost !== BigInt(value.realizedCostUsdMicros) || cost > BigInt(value.lossBudgetUsdMicros)) {
      throw new Error('Epoch realized cost is inconsistent or exceeds its authorized loss budget');
    }
  }
}

export function parseMainnetEpochCheckpoint(value: unknown): MainnetEpochCheckpoint {
  assertCheckpoint(value);
  return value;
}
export function loadMainnetEpochCheckpoint(path: string): MainnetEpochCheckpoint | undefined {
  try { return parseMainnetEpochCheckpoint(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
export function saveMainnetEpochCheckpoint(path: string, state: MainnetEpochCheckpoint): void {
  parseMainnetEpochCheckpoint(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export const mainnetEpochNextAction = mainnetSwapNextAction;

export function matchAuthorizedEpoch(
  state: MainnetEpochCheckpoint, rows: EpochIntentEvidence[], leg: 'forward' | 'reverse'
): EpochIntentEvidence | undefined {
  const nonce = leg === 'forward' ? state.forwardNonce : state.reverseNonce;
  const input = leg === 'forward' ? state.principal : state.returnAmount;
  if (!amount(nonce) || !positive(input)) throw new Error('Missing authorized Epoch intent');
  const zero = `0x${'0'.repeat(40)}`;
  const tokenIn = leg === 'forward' ? zero : state.evm.token;
  const tokenOut = leg === 'forward' ? state.evm.token : zero;
  const minimum = BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum);
  const matches = rows.filter(row =>
    row.nonce === nonce && row.sponsor.toLowerCase() === state.evm.account.toLowerCase() &&
    row.recipient.toLowerCase() === state.evm.account.toLowerCase() && row.midenAccount === state.accountHex &&
    row.tokenIn.toLowerCase() === tokenIn.toLowerCase() && row.tokenOut.toLowerCase() === tokenOut.toLowerCase() &&
    row.tokenInAmount === input && amount(row.minTokenOut) && BigInt(row.minTokenOut) >= minimum &&
    row.destinationChainId === (leg === 'forward' ? state.evm.chainId : state.virtualChainId)
  );
  if (matches.length > 1) throw new Error('Epoch intent attribution is ambiguous; refusing another spend');
  return matches[0];
}

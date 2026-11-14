import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SavedSwapHolding {
  faucetId: string;
  hex: string;
  symbol: string;
  decimals: number;
  balance: string;
  usdMicros: string;
}
export type SwapLoopPhase =
  | 'forward-authorized'
  | 'forward-settled'
  | 'reverse-authorized'
  | 'complete'
  | 'cancelled'
  | 'unspent'
  | 'recovery-required';
export interface MainnetSwapRequestAuthority {
  nonce: string;
  noteId: string;
  sha256: string;
  canonicalSha256: string;
  orderId: string;
  minimumReceive: string;
  expiresAt: number;
}
export interface MainnetSwapClaimAuthority {
  nonce: string;
  noteId: string;
  amount: string;
  sha256: string;
  canonicalSha256: string;
  requestCanonicalSha256: string;
  expiresAt: number;
}
export interface MainnetSwapCheckpoint {
  version: 1;
  network: 'mainnet';
  account: string;
  sourceRunId: string;
  authorizationRunId?: string;
  recoveredRunId?: string;
  recoveryReturnAuthorizedAt?: string;
  recoveryReturnReplacement?: {
    authorizedAt: string;
    previous: MainnetSwapRequestAuthority;
    previousRunId: string;
    absentAtBlock: number;
  };
  phase: SwapLoopPhase;
  createdAt: string;
  pricedAt: string;
  updatedAt: string;
  offer: SavedSwapHolding;
  request: SavedSwapHolding;
  native: SavedSwapHolding;
  baseFee: string;
  principal: string;
  forwardMinimum: string;
  reverseMinimum: string;
  knownOrderIds: string[];
  feeBudget: string;
  paidFees: string;
  realizedCostUsdMicros?: string;
  lossBudgetUsdMicros?: string;
  forwardOrderId?: string;
  reverseOrderId?: string;
  forwardRequestAuthority?: MainnetSwapRequestAuthority;
  reverseRequestAuthority?: MainnetSwapRequestAuthority;
  forwardClaimAuthority?: MainnetSwapClaimAuthority;
  reverseClaimAuthority?: MainnetSwapClaimAuthority;
  forwardReceived?: string;
  forwardRefunded?: string;
  reverseReceived?: string;
  recoveryClaimNativeBefore?: string;
  returnAmount?: string;
  returnBaseline?: { offer: string; request: string; native: string };
}
export interface SwapOrderEvidence {
  id: string;
  orderId: string;
  account: string;
  offeredFaucet: string;
  requestedFaucet: string;
  offer: string;
  minimumReceive: string;
  initiatedAt: number;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
const address = (value: unknown): value is string =>
  typeof value === 'string' && /^m[a-z]{1,4}1[a-z0-9]{1,150}(?:_[a-z0-9]{1,50})?$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function holding(value: unknown): value is SavedSwapHolding {
  return (
    record(value) &&
    address(value.faucetId) &&
    typeof value.hex === 'string' &&
    /^0x[0-9a-f]{30}$/.test(value.hex) &&
    typeof value.symbol === 'string' &&
    /^[A-Z]{1,12}$/.test(value.symbol) &&
    typeof value.decimals === 'number' &&
    Number.isSafeInteger(value.decimals) &&
    value.decimals >= 0 &&
    value.decimals <= 12 &&
    amount(value.balance) &&
    amount(value.usdMicros) &&
    BigInt(value.usdMicros) > 0n &&
    Object.keys(value).every(key => ['faucetId', 'hex', 'symbol', 'decimals', 'balance', 'usdMicros'].includes(key))
  );
}
function requestAuthority(value: unknown): value is MainnetSwapRequestAuthority {
  return (
    record(value) &&
    typeof value.nonce === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.nonce) &&
    typeof value.noteId === 'string' &&
    /^0x[0-9a-f]{64}$/.test(value.noteId) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.canonicalSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.canonicalSha256) &&
    typeof value.orderId === 'string' &&
    /^(0|[1-9]\d{0,19})$/.test(value.orderId) &&
    typeof value.minimumReceive === 'string' &&
    /^[1-9]\d{0,18}$/.test(value.minimumReceive) &&
    typeof value.expiresAt === 'number' &&
    Number.isSafeInteger(value.expiresAt) &&
    Object.keys(value).every(key =>
      ['nonce', 'noteId', 'sha256', 'canonicalSha256', 'orderId', 'minimumReceive', 'expiresAt'].includes(key)
    )
  );
}
function claimAuthority(value: unknown): value is MainnetSwapClaimAuthority {
  return (
    record(value) &&
    typeof value.nonce === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.nonce) &&
    typeof value.noteId === 'string' &&
    /^0x[0-9a-f]{64}$/.test(value.noteId) &&
    amount(value.amount) &&
    BigInt(value.amount) > 0n &&
    [value.sha256, value.canonicalSha256, value.requestCanonicalSha256].every(
      item => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
    ) &&
    typeof value.expiresAt === 'number' &&
    Number.isSafeInteger(value.expiresAt) &&
    Object.keys(value).every(key =>
      ['nonce', 'noteId', 'amount', 'sha256', 'canonicalSha256', 'requestCanonicalSha256', 'expiresAt'].includes(key)
    )
  );
}
export function valid(value: unknown): value is MainnetSwapCheckpoint {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.network !== 'mainnet' ||
    !address(value.account) ||
    typeof value.sourceRunId !== 'string' ||
    !/^\d{1,25}$/.test(value.sourceRunId) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.pricedAt) ||
    !timestamp(value.updatedAt) ||
    !holding(value.offer) ||
    !holding(value.request) ||
    !holding(value.native) ||
    value.offer.faucetId === value.request.faucetId ||
    !amount(value.baseFee) ||
    BigInt(value.baseFee) <= 0n ||
    !amount(value.principal) ||
    BigInt(value.principal) <= 0n ||
    !amount(value.forwardMinimum) ||
    BigInt(value.forwardMinimum) <= 0n ||
    !amount(value.reverseMinimum) ||
    BigInt(value.reverseMinimum) <= 0n ||
    !amount(value.feeBudget) ||
    !amount(value.paidFees) ||
    BigInt(value.paidFees) > BigInt(value.feeBudget) ||
    !Array.isArray(value.knownOrderIds) ||
    value.knownOrderIds.length > 4096 ||
    !value.knownOrderIds.every(amount)
  )
    return false;
  if (
    ![
      'forward-authorized',
      'forward-settled',
      'reverse-authorized',
      'complete',
      'cancelled',
      'unspent',
      'recovery-required'
    ].includes(String(value.phase))
  )
    return false;
  if (
    value.phase === 'cancelled' &&
    (value.forwardRefunded !== value.principal || value.forwardReceived !== '0' || !amount(value.forwardOrderId))
  )
    return false;
  for (const key of [
    'authorizationRunId',
    'recoveredRunId',
    'realizedCostUsdMicros',
    'forwardOrderId',
    'reverseOrderId',
    'forwardReceived',
    'forwardRefunded',
    'reverseReceived',
    'recoveryClaimNativeBefore',
    'returnAmount'
  ]) {
    if (value[key] !== undefined && !amount(value[key])) return false;
  }
  if (
    value.lossBudgetUsdMicros !== undefined &&
    (typeof value.lossBudgetUsdMicros !== 'string' ||
      !/^[1-9]\d{0,6}$/.test(value.lossBudgetUsdMicros) ||
      BigInt(value.lossBudgetUsdMicros) > 2_000_000n ||
      (amount(value.realizedCostUsdMicros) && BigInt(value.realizedCostUsdMicros) > BigInt(value.lossBudgetUsdMicros)))
  )
    return false;
  if (
    value.returnBaseline !== undefined &&
    (!record(value.returnBaseline) ||
      !amount(value.returnBaseline.offer) ||
      !amount(value.returnBaseline.request) ||
      !amount(value.returnBaseline.native))
  )
    return false;
  if (
    (value.phase === 'reverse-authorized' || value.phase === 'complete') &&
    (!amount(value.forwardOrderId) ||
      !amount(value.forwardReceived) ||
      !amount(value.returnAmount) ||
      !record(value.returnBaseline))
  )
    return false;
  if (value.phase === 'complete' && (!amount(value.reverseOrderId) || !amount(value.reverseReceived))) return false;
  if (
    value.recoveryReturnAuthorizedAt !== undefined &&
    (!timestamp(value.recoveryReturnAuthorizedAt) ||
      Date.parse(value.recoveryReturnAuthorizedAt) < Date.parse(value.createdAt) ||
      Date.parse(value.recoveryReturnAuthorizedAt) > Date.parse(value.updatedAt) ||
      !['reverse-authorized', 'complete', 'recovery-required'].includes(String(value.phase)) ||
      !amount(value.forwardReceived) ||
      !amount(value.returnAmount) ||
      !record(value.returnBaseline))
  )
    return false;
  const forward = value.forwardRequestAuthority;
  const reverse = value.reverseRequestAuthority;
  const pricedAt = Date.parse(value.pricedAt);
  const replacement = value.recoveryReturnReplacement;
  if (
    replacement !== undefined &&
    (!record(replacement) ||
      !timestamp(replacement.authorizedAt) ||
      !timestamp(value.recoveryReturnAuthorizedAt) ||
      !requestAuthority(replacement.previous) ||
      !requestAuthority(forward) ||
      Date.parse(replacement.authorizedAt) <= replacement.previous.expiresAt ||
      Date.parse(replacement.authorizedAt) > Date.parse(value.updatedAt) ||
      replacement.previous.expiresAt <= Date.parse(value.recoveryReturnAuthorizedAt) ||
      replacement.previous.expiresAt > Date.parse(value.recoveryReturnAuthorizedAt) + 300_000 ||
      typeof replacement.previousRunId !== 'string' ||
      !/^\d{1,25}$/.test(replacement.previousRunId) ||
      typeof value.authorizationRunId !== 'string' ||
      replacement.previousRunId === value.authorizationRunId ||
      typeof replacement.absentAtBlock !== 'number' ||
      !Number.isSafeInteger(replacement.absentAtBlock) ||
      replacement.absentAtBlock <= 0 ||
      !Object.keys(replacement).every(key =>
        ['authorizedAt', 'previous', 'previousRunId', 'absentAtBlock'].includes(key)
      ) ||
      !['reverse-authorized', 'complete', 'recovery-required'].includes(String(value.phase)))
  )
    return false;
  const returnStart =
    record(replacement) && timestamp(replacement.authorizedAt)
      ? Date.parse(replacement.authorizedAt)
      : value.recoveryReturnAuthorizedAt === undefined
        ? pricedAt
        : Date.parse(value.recoveryReturnAuthorizedAt);
  const returnDeadline = returnStart + (value.recoveryReturnAuthorizedAt === undefined ? 600_000 : 300_000);
  if (
    forward !== undefined &&
    (!requestAuthority(forward) ||
      forward.orderId !== value.forwardOrderId ||
      BigInt(forward.minimumReceive) < BigInt(value.forwardMinimum) ||
      forward.expiresAt <= pricedAt ||
      forward.expiresAt > pricedAt + 300_000 ||
      value.knownOrderIds.includes(forward.orderId))
  )
    return false;
  if (
    reverse !== undefined &&
    (!requestAuthority(reverse) ||
      reverse.orderId !== value.reverseOrderId ||
      BigInt(reverse.minimumReceive) < BigInt(value.reverseMinimum) ||
      reverse.expiresAt <= returnStart ||
      reverse.expiresAt > returnDeadline ||
      value.knownOrderIds.includes(reverse.orderId) ||
      !['reverse-authorized', 'complete', 'recovery-required'].includes(String(value.phase)))
  )
    return false;
  if (record(replacement) && requestAuthority(replacement.previous) && requestAuthority(reverse)) {
    const previous = replacement.previous;
    if (
      [
        [reverse.nonce, previous.nonce],
        [reverse.noteId, previous.noteId],
        [reverse.orderId, previous.orderId],
        [reverse.sha256, previous.sha256],
        [reverse.canonicalSha256, previous.canonicalSha256]
      ].some(([current, old]) => current === old) ||
      BigInt(reverse.minimumReceive) < BigInt(previous.minimumReceive)
    )
      return false;
  }
  if (
    requestAuthority(forward) &&
    requestAuthority(reverse) &&
    (forward.nonce === reverse.nonce || forward.orderId === reverse.orderId)
  )
    return false;
  for (const [claim, source] of [
    [value.forwardClaimAuthority, forward],
    [value.reverseClaimAuthority, reverse]
  ]) {
    if (claim === undefined) continue;
    if (
      !claimAuthority(claim) ||
      !requestAuthority(source) ||
      claim.noteId === source.noteId ||
      claim.nonce === source.nonce ||
      BigInt(claim.amount) < BigInt(source.minimumReceive) ||
      claim.expiresAt <= Date.parse(value.createdAt) ||
      claim.expiresAt > Date.parse(value.updatedAt) + 300_000 ||
      ['unspent', 'cancelled'].includes(String(value.phase))
    )
      return false;
  }
  if (
    value.recoveryClaimNativeBefore !== undefined &&
    (!amount(value.recoveryClaimNativeBefore) ||
      BigInt(value.recoveryClaimNativeBefore) <= 0n ||
      !requestAuthority(reverse) ||
      !record(value.returnBaseline) ||
      !amount(value.returnBaseline.native) ||
      BigInt(value.recoveryClaimNativeBefore) > BigInt(value.returnBaseline.native) ||
      !['reverse-authorized', 'complete', 'recovery-required'].includes(String(value.phase)))
  )
    return false;
  if (value.phase === 'unspent' && (forward !== undefined || reverse !== undefined)) return false;
  if (value.phase === 'complete' && forward !== undefined && reverse === undefined) return false;
  return Object.keys(value).every(key =>
    [
      'version',
      'network',
      'account',
      'sourceRunId',
      'authorizationRunId',
      'recoveredRunId',
      'recoveryReturnAuthorizedAt',
      'recoveryReturnReplacement',
      'phase',
      'createdAt',
      'pricedAt',
      'updatedAt',
      'offer',
      'request',
      'native',
      'baseFee',
      'principal',
      'forwardMinimum',
      'reverseMinimum',
      'knownOrderIds',
      'feeBudget',
      'paidFees',
      'realizedCostUsdMicros',
      'lossBudgetUsdMicros',
      'forwardOrderId',
      'reverseOrderId',
      'forwardRequestAuthority',
      'reverseRequestAuthority',
      'forwardClaimAuthority',
      'reverseClaimAuthority',
      'forwardReceived',
      'forwardRefunded',
      'reverseReceived',
      'recoveryClaimNativeBefore',
      'returnAmount',
      'returnBaseline'
    ].includes(key)
  );
}

export function loadMainnetSwapCheckpoint(path: string): MainnetSwapCheckpoint | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!valid(value)) throw new Error('Invalid mainnet swap checkpoint; inspect recovery state before spending');
  return value;
}
export function saveMainnetSwapCheckpoint(path: string, state: MainnetSwapCheckpoint): void {
  if (!valid(state)) throw new Error('Refusing invalid mainnet swap checkpoint');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function mainnetSwapRequestExpiresAt(
  state: Pick<MainnetSwapCheckpoint, 'pricedAt' | 'recoveryReturnAuthorizedAt' | 'recoveryReturnReplacement'>,
  leg: 'forward' | 'reverse'
): number {
  if (leg === 'forward') return Date.parse(state.pricedAt) + 300_000;
  if (state.recoveryReturnReplacement) return Date.parse(state.recoveryReturnReplacement.authorizedAt) + 300_000;
  return state.recoveryReturnAuthorizedAt === undefined
    ? Date.parse(state.pricedAt) + 600_000
    : Date.parse(state.recoveryReturnAuthorizedAt) + 300_000;
}
export function mainnetSwapNextAction(
  state: Pick<MainnetSwapCheckpoint, 'phase'> | undefined
): 'prepare' | 'reconcile-forward' | 'return' | 'reconcile-reverse' | 'stop' {
  if (!state || state.phase === 'complete' || state.phase === 'cancelled' || state.phase === 'unspent')
    return 'prepare';
  if (state.phase === 'forward-authorized') return 'reconcile-forward';
  if (state.phase === 'forward-settled') return 'return';
  if (state.phase === 'reverse-authorized') return 'reconcile-reverse';
  return 'stop';
}
export function matchAuthorizedSwap(
  state: MainnetSwapCheckpoint,
  rows: SwapOrderEvidence[],
  leg: 'forward' | 'reverse'
): SwapOrderEvidence | undefined {
  const offer = leg === 'forward' ? state.offer : state.request;
  const request = leg === 'forward' ? state.request : state.offer;
  const authority = leg === 'forward' ? state.forwardRequestAuthority : state.reverseRequestAuthority;
  const known = authority?.orderId ?? (leg === 'forward' ? state.forwardOrderId : state.reverseOrderId);
  const matches = rows.filter(
    row =>
      row.account === state.account &&
      row.offeredFaucet === offer.faucetId &&
      row.requestedFaucet === request.faucetId &&
      row.offer === (leg === 'forward' ? state.principal : state.returnAmount) &&
      amount(row.minimumReceive) &&
      BigInt(row.minimumReceive) >= BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum) &&
      (!authority || row.minimumReceive === authority.minimumReceive) &&
      row.initiatedAt >= Math.floor(Date.parse(state.createdAt) / 1000) - 30 &&
      (known ? row.orderId === known : !state.knownOrderIds.includes(row.orderId))
  );
  if (matches.length > 1) throw new Error('Prior swap submission is ambiguous; refusing another spend');
  return matches[0];
}
export function swapProceeds(before: bigint, after: bigint, claimed: bigint, fees: bigint): bigint {
  if ([before, after, claimed, fees].some(value => value < 0n) || after - before !== claimed - fees) {
    throw new Error('Swap balance contains unexplained credits or debits');
  }
  return after - before;
}

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
export type SwapLoopPhase = 'forward-authorized' | 'forward-settled' | 'reverse-authorized' | 'complete' | 'cancelled' | 'unspent' | 'recovery-required';
export interface MainnetSwapCheckpoint {
  version: 1;
  network: 'mainnet';
  account: string;
  sourceRunId: string;
  authorizationRunId?: string;
  recoveredRunId?: string;
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
  forwardOrderId?: string;
  reverseOrderId?: string;
  forwardReceived?: string;
  forwardRefunded?: string;
  reverseReceived?: string;
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
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const amount = (value: unknown): value is string => typeof value === 'string' && /^\d{1,40}$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^m[a-z]{1,4}1[a-z0-9]{1,200}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function holding(value: unknown): value is SavedSwapHolding {
  return record(value) && address(value.faucetId) && typeof value.hex === 'string' && /^0x[0-9a-f]{30}$/.test(value.hex) &&
    typeof value.symbol === 'string' && /^[A-Z]{1,12}$/.test(value.symbol) &&
    typeof value.decimals === 'number' && Number.isSafeInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 12 &&
    amount(value.balance) && amount(value.usdMicros) && BigInt(value.usdMicros) > 0n &&
    Object.keys(value).every(key => ['faucetId', 'hex', 'symbol', 'decimals', 'balance', 'usdMicros'].includes(key));
}
function valid(value: unknown): value is MainnetSwapCheckpoint {
  if (!record(value) || value.version !== 1 || value.network !== 'mainnet' || !address(value.account) ||
      typeof value.sourceRunId !== 'string' || !/^\d{1,25}$/.test(value.sourceRunId) ||
      !timestamp(value.createdAt) || !timestamp(value.pricedAt) || !timestamp(value.updatedAt) ||
      !holding(value.offer) || !holding(value.request) || !holding(value.native) ||
      value.offer.faucetId === value.request.faucetId ||
      !amount(value.baseFee) || BigInt(value.baseFee) <= 0n || !amount(value.principal) || BigInt(value.principal) <= 0n ||
      !amount(value.forwardMinimum) || BigInt(value.forwardMinimum) <= 0n ||
      !amount(value.reverseMinimum) || BigInt(value.reverseMinimum) <= 0n ||
      !amount(value.feeBudget) || !amount(value.paidFees) || BigInt(value.paidFees) > BigInt(value.feeBudget) ||
      !Array.isArray(value.knownOrderIds) || value.knownOrderIds.length > 4096 || !value.knownOrderIds.every(amount)) return false;
  if (!['forward-authorized', 'forward-settled', 'reverse-authorized', 'complete', 'cancelled', 'unspent', 'recovery-required'].includes(String(value.phase))) return false;
  if (value.phase === 'cancelled' && (value.forwardRefunded !== value.principal || value.forwardReceived !== '0' || !amount(value.forwardOrderId))) return false;
  for (const key of ['authorizationRunId', 'recoveredRunId', 'forwardOrderId', 'reverseOrderId', 'forwardReceived', 'forwardRefunded', 'reverseReceived', 'returnAmount']) {
    if (value[key] !== undefined && !amount(value[key])) return false;
  }
  if (value.returnBaseline !== undefined && (!record(value.returnBaseline) ||
      !amount(value.returnBaseline.offer) || !amount(value.returnBaseline.request) || !amount(value.returnBaseline.native))) return false;
  if ((value.phase === 'reverse-authorized' || value.phase === 'complete') &&
      (!amount(value.forwardOrderId) || !amount(value.forwardReceived) || !amount(value.returnAmount) || !record(value.returnBaseline))) return false;
  if (value.phase === 'complete' && (!amount(value.reverseOrderId) || !amount(value.reverseReceived))) return false;
  return Object.keys(value).every(key => [
    'version', 'network', 'account', 'sourceRunId', 'authorizationRunId', 'recoveredRunId', 'phase', 'createdAt', 'pricedAt', 'updatedAt', 'offer', 'request', 'native',
    'baseFee', 'principal', 'forwardMinimum', 'reverseMinimum', 'knownOrderIds', 'feeBudget', 'paidFees',
    'forwardOrderId', 'reverseOrderId', 'forwardReceived', 'forwardRefunded', 'reverseReceived', 'returnAmount', 'returnBaseline'
  ].includes(key));
}

export function loadMainnetSwapCheckpoint(path: string): MainnetSwapCheckpoint | undefined {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
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
export function mainnetSwapNextAction(state: MainnetSwapCheckpoint | undefined): 'prepare' | 'reconcile-forward' | 'return' | 'reconcile-reverse' | 'stop' {
  if (!state || state.phase === 'complete' || state.phase === 'cancelled' || state.phase === 'unspent') return 'prepare';
  if (state.phase === 'forward-authorized') return 'reconcile-forward';
  if (state.phase === 'forward-settled') return 'return';
  if (state.phase === 'reverse-authorized') return 'reconcile-reverse';
  return 'stop';
}
export function matchAuthorizedSwap(state: MainnetSwapCheckpoint, rows: SwapOrderEvidence[], leg: 'forward' | 'reverse'): SwapOrderEvidence | undefined {
  const offer = leg === 'forward' ? state.offer : state.request;
  const request = leg === 'forward' ? state.request : state.offer;
  const known = leg === 'forward' ? state.forwardOrderId : state.reverseOrderId;
  const matches = rows.filter(row => row.account === state.account && row.offeredFaucet === offer.faucetId &&
    row.requestedFaucet === request.faucetId && row.offer === (leg === 'forward' ? state.principal : state.returnAmount) &&
    amount(row.minimumReceive) && BigInt(row.minimumReceive) >= BigInt(leg === 'forward' ? state.forwardMinimum : state.reverseMinimum) &&
    row.initiatedAt >= Math.floor(Date.parse(state.createdAt) / 1000) - 30 &&
    (known ? row.orderId === known : !state.knownOrderIds.includes(row.orderId)));
  if (matches.length > 1) throw new Error('Prior swap submission is ambiguous; refusing another spend');
  return matches[0];
}
export function swapProceeds(before: bigint, after: bigint, claimed: bigint, fees: bigint): bigint {
  if ([before, after, claimed, fees].some(value => value < 0n) || after - before !== claimed - fees) {
    throw new Error('Swap balance contains unexplained credits or debits');
  }
  return after - before;
}

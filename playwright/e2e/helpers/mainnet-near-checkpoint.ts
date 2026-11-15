import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from '../../../src/lib/update/guards';
import { expectedOneClickFees, parseOneClickFeePolicy } from '../../../src/lib/one-click/fees';
import { holding } from './mainnet-swap-checkpoint';
import { MAINNET_LOOP_LOSS_CAP, realizedMainnetLoopLoss } from './mainnet-loop-budget';
import { tokenValueUsdMicro } from './mainnet-one-click-plan';
import type { OneClickAppFee, OneClickFeePolicy } from '../../../src/lib/one-click/types';
import type { SavedSwapHolding, SwapLoopPhase } from './mainnet-swap-checkpoint';
import type { MainnetSendAuthority } from './mainnet-send-authorization';
import type { MainnetConsumeAuthority } from './mainnet-consume-authorization';

export interface MainnetNearQuoteAuthority {
  quoteHash: string;
  correlationId: string;
  depositAddress: string;
  deadline: string;
  amountIn: string;
  minimumOutput: string;
  refundFee: string;
}
export interface MainnetNearCheckpoint {
  version: 2;
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
  evm: {
    chainId: 1 | 42161;
    account: string;
    token: string;
    tokenBalance: string;
    nativeBalance: string;
    tokenUsdMicros: string;
    nativeUsdMicros: string;
  };
  nativeAssetId: string;
  evmAssetId: string;
  serviceUrl: string;
  appFees: OneClickAppFee[];
  feePolicy?: OneClickFeePolicy;
  baseFee: string;
  principal: string;
  forwardMinimum: string;
  reverseMinimum: string;
  lossBudgetUsdMicros: string;
  feeBudget: string;
  evmFeeBudget: string;
  paidMidenFees: string;
  paidEvmFees: string;
  forwardQuote?: MainnetNearQuoteAuthority;
  sendAuthority?: MainnetSendAuthority;
  forwardMidenTxId?: string;
  forwardEvmTxHash?: string;
  forwardReceived?: string;
  reverseQuote?: MainnetNearQuoteAuthority;
  returnAmount?: string;
  evmNonceBefore?: number;
  returnValuation?: { pricedAt: string; nativeUsdMicros: string; tokenUsdMicros: string; gasUsdMicros: string };
  transactions?: { kind: 'transfer'; nonce: number; hash: string; feeWei?: string }[];
  returnProviderTxId?: string;
  returnNoteId?: string;
  consumeAuthority?: MainnetConsumeAuthority;
  returnMidenTxId?: string;
  reverseReceived?: string;
  refunded?: string;
  realizedCostUsdMicros?: string;
}
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const positive = (value: unknown): value is string => amount(value) && BigInt(value) > 0n;
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key));
function quote(value: unknown): value is MainnetNearQuoteAuthority {
  return (
    isRecord(value) &&
    keys(value, [
      'quoteHash',
      'correlationId',
      'depositAddress',
      'deadline',
      'amountIn',
      'minimumOutput',
      'refundFee'
    ]) &&
    typeof value.quoteHash === 'string' &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.quoteHash) &&
    typeof value.correlationId === 'string' &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(value.correlationId) &&
    typeof value.depositAddress === 'string' &&
    /^(?:mm1[a-z0-9_]{20,150}|0x[0-9a-fA-F]{40})$/.test(value.depositAddress) &&
    timestamp(value.deadline) &&
    positive(value.amountIn) &&
    positive(value.minimumOutput) &&
    amount(value.refundFee)
  );
}
function fingerprints(value: unknown, send: boolean): boolean {
  return (
    isRecord(value) &&
    keys(value, ['nonce', 'sha256', 'canonicalSha256', ...(send ? ['noteId'] : ['requestCanonicalSha256', 'expiresAt'])]) &&
    typeof value.nonce === 'string' &&
    /^[0-9a-f-]{36}$/.test(value.nonce) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.canonicalSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.canonicalSha256) &&
    (send ||
      (value.requestCanonicalSha256 === undefined && value.expiresAt === undefined) ||
      (typeof value.requestCanonicalSha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(value.requestCanonicalSha256) &&
        typeof value.expiresAt === 'number' &&
        Number.isSafeInteger(value.expiresAt) &&
        value.expiresAt > 0)) &&
    (!send || hash(value.noteId))
  );
}
const fields = [
  'version',
  'network',
  'account',
  'accountHex',
  'sourceRunId',
  'authorizationRunId',
  'phase',
  'createdAt',
  'pricedAt',
  'updatedAt',
  'native',
  'evm',
  'nativeAssetId',
  'evmAssetId',
  'serviceUrl',
  'appFees',
  'feePolicy',
  'baseFee',
  'principal',
  'forwardMinimum',
  'reverseMinimum',
  'lossBudgetUsdMicros',
  'feeBudget',
  'evmFeeBudget',
  'paidMidenFees',
  'paidEvmFees',
  'forwardQuote',
  'sendAuthority',
  'forwardMidenTxId',
  'forwardEvmTxHash',
  'forwardReceived',
  'reverseQuote',
  'returnAmount',
  'evmNonceBefore',
  'returnValuation',
  'transactions',
  'returnProviderTxId',
  'returnNoteId',
  'consumeAuthority',
  'returnMidenTxId',
  'reverseReceived',
  'refunded',
  'realizedCostUsdMicros'
];
function shape(value: unknown): value is MainnetNearCheckpoint {
  if (
    !isRecord(value) ||
    !keys(value, fields) ||
    value.version !== 2 ||
    value.network !== 'mainnet' ||
    typeof value.account !== 'string' ||
    !/^mm1[a-z0-9_]{20,150}$/.test(value.account) ||
    typeof value.accountHex !== 'string' ||
    !/^0x[0-9a-f]{30}$/.test(value.accountHex) ||
    typeof value.sourceRunId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value.sourceRunId) ||
    value.authorizationRunId !== value.sourceRunId ||
    typeof value.phase !== 'string' ||
    ![
      'forward-authorized',
      'forward-settled',
      'reverse-authorized',
      'complete',
      'cancelled',
      'unspent',
      'recovery-required'
    ].includes(value.phase) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.pricedAt) ||
    !timestamp(value.updatedAt) ||
    !holding(value.native) ||
    value.native.hex !== '0xe69e6ca6e39df1b10c1e5399399feb' ||
    value.native.symbol !== 'USDCX' ||
    value.native.decimals !== 6 ||
    value.nativeAssetId !== `nep141:miden-${value.native.hex}.omft.near` ||
    !isRecord(value.evm) ||
    !keys(value.evm, [
      'chainId',
      'account',
      'token',
      'tokenBalance',
      'nativeBalance',
      'tokenUsdMicros',
      'nativeUsdMicros'
    ]) ||
    (value.evm.chainId !== 1 && value.evm.chainId !== 42161) ||
    typeof value.evm.account !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.evm.account) ||
    typeof value.evm.token !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.evm.token) ||
    /^0x0{40}$/.test(value.evm.token) ||
    value.evmAssetId !==
      `nep141:${value.evm.chainId === 1 ? 'eth' : 'arb'}-${value.evm.token.toLowerCase()}.omft.near` ||
    !amount(value.evm.tokenBalance) ||
    !amount(value.evm.nativeBalance) ||
    !positive(value.evm.tokenUsdMicros) ||
    !positive(value.evm.nativeUsdMicros) ||
    typeof value.serviceUrl !== 'string' ||
    value.serviceUrl.length > 512 ||
    !Array.isArray(value.appFees) ||
    !value.appFees.every(
      fee =>
        isRecord(fee) &&
        keys(fee, ['recipient', 'fee']) &&
        typeof fee.recipient === 'string' &&
        typeof fee.fee === 'number'
    )
  )
    return false;
  try {
    const url = new URL(value.serviceUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.serviceUrl.trim() !== value.serviceUrl
    )
      return false;
    expectedOneClickFees(value.appFees, parseOneClickFeePolicy(value.feePolicy));
  } catch {
    return false;
  }
  for (const name of [
    'baseFee',
    'principal',
    'forwardMinimum',
    'reverseMinimum',
    'lossBudgetUsdMicros',
    'feeBudget',
    'evmFeeBudget'
  ])
    if (!positive(value[name])) return false;
  for (const name of ['paidMidenFees', 'paidEvmFees']) if (!amount(value[name])) return false;
  for (const name of ['forwardMidenTxId', 'forwardEvmTxHash', 'returnProviderTxId', 'returnNoteId', 'returnMidenTxId'])
    if (value[name] !== undefined && !hash(value[name])) return false;
  for (const name of ['forwardReceived', 'returnAmount', 'reverseReceived', 'refunded'])
    if (value[name] !== undefined && !positive(value[name])) return false;
  if (value.realizedCostUsdMicros !== undefined && !amount(value.realizedCostUsdMicros)) return false;
  if (value.forwardQuote !== undefined && !quote(value.forwardQuote)) return false;
  if (value.reverseQuote !== undefined && !quote(value.reverseQuote)) return false;
  if (value.sendAuthority !== undefined && !fingerprints(value.sendAuthority, true)) return false;
  if (value.consumeAuthority !== undefined && !fingerprints(value.consumeAuthority, false)) return false;
  if (
    value.evmNonceBefore !== undefined &&
    (typeof value.evmNonceBefore !== 'number' ||
      !Number.isSafeInteger(value.evmNonceBefore) ||
      value.evmNonceBefore < 0)
  )
    return false;
  if (
    value.returnValuation !== undefined &&
    (!isRecord(value.returnValuation) ||
      !keys(value.returnValuation, ['pricedAt', 'nativeUsdMicros', 'tokenUsdMicros', 'gasUsdMicros']) ||
      !timestamp(value.returnValuation.pricedAt) ||
      !positive(value.returnValuation.nativeUsdMicros) ||
      !positive(value.returnValuation.tokenUsdMicros) ||
      !positive(value.returnValuation.gasUsdMicros))
  )
    return false;
  if (
    value.transactions !== undefined &&
    (!Array.isArray(value.transactions) ||
      value.transactions.length > 1 ||
      value.transactions.some(
        tx =>
          !isRecord(tx) ||
          !keys(tx, ['kind', 'nonce', 'hash', 'feeWei']) ||
          tx.kind !== 'transfer' ||
          typeof tx.nonce !== 'number' ||
          !Number.isSafeInteger(tx.nonce) ||
          tx.nonce < 0 ||
          !hash(tx.hash) ||
          (tx.feeWei !== undefined && !positive(tx.feeWei))
      ))
  )
    return false;
  return true;
}
export function parseMainnetNearCheckpoint(value: unknown): MainnetNearCheckpoint {
  if (!shape(value)) throw new Error('Invalid or private native NEAR checkpoint');
  const state = value;
  const reject = () => {
    throw new Error('Native NEAR authority, receipt or shared budget is inconsistent');
  };
  if (
    BigInt(state.lossBudgetUsdMicros) > MAINNET_LOOP_LOSS_CAP ||
    BigInt(state.paidMidenFees) > BigInt(state.feeBudget) ||
    BigInt(state.paidEvmFees) > BigInt(state.evmFeeBudget) ||
    BigInt(state.native.balance) < BigInt(state.principal) + BigInt(state.feeBudget) ||
    BigInt(state.evm.nativeBalance) < BigInt(state.evmFeeBudget) ||
    BigInt(state.feeBudget) < 2n * BigInt(state.baseFee)
  )
    reject();
  const quotedLoss =
    BigInt(state.principal) > BigInt(state.reverseMinimum)
      ? BigInt(state.principal) - BigInt(state.reverseMinimum)
      : 0n;
  if (
    tokenValueUsdMicro(quotedLoss + BigInt(state.feeBudget), 6, BigInt(state.native.usdMicros), true) +
      tokenValueUsdMicro(BigInt(state.evmFeeBudget), 18, BigInt(state.evm.nativeUsdMicros), true) >
    BigInt(state.lossBudgetUsdMicros)
  )
    reject();
  if (
    state.forwardQuote &&
    (state.forwardQuote.amountIn !== state.principal ||
      !state.forwardQuote.depositAddress.startsWith('mm1') ||
      BigInt(state.forwardQuote.minimumOutput) < BigInt(state.forwardMinimum) ||
      BigInt(state.forwardQuote.refundFee) >= BigInt(state.principal))
  )
    reject();
  if (
    state.forwardQuote &&
    tokenValueUsdMicro(
      BigInt(state.forwardQuote.refundFee) + BigInt(state.feeBudget),
      6,
      BigInt(state.native.usdMicros),
      true
    ) > BigInt(state.lossBudgetUsdMicros)
  )
    reject();
  if (state.sendAuthority && !state.forwardQuote) reject();
  if (state.forwardMidenTxId && (!state.sendAuthority || BigInt(state.paidMidenFees) === 0n)) reject();
  const forwardSettled =
    !!state.forwardQuote &&
    !!state.sendAuthority &&
    !!state.forwardMidenTxId &&
    !!state.forwardEvmTxHash &&
    !!state.forwardReceived &&
    BigInt(state.forwardReceived) >= BigInt(state.forwardQuote.minimumOutput);
  if (['forward-settled', 'reverse-authorized', 'complete'].includes(state.phase) && !forwardSettled) reject();
  if (
    state.returnValuation &&
    (Date.parse(state.returnValuation.pricedAt) < Date.parse(state.pricedAt) ||
      BigInt(state.returnValuation.nativeUsdMicros) < BigInt(state.native.usdMicros) ||
      BigInt(state.returnValuation.tokenUsdMicros) < BigInt(state.evm.tokenUsdMicros) ||
      BigInt(state.returnValuation.gasUsdMicros) < BigInt(state.evm.nativeUsdMicros))
  )
    reject();
  const reverseAuthorized =
    forwardSettled &&
    !!state.reverseQuote &&
    !!state.returnValuation &&
    state.evmNonceBefore !== undefined &&
    !!state.returnAmount &&
    BigInt(state.returnAmount) <= BigInt(state.forwardReceived ?? '0') &&
    state.reverseQuote.amountIn === state.returnAmount &&
    /^0x[0-9a-fA-F]{40}$/.test(state.reverseQuote.depositAddress) &&
    state.reverseQuote.depositAddress.toLowerCase() !== state.evm.account.toLowerCase() &&
    BigInt(state.reverseQuote.minimumOutput) >= BigInt(state.reverseMinimum);
  if (
    (state.reverseQuote ||
      state.transactions?.length ||
      state.phase === 'reverse-authorized' ||
      state.phase === 'complete') &&
    !reverseAuthorized
  )
    reject();
  const knownFees = (state.transactions ?? []).reduce((sum, tx) => sum + BigInt(tx.feeWei ?? '0'), 0n);
  if (knownFees !== BigInt(state.paidEvmFees) || state.transactions?.some(tx => tx.nonce !== state.evmNonceBefore))
    reject();
  if (
    state.phase === 'unspent' &&
    (state.forwardMidenTxId ||
      state.forwardReceived ||
      state.transactions?.length ||
      state.consumeAuthority ||
      BigInt(state.paidMidenFees) !== 0n ||
      BigInt(state.paidEvmFees) !== 0n)
  )
    reject();
  if (state.phase === 'complete' || state.phase === 'cancelled') {
    const returned = state.phase === 'complete' ? state.reverseReceived : state.refunded;
    if (
      !state.forwardQuote ||
      !state.sendAuthority ||
      !state.forwardMidenTxId ||
      !state.returnProviderTxId ||
      !state.returnNoteId ||
      state.returnNoteId === state.sendAuthority.noteId ||
      !state.consumeAuthority ||
      !state.returnMidenTxId ||
      !returned ||
      state.realizedCostUsdMicros === undefined
    )
      reject();
    const floor =
      state.phase === 'complete'
        ? state.reverseQuote?.minimumOutput
        : (BigInt(state.principal) - BigInt(state.forwardQuote?.refundFee ?? '0')).toString();
    if (
      !floor ||
      BigInt(returned ?? '0') < BigInt(floor) ||
      (state.phase === 'complete' && (state.transactions?.length !== 1 || !state.transactions?.[0]?.feeWei)) ||
      (state.phase === 'cancelled' && (state.forwardReceived || state.transactions?.length || state.reverseQuote))
    )
      reject();
    const prices = state.returnValuation;
    const cost = realizedMainnetLoopLoss([
      {
        identity: `miden:${state.native.hex}`,
        before: BigInt(state.native.balance),
        after:
          BigInt(state.native.balance) -
          BigInt(state.principal) +
          BigInt(returned ?? '0') -
          BigInt(state.paidMidenFees),
        decimals: 6,
        usdMicros: BigInt(prices?.nativeUsdMicros ?? state.native.usdMicros)
      },
      {
        identity: `evm:${state.evm.chainId}:token:${state.evm.token.toLowerCase()}`,
        before: BigInt(state.evm.tokenBalance),
        after:
          BigInt(state.evm.tokenBalance) + BigInt(state.forwardReceived ?? '0') - BigInt(state.returnAmount ?? '0'),
        decimals: 6,
        usdMicros: BigInt(prices?.tokenUsdMicros ?? state.evm.tokenUsdMicros)
      },
      {
        identity: `evm:${state.evm.chainId}:native`,
        before: BigInt(state.evm.nativeBalance),
        after: BigInt(state.evm.nativeBalance) - BigInt(state.paidEvmFees),
        decimals: 18,
        usdMicros: BigInt(prices?.gasUsdMicros ?? state.evm.nativeUsdMicros)
      }
    ]);
    if (cost.toString() !== state.realizedCostUsdMicros || cost > BigInt(state.lossBudgetUsdMicros)) reject();
  }
  return state;
}
export function loadMainnetNearCheckpoint(path: string): MainnetNearCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 65_536)
    throw new Error('Invalid native NEAR checkpoint file');
  return parseMainnetNearCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
}
export function saveMainnetNearCheckpoint(path: string, state: MainnetNearCheckpoint): void {
  const validated = parseMainnetNearCheckpoint(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

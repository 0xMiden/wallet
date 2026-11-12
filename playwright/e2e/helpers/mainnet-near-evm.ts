import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isHash,
  isHex,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type TransactionSerializedEIP1559
} from 'viem';
import { parseMainnetNearCheckpoint, type MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import { tokenValueUsdMicro } from './mainnet-one-click-plan';
import type { EpochEvmRecoveryEvidence } from './mainnet-epoch-evm';
import type { MainnetOneClickEvmSenderInput } from './mainnet-one-click-evm';

export function inspectMainnetNearForwardReceipt(
  state: MainnetNearCheckpoint,
  expectedHash: Hash,
  receipt: Pick<TransactionReceipt, 'transactionHash' | 'status' | 'from' | 'logs'>
): bigint {
  parseMainnetNearCheckpoint(state);
  if (
    !state.forwardQuote ||
    !isHash(expectedHash) ||
    receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase() ||
    receipt.status !== 'success' ||
    receipt.from.toLowerCase() === state.evm.account.toLowerCase()
  )
    throw new Error('Native NEAR forward receipt is uncorrelated, reverted or self-submitted');
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true }).filter(
    log =>
      log.address.toLowerCase() === state.evm.token.toLowerCase() &&
      log.args.to.toLowerCase() === state.evm.account.toLowerCase()
  );
  if (transfers.some(log => log.args.from.toLowerCase() === state.evm.account.toLowerCase()))
    throw new Error('Native NEAR cannot self-fill its payout');
  const received = transfers.reduce((sum, log) => sum + log.args.value, 0n);
  if (received < BigInt(state.forwardQuote.minimumOutput))
    throw new Error('Native NEAR payout is below the reviewed output');
  return received;
}

export function reconcileMainnetNearEvmReceipt(
  state: MainnetNearCheckpoint,
  evidence: EpochEvmRecoveryEvidence
): boolean {
  parseMainnetNearCheckpoint(state);
  const entry = state.transactions?.[0];
  const quote = state.reverseQuote;
  if (state.transactions?.length !== 1 || !entry || !quote || !state.returnAmount || state.evmNonceBefore === undefined)
    throw new Error('Missing original native NEAR signed recovery journal');
  const { transaction: tx, receipt } = evidence;
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(quote.depositAddress), BigInt(state.returnAmount)]
  });
  if (
    !tx.to ||
    tx.hash.toLowerCase() !== entry.hash ||
    receipt.transactionHash.toLowerCase() !== entry.hash ||
    getAddress(tx.from) !== getAddress(state.evm.account) ||
    getAddress(tx.to) !== getAddress(state.evm.token) ||
    tx.input.toLowerCase() !== data.toLowerCase() ||
    tx.value !== 0n ||
    tx.chainId !== state.evm.chainId ||
    tx.type !== 'eip1559' ||
    tx.nonce !== state.evmNonceBefore ||
    tx.nonce !== entry.nonce ||
    tx.gas <= 0n ||
    tx.maxFeePerGas === undefined ||
    tx.maxFeePerGas <= 0n ||
    tx.gas * tx.maxFeePerGas > BigInt(state.evmFeeBudget) ||
    receipt.gasUsed <= 0n ||
    receipt.gasUsed > tx.gas ||
    receipt.effectiveGasPrice <= 0n ||
    receipt.effectiveGasPrice > tx.maxFeePerGas
  )
    throw new Error('Native NEAR recovery receipt differs from its original signed transfer or fee envelope');
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  if ((entry.feeWei !== undefined && BigInt(entry.feeWei) !== fee) || BigInt(state.paidEvmFees) > fee)
    throw new Error('Saved native NEAR fees contradict the original actual receipt');
  // Historical reconciliation only: never refresh the original quote, nonce, price, run or signing authority.
  entry.feeWei = fee.toString();
  state.paidEvmFees = fee.toString();
  return receipt.status === 'success';
}

export interface MainnetNearEvmEnvelope {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export interface MainnetNearBroadcastInput {
  signal: AbortSignal;
  client: {
    getChainId(): Promise<number>;
    getTransactionCount(input: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
    getBalance(input: { address: Address }): Promise<bigint>;
    readTokenBalance(): Promise<bigint>;
    sendRawTransaction(input: { serializedTransaction: Hex }): Promise<Hash>;
    waitForTransactionReceipt(input: { hash: Hash; timeout: number }): Promise<{
      transactionHash: Hash;
      status: 'success' | 'reverted';
      gasUsed: bigint;
      effectiveGasPrice: bigint;
    }>;
  };
  sign(transaction: MainnetNearEvmEnvelope): Promise<Hex>;
  persist(state: MainnetNearCheckpoint): Promise<void>;
}
export function createMainnetNearEvmBroadcast(
  state: MainnetNearCheckpoint,
  input: MainnetNearBroadcastInput
): MainnetOneClickEvmSenderInput['broadcast'] {
  parseMainnetNearCheckpoint(state);
  if (
    state.phase !== 'reverse-authorized' ||
    state.transactions?.length ||
    state.paidEvmFees !== '0' ||
    state.evmNonceBefore === undefined ||
    !state.forwardReceived ||
    !state.reverseQuote ||
    !state.returnValuation ||
    state.consumeAuthority
  )
    throw new Error('Native NEAR broadcast requires unused original return authority');
  const scope = () =>
    JSON.stringify({ ...state, transactions: undefined, paidEvmFees: undefined, updatedAt: undefined });
  const original = scope();
  const account = getAddress(state.evm.account);
  const nonce = state.evmNonceBefore;
  const received = BigInt(state.forwardReceived);
  const deadline = Date.parse(state.reverseQuote.deadline);
  const pricedAt = Date.parse(state.returnValuation.pricedAt);
  const active = () => {
    const age = Date.now() - pricedAt;
    if (input.signal.aborted || scope() !== original || age < 0 || age > 600_000 || Date.now() >= deadline)
      throw new Error('Original native NEAR signing authority changed, expired or was aborted');
  };
  const live = async () => {
    active();
    const [chain, latest, pending, native, token] = await Promise.all([
      input.client.getChainId(),
      input.client.getTransactionCount({ address: account, blockTag: 'latest' }),
      input.client.getTransactionCount({ address: account, blockTag: 'pending' }),
      input.client.getBalance({ address: account }),
      input.client.readTokenBalance()
    ]);
    active();
    if (
      chain !== state.evm.chainId ||
      latest !== nonce ||
      pending !== nonce ||
      native !== BigInt(state.evm.nativeBalance) ||
      token !== BigInt(state.evm.tokenBalance) + received
    )
      throw new Error('Native NEAR live chain, nonce or attributed portfolio changed');
  };
  let attempted = false;
  return async transaction => {
    if (attempted) throw new Error('Native NEAR broadcast is one-shot; recovery is required');
    attempted = true;
    await live();
    const envelope: MainnetNearEvmEnvelope = {
      ...transaction,
      chainId: state.evm.chainId,
      nonce,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? 0n
    };
    const raw = await input.sign({ ...envelope });
    active();
    const hash = await inspectMainnetNearSignedTransfer(state, envelope, raw);
    active();
    const entry: NonNullable<MainnetNearCheckpoint['transactions']>[number] = { kind: 'transfer', nonce, hash };
    state.transactions = [entry];
    await input.persist(state);
    active();
    if (state.transactions?.length !== 1 || state.transactions[0] !== entry)
      throw new Error('Native NEAR signed journal was replaced during upload');
    await live();
    await inspectMainnetNearSignedTransfer(state, envelope, raw);
    active();
    // The caller's public RPC transport must use retryCount: 0; persistence resolves only after exact upload acknowledgement.
    const returned = await input.client.sendRawTransaction({ serializedTransaction: raw });
    if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('Native NEAR broadcast returned another hash');
    const receipt = await input.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (
      receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      receipt.gasUsed <= 0n ||
      receipt.gasUsed > envelope.gas ||
      receipt.effectiveGasPrice <= 0n ||
      receipt.effectiveGasPrice > envelope.maxFeePerGas
    )
      throw new Error('Native NEAR receipt differs from the actual signed fee envelope');
    entry.feeWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    state.paidEvmFees = entry.feeWei;
    await input.persist(state);
    if (receipt.status !== 'success') throw new Error('Native NEAR transfer reverted; actual fees retained, no retry');
    return hash;
  };
}

const signed1559 = (raw: Hex): raw is TransactionSerializedEIP1559 =>
  raw.startsWith('0x02') && isHex(raw, { strict: true });
export async function inspectMainnetNearSignedTransfer(
  state: MainnetNearCheckpoint,
  envelope: MainnetNearEvmEnvelope,
  raw: Hex
): Promise<Hash> {
  parseMainnetNearCheckpoint(state);
  if (
    state.phase !== 'reverse-authorized' ||
    !state.reverseQuote ||
    !state.returnAmount ||
    !state.returnValuation ||
    state.evmNonceBefore === undefined ||
    state.paidEvmFees !== '0'
  )
    throw new Error('Native NEAR transfer requires original unused return authority');
  const snapshot = JSON.stringify(state);
  const approved = { ...envelope };
  const quote = state.reverseQuote;
  const active = () => {
    const age = Date.now() - Date.parse(state.returnValuation?.pricedAt ?? '');
    if (
      JSON.stringify(state) !== snapshot ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 600_000 ||
      Date.now() >= Date.parse(quote.deadline)
    )
      throw new Error('Original native NEAR transfer authority changed or expired');
  };
  active();
  const loss =
    BigInt(state.principal) > BigInt(quote.minimumOutput) ? BigInt(state.principal) - BigInt(quote.minimumOutput) : 0n;
  if (
    tokenValueUsdMicro(loss + BigInt(state.feeBudget), 6, BigInt(state.returnValuation.nativeUsdMicros), true) +
      tokenValueUsdMicro(BigInt(state.evmFeeBudget), 18, BigInt(state.returnValuation.gasUsdMicros), true) >
    BigInt(state.lossBudgetUsdMicros)
  )
    throw new Error('Fresh native NEAR valuation exceeds the original shared allowance');
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(quote.depositAddress), BigInt(state.returnAmount)]
  });
  if (
    approved.chainId !== state.evm.chainId ||
    approved.nonce !== state.evmNonceBefore ||
    getAddress(approved.to) !== getAddress(state.evm.token) ||
    approved.data.toLowerCase() !== data.toLowerCase() ||
    approved.value !== 0n ||
    approved.gas <= 0n ||
    approved.maxFeePerGas <= 0n ||
    approved.maxPriorityFeePerGas < 0n ||
    approved.maxPriorityFeePerGas > approved.maxFeePerGas ||
    approved.gas * approved.maxFeePerGas > BigInt(state.evmFeeBudget) ||
    !signed1559(raw)
  )
    throw new Error('Native NEAR transfer is outside its exact ERC20 or fee authority');
  let decoded: ReturnType<typeof parseTransaction>;
  let payer: Address;
  try {
    decoded = parseTransaction(raw);
    payer = await recoverTransactionAddress({ serializedTransaction: raw });
  } catch {
    throw new Error('Invalid actual signed native NEAR envelope');
  }
  active();
  if (
    decoded.type !== 'eip1559' ||
    decoded.chainId !== approved.chainId ||
    decoded.nonce !== approved.nonce ||
    !decoded.to ||
    getAddress(decoded.to) !== getAddress(approved.to) ||
    (decoded.data ?? '0x').toLowerCase() !== approved.data.toLowerCase() ||
    (decoded.value ?? 0n) !== approved.value ||
    decoded.gas !== approved.gas ||
    decoded.maxFeePerGas !== approved.maxFeePerGas ||
    (decoded.maxPriorityFeePerGas ?? 0n) !== approved.maxPriorityFeePerGas ||
    (decoded.accessList?.length ?? 0) !== 0 ||
    getAddress(payer) !== getAddress(state.evm.account)
  )
    throw new Error('Actual native NEAR signed bytes or recovered payer differ from their original authority');
  const hash = keccak256(raw);
  const journal = state.transactions?.[0];
  if (
    state.transactions?.length &&
    (!journal || journal.hash !== hash || journal.nonce !== approved.nonce || journal.feeWei !== undefined)
  )
    throw new Error('Another signed or receipted native NEAR transfer already occupies this authority');
  return hash;
}

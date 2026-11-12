import { encodeFunctionData, erc20Abi, getAddress, isHex, keccak256, parseTransaction, recoverTransactionAddress,
  type Address, type Hash, type Hex, type TransactionSerializedEIP1559 } from 'viem';
import { parseMainnetNearCheckpoint, type MainnetNearCheckpoint } from './mainnet-near-checkpoint';
import { tokenValueUsdMicro } from './mainnet-one-click-plan';

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
const signed1559 = (raw: Hex): raw is TransactionSerializedEIP1559 => raw.startsWith('0x02') && isHex(raw, { strict: true });
export async function inspectMainnetNearSignedTransfer(
  state: MainnetNearCheckpoint, envelope: MainnetNearEvmEnvelope, raw: Hex
): Promise<Hash> {
  parseMainnetNearCheckpoint(state);
  if (state.phase !== 'reverse-authorized' || !state.reverseQuote || !state.returnAmount ||
      !state.returnValuation || state.evmNonceBefore === undefined || state.paidEvmFees !== '0')
    throw new Error('Native NEAR transfer requires original unused return authority');
  const snapshot = JSON.stringify(state); const approved = { ...envelope }; const quote = state.reverseQuote;
  const active = () => {
    const age = Date.now() - Date.parse(state.returnValuation?.pricedAt ?? '');
    if (JSON.stringify(state) !== snapshot || !Number.isFinite(age) || age < 0 || age > 600_000 || Date.now() >= Date.parse(quote.deadline))
      throw new Error('Original native NEAR transfer authority changed or expired');
  };
  active();
  const loss = BigInt(state.principal) > BigInt(quote.minimumOutput) ? BigInt(state.principal) - BigInt(quote.minimumOutput) : 0n;
  if (tokenValueUsdMicro(loss + BigInt(state.feeBudget), 6, BigInt(state.returnValuation.nativeUsdMicros), true) +
      tokenValueUsdMicro(BigInt(state.evmFeeBudget), 18, BigInt(state.returnValuation.gasUsdMicros), true) > BigInt(state.lossBudgetUsdMicros))
    throw new Error('Fresh native NEAR valuation exceeds the original shared allowance');
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(quote.depositAddress), BigInt(state.returnAmount)] });
  if (approved.chainId !== state.evm.chainId || approved.nonce !== state.evmNonceBefore || getAddress(approved.to) !== getAddress(state.evm.token) ||
      approved.data.toLowerCase() !== data.toLowerCase() || approved.value !== 0n || approved.gas <= 0n || approved.maxFeePerGas <= 0n ||
      approved.maxPriorityFeePerGas < 0n || approved.maxPriorityFeePerGas > approved.maxFeePerGas ||
      approved.gas * approved.maxFeePerGas > BigInt(state.evmFeeBudget) || !signed1559(raw))
    throw new Error('Native NEAR transfer is outside its exact ERC20 or fee authority');
  let decoded: ReturnType<typeof parseTransaction>; let payer: Address;
  try { decoded = parseTransaction(raw); payer = await recoverTransactionAddress({ serializedTransaction: raw }); }
  catch { throw new Error('Invalid actual signed native NEAR envelope'); }
  active();
  if (decoded.type !== 'eip1559' || decoded.chainId !== approved.chainId || decoded.nonce !== approved.nonce || !decoded.to ||
      getAddress(decoded.to) !== getAddress(approved.to) || (decoded.data ?? '0x').toLowerCase() !== approved.data.toLowerCase() ||
      (decoded.value ?? 0n) !== approved.value || decoded.gas !== approved.gas || decoded.maxFeePerGas !== approved.maxFeePerGas ||
      decoded.maxPriorityFeePerGas !== approved.maxPriorityFeePerGas || (decoded.accessList?.length ?? 0) !== 0 || getAddress(payer) !== getAddress(state.evm.account))
    throw new Error('Actual native NEAR signed bytes or recovered payer differ from their original authority');
  const hash = keccak256(raw); const journal = state.transactions?.[0];
  if (state.transactions?.length && (!journal || journal.hash !== hash || journal.nonce !== approved.nonce || journal.feeWei !== undefined))
    throw new Error('Another signed or receipted native NEAR transfer already occupies this authority');
  return hash;
}

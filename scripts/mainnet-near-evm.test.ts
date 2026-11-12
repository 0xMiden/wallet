/** @jest-environment node */
import { encodeFunctionData, erc20Abi, getAddress, isHex, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { inspectMainnetNearSignedTransfer, type MainnetNearEvmEnvelope } from '../playwright/e2e/helpers/mainnet-near-evm';
import type { MainnetNearCheckpoint } from '../playwright/e2e/helpers/mainnet-near-checkpoint';
import { nativeNearFixture, nativeNearQuote } from './helpers/mainnet-near-fixture';
const key = `0x${'0'.repeat(63)}1`;
if (!isHex(key, { strict: true })) throw new Error('Invalid deterministic unit signer');
const signer = privateKeyToAccount(key);
const deposit = getAddress(`0x${'2'.repeat(40)}`);
function authority(): MainnetNearCheckpoint {
  const state = nativeNearFixture(); const id = `0x${'a'.repeat(64)}`;
  state.evm.account = signer.address;
  return { ...state, phase: 'reverse-authorized', forwardQuote: nativeNearQuote('mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav', state.principal),
    sendAuthority: { nonce: '11111111-1111-4111-8111-111111111111', noteId: id, sha256: '1'.repeat(64), canonicalSha256: '2'.repeat(64) },
    forwardMidenTxId: id, forwardEvmTxHash: id, forwardReceived: '1001000', paidMidenFees: '7',
    reverseQuote: nativeNearQuote(`0x${'2'.repeat(40)}`, '1001000'), returnAmount: '1001000', evmNonceBefore: 0,
    returnValuation: { pricedAt: '2026-11-12T12:00:01.000Z', nativeUsdMicros: '1000000', tokenUsdMicros: '1000000', gasUsdMicros: '2000000000' } };
}
function envelope(): MainnetNearEvmEnvelope {
  const state = authority();
  return { chainId: 42161, to: getAddress(state.evm.token),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 1001000n] }),
    value: 0n, nonce: 0, gas: 50000n, maxFeePerGas: 1000000n, maxPriorityFeePerGas: 0n };
}
beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-11-12T12:00:01.000Z')); });
afterEach(() => { jest.useRealTimers(); });
it('inspects actual signed bytes and returns only their real hash for the original one-time ERC20 deposit', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).resolves.toBe(keccak256(raw));
});
const changes: Array<[string, Partial<MainnetNearEvmEnvelope>]> = [
  ['chain', { chainId: 1 }], ['nonce', { nonce: 1 }], ['value', { value: 1n }], ['gas', { gas: 50001n }],
  ['fee', { maxFeePerGas: 1000001n }], ['priority fee', { maxPriorityFeePerGas: 1n }],
  ['calldata', { data: '0x' }], ['target', { to: getAddress(`0x${'3'.repeat(40)}`) }]
];
it.each(changes)('rejects a signer changing the actual %s despite the approved labels', async (_name, changed) => {
  const approved = envelope();
  const actual = { ...approved, ...changed };
  if (!isHex(actual.data, { strict: true })) throw new Error('Invalid unit transaction bytes');
  const raw = await signer.signTransaction({ ...actual, data: actual.data, type: 'eip1559' });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});
it('rejects a fully signed approval rather than treating a provider deposit label as authority', async () => {
  const approved = envelope(); const state = authority();
  approved.data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deposit, 1001000n] });
  const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  await expect(inspectMainnetNearSignedTransfer(state, approved, raw)).rejects.toThrow();
});
it('rejects a different actual recovered payer', async () => {
  const other = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000002');
  const approved = envelope(); const raw = await other.signTransaction({ ...approved, type: 'eip1559' });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});
it('rejects undeclared access-list authority', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ ...approved, type: 'eip1559', accessList: [{ address: deposit, storageKeys: [] }] });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});
it('rejects matching signed labels when the actual amount differs from the original received proceeds', async () => {
  const approved = envelope(); approved.data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [deposit, 1000999n] });
  const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});
it('rejects legacy signed transaction types instead of assuming EIP1559 bounds', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ chainId: approved.chainId, nonce: approved.nonce, to: approved.to,
    data: approved.data, value: 0n, gas: approved.gas, gasPrice: approved.maxFeePerGas, type: 'legacy' });
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});
it('rejects a fresh gas/native valuation that exhausts the original remaining loss cap', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  const state = authority();
  if (!state.returnValuation) throw new Error('Missing unit return valuation');
  state.returnValuation.nativeUsdMicros = '200000000';
  await expect(inspectMainnetNearSignedTransfer(state, approved, raw)).rejects.toThrow();
});
it('rejects signing after the original provider deposit deadline', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  jest.setSystemTime(new Date('2026-11-12T12:06:00.000Z'));
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});

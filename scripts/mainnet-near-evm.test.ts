/** @jest-environment node */
import { encodeFunctionData, erc20Abi, getAddress, isHex, keccak256, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createMainnetNearEvmBroadcast, inspectMainnetNearSignedTransfer, type MainnetNearBroadcastInput, type MainnetNearEvmEnvelope } from '../playwright/e2e/helpers/mainnet-near-evm';
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
function receipt(transactionHash: Hash, status: 'success' | 'reverted' = 'success') {
  return { transactionHash, status, gasUsed: 45000n, effectiveGasPrice: 1000000n };
}
function broadcastFixture() {
  const state = authority(); const abort = new AbortController(); const events: string[] = [];
  const client = {
    getChainId: jest.fn(async () => 42161), getTransactionCount: jest.fn(async (_input: { address: Address; blockTag: 'latest' | 'pending' }) => 0),
    getBalance: jest.fn(async () => BigInt(state.evm.nativeBalance)),
    readTokenBalance: jest.fn(async () => BigInt(state.evm.tokenBalance) + 1001000n),
    sendRawTransaction: jest.fn(async ({ serializedTransaction }: { serializedTransaction: `0x${string}` }) => {
      events.push('broadcast'); return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: jest.fn(async ({ hash }: { hash: `0x${string}` }) => receipt(hash))
  };
  const sign = jest.fn(async (transaction: MainnetNearEvmEnvelope) => signer.signTransaction({ ...transaction, type: 'eip1559' }));
  const persist = jest.fn(async (_state: MainnetNearCheckpoint) => { events.push('persist'); });
  const input: MainnetNearBroadcastInput = { client, sign, persist, signal: abort.signal };
  return { state, abort, events, client, sign, persist, input };
}
it('journals the actual signed hash before one broadcast and records only the actual bounded receipt fee', async () => {
  const f = broadcastFixture(); const send = createMainnetNearEvmBroadcast(f.state, f.input);
  const hash = await send(envelope());
  expect(f.state.transactions).toEqual([{ kind: 'transfer', nonce: 0, hash, feeWei: '45000000000' }]);
  expect(f.state.paidEvmFees).toBe('45000000000'); expect(f.events).toEqual(['persist', 'broadcast', 'persist']);
});
it('holds the exact signed journal until upload acknowledgement and preserves it if cancelled while waiting', async () => {
  const f = broadcastFixture(); let entered: () => void = () => {}; let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  f.persist.mockImplementation(async () => { entered(); await acknowledgement; });
  const outcome = createMainnetNearEvmBroadcast(f.state, f.input)(envelope());
  const checked = outcome.then(value => ({ value }), error => ({ error }));
  await Promise.race([waiting, checked.then(() => { throw new Error('Broadcast settled before its signed journal was uploaded'); })]);
  expect(f.state.transactions).toHaveLength(1); expect(f.client.sendRawTransaction.mock.calls.length).toBe(0);
  f.abort.abort(); release(); await expect(outcome).rejects.toThrow(); expect(f.client.sendRawTransaction.mock.calls.length).toBe(0);
});
it('keeps the real signed journal but never broadcasts when durable persistence fails', async () => {
  const f = broadcastFixture(); f.persist.mockRejectedValue(new Error('Artifact unavailable'));
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow();
  expect(f.state.transactions).toHaveLength(1); expect(f.client.sendRawTransaction.mock.calls.length).toBe(0);
});
it('refuses actual signer byte substitution before persisting or broadcasting', async () => {
  const f = broadcastFixture(); f.sign.mockImplementation(async transaction => signer.signTransaction({ ...transaction, value: 1n, type: 'eip1559' }));
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow();
  expect(f.persist.mock.calls.length).toBe(0); expect(f.client.sendRawTransaction.mock.calls.length).toBe(0);
});
it('refuses authority mutation during upload rather than signing or sending a revised deposit', async () => {
  const f = broadcastFixture(); f.persist.mockImplementation(async () => { f.state.lossBudgetUsdMicros = '2000000'; });
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow();
  expect(f.state.transactions).toHaveLength(1); expect(f.client.sendRawTransaction.mock.calls.length).toBe(0);
});
it('retains actual revert fees and never retries the transfer', async () => {
  const f = broadcastFixture(); f.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => receipt(hash, 'reverted'));
  const send = createMainnetNearEvmBroadcast(f.state, f.input);
  await expect(send(envelope())).rejects.toThrow(); expect(f.state.paidEvmFees).toBe('45000000000');
  await expect(send(envelope())).rejects.toThrow(); expect(f.client.sendRawTransaction.mock.calls.length).toBe(1);
});
it('refuses an existing pending nonce before any signing', async () => {
  const f = broadcastFixture(); f.client.getTransactionCount.mockImplementation(async ({ blockTag }) => blockTag === 'pending' ? 1 : 0);
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow(); expect(f.sign.mock.calls.length).toBe(0);
});
it('refuses another live chain before any signing', async () => {
  const f = broadcastFixture(); f.client.getChainId.mockResolvedValue(1);
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow(); expect(f.sign.mock.calls.length).toBe(0);
});
it('does not spend an unrelated token credit as if it were the attributed forward receipt', async () => {
  const f = broadcastFixture(); f.client.readTokenBalance.mockResolvedValue(4001001n);
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow(); expect(f.sign.mock.calls.length).toBe(0);
});
it('keeps an unknown receipt unresolved instead of recording invented fees', async () => {
  const f = broadcastFixture(); f.client.waitForTransactionReceipt.mockImplementation(async () => receipt(`0x${'b'.repeat(64)}`));
  await expect(createMainnetNearEvmBroadcast(f.state, f.input)(envelope())).rejects.toThrow();
  expect(f.state.transactions).toHaveLength(1); expect(f.state.paidEvmFees).toBe('0');
});
it('refuses a second broadcast after successful settlement', async () => {
  const f = broadcastFixture(); const send = createMainnetNearEvmBroadcast(f.state, f.input); await send(envelope());
  await expect(send(envelope())).rejects.toThrow(); expect(f.client.sendRawTransaction.mock.calls.length).toBe(1);
});
it('rejects signing after the original provider deposit deadline', async () => {
  const approved = envelope(); const raw = await signer.signTransaction({ ...approved, type: 'eip1559' });
  jest.setSystemTime(new Date('2026-11-12T12:06:00.000Z'));
  await expect(inspectMainnetNearSignedTransfer(authority(), approved, raw)).rejects.toThrow();
});

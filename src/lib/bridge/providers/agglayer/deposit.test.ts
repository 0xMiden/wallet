// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/deposit.test.ts (MIT).
import { waitFor } from '@testing-library/react';
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseUnits, type EIP1193Provider, type Hash, type Hex } from 'viem';

import { AGGLAYER_BRIDGE_ABI } from 'lib/agglayer/constant';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import { bridgeOperationOf, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { accounts, now, referenceSnapshot, testRoute } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { applyBridgeInToConsumeRow, takeAgglayerBridgeInInfo } from 'lib/miden/activity/bridge-in';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import { ITransactionStatus } from 'lib/miden/db/types';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import * as Repo from 'lib/miden/repo';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { submitAgglayerDeposit, type AgglayerClient } from './deposit';
import { runAgglayerReceive } from './flows';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
}));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: jest.fn(() => 'testnet'),
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({
  initBridgeConfig: async () => undefined,
  getBridgeConfigSnapshot: () => jest.requireActual<typeof import('lib/bridge/testing/fixtures')>('lib/bridge/testing/fixtures').referenceSnapshot('testnet')
}));
jest.mock('lib/agglayer/contract', () => ({
  midenAddrToEvmAddr: (value: string) => {
    if (value !== '0x387149ae66116cf114eebd60bb7381') throw new Error('Wrong destination');
    return '0x00000000387149ae66116cf114eebd60bb738100';
  }
}));

const depositHash: Hash = `0x${'c'.repeat(64)}`;
const resetHash: Hash = `0x${'a'.repeat(64)}`;
const approvalHash: Hash = `0x${'b'.repeat(64)}`;
const rpc = {
  readContract: jest.fn(), call: jest.fn(), estimateGas: jest.fn(), waitForTransactionReceipt: jest.fn(),
  getBalance: jest.fn(), getGasPrice: jest.fn(), getTransaction: jest.fn(), getBlockNumber: jest.fn(),
  getTransactionCount: jest.fn(), getBlock: jest.fn()
} satisfies AgglayerClient;
const wallet = jest.fn();
const provider: EIP1193Provider = { request: wallet, on: jest.fn(), removeListener: jest.fn() };
let allowance: bigint;
let tokenAddress: Hex;
let bridgeAddress: Hex;
let approvedAmount: bigint;
let signed: { to: string; data: Hex; value: Hex; chainId: Hex; from: string; gas: Hex }[];

function nativeReview(): ReviewedTransfer {
  const route = testRoute();
  return { route, amount: '1.00000000', accounts: { ...accounts }, quote: {
    kind: 'agglayer', received: '1', validity: { kind: 'time', expiresAt: now + 60000 },
    request: { routeId: route.id, recovery: structuredClone(route.recovery), amount: '1.00000000', ...accounts }
  } };
}

async function drive(review = reviewedErc20Transfer('agglayer'), operationId = 'agglayer-operation') {
  assertReviewedBridge(review, structuredClone(review), now);
  const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!route || review.route.destination.kind !== 'miden') throw new Error('Missing accepted Agglayer route');
  bridgeAddress = route.contractAddress;
  if (review.route.source.kind === 'erc20') tokenAddress = `0x${review.route.source.address.slice(2)}`;
  approvedAmount = parseUnits(review.amount, review.route.source.decimals);
  let complete: (error?: unknown) => void = () => undefined;
  const finished = new Promise<unknown>(resolve => { complete = resolve; });
  let captured: BridgeOperationSnapshot | undefined;
  const wrapper = createBridgeReceiveReconciler({ getLocks: () => undefined });
  const id = await wrapper.startSubmission(() => initiateBridgedReceiveTransaction({
    accountId: accounts.midenAccount, amount: parseUnits('1', review.route.destination.decimals),
    faucetId: review.route.destination.faucetId, provider: 'agglayer', sourceAddress: accounts.evmAddress,
    sourceChainId: route.chainId, sourceAmount: review.amount, sourceSymbol: review.route.source.symbol,
    agglayerRoute: route, operation: { operationId, review },
    agglayerDelivery: review.route.source.kind === 'erc20' ? { originToken: `0x${review.route.source.address.slice(2)}`, faucetId: review.route.destination.faucetId, scale: 10 } : undefined
  }), async (rowId, claimed) => {
    captured = claimed;
    if (!captured) { complete(new Error('Missing real CAS winner')); return; }
    try { await submitAgglayerDeposit({ rowId, operation: captured, provider, client: rpc }); complete(); }
    catch (error) { complete(error); }
  });
  const error = await finished;
  const row = await Repo.transactions.get(id);
  expect(row).toBeDefined();
  expect(bridgeOperationOf(row!)?.sourceAttempt).toBeDefined();
  return { id, row, error, captured };
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  jest.spyOn(Date, 'now').mockReturnValue(now);
  await Repo.transactions.clear();
  allowance = 0n;
  signed = [];
  rpc.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'allowance') return allowance;
    if (functionName === 'balanceOf') return 10n ** 25n;
    if (functionName === 'decimals') return 18;
    if (functionName === 'isEmergencyState') return false;
    throw new Error('Unexpected read');
  });
  rpc.call.mockResolvedValue({ data: '0x' });
  rpc.estimateGas.mockResolvedValue(100000n);
  rpc.getBalance.mockResolvedValue(10n ** 25n);
  rpc.getGasPrice.mockResolvedValue(100n);
  rpc.getTransaction.mockImplementation(async ({ hash }) => {
    const tx = signed.find(item => item.to === tokenAddress && decodeFunctionData({ abi: erc20Abi, data: item.data }).args?.[1] === (hash === resetHash ? 0n : approvedAmount));
    return { hash, from: accounts.evmAddress, to: tx?.to ?? bridgeAddress, input: tx?.data ?? '0x', value: 0n, nonce: hash === resetHash ? 1 : 2, blockNumber: 1n };
  });
  rpc.waitForTransactionReceipt.mockImplementation(async ({ hash }) => {
    allowance = hash === resetHash ? 0n : approvedAmount;
    return { status: 'success', transactionHash: hash };
  });
  wallet.mockImplementation(async ({ method, params }) => {
    if (method === 'eth_accounts') return [accounts.evmAddress];
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method !== 'eth_sendTransaction') throw new Error('Unexpected wallet method');
    const tx = params[0];
    signed.push(tx);
    if (tx.to.toLowerCase() === bridgeAddress.toLowerCase()) return signed.filter(item => item.to === bridgeAddress).length === 1 ? depositHash : `0x${'d'.repeat(64)}`;
    if (tx.to.toLowerCase() !== tokenAddress.toLowerCase()) throw new Error('Wrong signing target');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (decoded.functionName !== 'approve' || decoded.args[0].toLowerCase() !== bridgeAddress.toLowerCase()) throw new Error('Wrong approval call');
    return decoded.args[1] === 0n ? resetHash : approvalHash;
  });
});
afterEach(() => jest.restoreAllMocks());

it('admits a reviewed receive through the provider and existing wrapper once, including duplicate requests', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const route = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
  if (!route || review.route.source.kind !== 'erc20') throw new Error('Missing accepted provider fixture');
  bridgeAddress = route.contractAddress;
  tokenAddress = `0x${review.route.source.address.slice(2)}`;
  approvedAmount = 1000000000000000000n;
  const operation = { operationId: 'provider-receive', review };
  const deps = { client: rpc, provider, checks: { readCurrent: async () => structuredClone(review), verifyBalanceCap: async () => undefined, now: () => now } };
  const first = await runAgglayerReceive(operation, deps);
  const duplicate = await runAgglayerReceive(operation, deps);
  expect(duplicate).toBe(first);
  await waitFor(async () => expect((await Repo.transactions.get(first))?.extraInputs.evmTxHash).toBe(depositHash));
  expect(await Repo.transactions.count()).toBe(1);
  expect(signed.filter(tx => tx.to === bridgeAddress)).toHaveLength(1);
  expect((await Repo.transactions.get(first))?.extraInputs.agglayerDelivery).toEqual({ originToken: tokenAddress, faucetId: '0xb41aed8db850a3d140fc2079216c60', scale: 10 });
});

it('does not adopt another RPC during the asynchronous receive balance-cap check', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const deps = { client: rpc, provider, checks: { readCurrent: async () => structuredClone(review), verifyBalanceCap: async () => { jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private'); }, now: () => now } };
  await expect(runAgglayerReceive({ operationId: 'departed-receive', review }, deps)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
  expect(signed).toHaveLength(0);
});

it('bridges native value exactly once without token approval and saves the original source hash', async () => {
  const { error, row } = await drive(nativeReview());
  expect(error).toBeUndefined();
  expect(signed).toHaveLength(1);
  expect(signed[0]).toMatchObject({ value: '0xde0b6b3a7640000', chainId: '0xaa36a7', from: accounts.evmAddress });
  expect(decodeFunctionData({ abi: AGGLAYER_BRIDGE_ABI, data: signed[0]!.data })).toMatchObject({ functionName: 'bridgeAsset', args: [expect.any(Number), '0x00000000387149AE66116cF114eEbd60Bb738100', 1000000000000000000n, '0x0000000000000000000000000000000000000000', true, '0x'] });
  expect(row?.extraInputs.evmTxHash).toBe(depositHash);
  expect(row?.extraInputs.phase).not.toBe('received');
});

it.each([0n, 1n, 2000000000000000000n])('uses allowance %s without max approval, resetting a nonzero short allowance', async current => {
  allowance = current;
  const { error, row } = await drive();
  expect(error).toBeUndefined();
  const amounts = signed.filter(tx => tx.to === tokenAddress).map(tx => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args?.[1]);
  expect(amounts).toEqual(current === 0n ? [1000000000000000000n] : current === 1n ? [0n, 1000000000000000000n] : []);
  expect(signed.at(-1)).toMatchObject({ to: bridgeAddress, value: '0x0' });
  expect(row?.extraInputs.bridgeOperation?.approvals?.map(item => item.amount)).toEqual(current === 0n ? ['1000000000000000000'] : current === 1n ? ['0', '1000000000000000000'] : undefined);
  expect(row?.extraInputs.evmTxHash).toBe(depositHash);
});

it.each(['native', 'token'])('reserves native gas before a %s wallet prompt', async kind => {
  rpc.getBalance.mockResolvedValue(0n);
  const { error, row } = await drive(kind === 'native' ? nativeReview() : reviewedErc20Transfer('agglayer'));
  expect(signed).toHaveLength(0);
  expect(error).toBeInstanceOf(Error);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
});

it('refuses a changed contract decimal scale before ERC20 approval', async () => {
  const read = rpc.readContract.getMockImplementation()!;
  rpc.readContract.mockImplementation(async args => args.functionName === 'decimals' ? 6 : read(args));
  const { error } = await drive();
  expect(signed).toHaveLength(0);
  expect(error).toBeInstanceOf(Error);
});

it.each(['account', 'chain', 'rpc'])('retains the approval but sends no deposit after %s changes during its receipt', async change => {
  rpc.waitForTransactionReceipt.mockImplementationOnce(async () => {
    allowance = approvedAmount;
    if (change === 'rpc') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
    else wallet.mockImplementation(async ({ method }) => method === 'eth_accounts' ? [change === 'account' ? `0x${'9'.repeat(40)}` : accounts.evmAddress] : '0x1');
    return { status: 'success', transactionHash: approvalHash };
  });
  const { error, row } = await drive();
  expect(signed).toHaveLength(1);
  expect(error).toBeInstanceOf(Error);
  expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
  expect(row?.extraInputs.evmTxHash).toBeUndefined();
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
});

it('refuses a false-return approval without a signature', async () => {
  rpc.call.mockResolvedValue({ data: `0x${'0'.repeat(64)}` });
  const { error } = await drive();
  expect(error).toBeInstanceOf(Error);
  expect(signed).toHaveLength(0);
});

it('retains a first approval hash when metadata and receipt RPCs fail, without a deposit or reload replay', async () => {
  rpc.getTransaction.mockRejectedValue(new Error('RPC unavailable'));
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Receipt unavailable'));
  const { id, error, row } = await drive();
  expect(error).toBeInstanceOf(Error);
  expect(signed).toHaveLength(1);
  expect(row?.extraInputs.bridgeOperation?.approvals).toEqual([expect.objectContaining({ hash: approvalHash, amount: '1000000000000000000' })]);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.phase).toBe('uncertain');
  const replay = jest.fn();
  await createBridgeReceiveReconciler({ getLocks: () => undefined }).startSubmission(async () => id, replay);
  await Repo.transactions.get(id);
  expect(replay).not.toHaveBeenCalled();
});

it('persists the returned original source hash even when the wallet scope leaves during the prompt', async () => {
  const send = wallet.getMockImplementation()!;
  wallet.mockImplementation(async args => {
    const result = await send(args);
    if (args.method === 'eth_sendTransaction') jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
    return result;
  });
  const { error, row } = await drive(nativeReview());
  expect(error).toBeUndefined();
  expect(row?.extraInputs.evmTxHash).toBe(depositHash);
  expect(row?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
});

it('matches an owned native-unit delivery after source readiness, expiry and RPC departure, then records only a completed local consume', async () => {
  const review = reviewedErc20Transfer('agglayer');
  const { error, id } = await drive(review);
  expect(error).toBeUndefined();
  expect(review.route.destination.kind).toBe('miden');
  await updateBridgedReceivePhase(id, 'ready');
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('ready');
  jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://departed-rpc.example/private');
  const info = await takeAgglayerBridgeInInfo({ accountId: accounts.midenAccount, senderAccountId: '0xb41aed8db850a3d140fc2079216c60', amount: 100000000n });
  expect(info).toMatchObject({ bridgeReceiveTxId: id, evmTxHash: depositHash, sourceToken: tokenAddress });
  if (!info) throw new Error('Missing original delivery');
  await Repo.transactions.add({ id: 'local-consume', accountId: accounts.midenAccount, type: 'consume', status: ITransactionStatus.Queued, initiatedAt: now / 1000, displayIcon: 'RECEIVE', amount: 100000000n, faucetId: '0xb41aed8db850a3d140fc2079216c60', transactionId: 'miden-consume' });
  await expect(applyBridgeInToConsumeRow('local-consume', info)).rejects.toThrow();
  expect((await Repo.transactions.get(id))?.extraInputs.phase).toBe('ready');
  await Repo.transactions.update('local-consume', { status: ITransactionStatus.Completed });
  await applyBridgeInToConsumeRow('local-consume', info);
  const received = await Repo.transactions.get(id);
  expect(received?.extraInputs.phase).toBe('received');
  expect(received?.amount).toBe(100000000n);
  expect(received?.transactionId).toBe('miden-consume');
  expect(received?.extraInputs.bridgeOperation?.sourceAttempt?.hash).toBe(depositHash);
});

it.each(['faucet', 'recipient', 'amount', 'malformed', 'restored', 'recovered', 'source-less', 'changed-review'])('does not attribute an owned delivery with %s mismatch', async change => {
  const { id, error } = await drive();
  expect(error).toBeUndefined();
  if (change === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
  if (change === 'recovered') await Repo.transactions.update(id, { recovered: true });
  if (change === 'source-less') await Repo.transactions.update(id, { 'extraInputs.evmTxHash': undefined });
  if (change === 'malformed') await Repo.transactions.update(id, { 'extraInputs.bridgeOperation': { owner: 'wallet' } });
  if (change === 'changed-review') await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.review.amount': '2' });
  const match = await takeAgglayerBridgeInInfo({ accountId: change === 'recipient' ? '0x1111111111111111111111111111' : accounts.midenAccount, senderAccountId: change === 'faucet' ? '0x7c6d1dc7fb7045913d524bbef017f5' : '0xb41aed8db850a3d140fc2079216c60', amount: change === 'amount' ? 99999999n : 100000000n });
  expect(match).toBeUndefined();
  expect((await Repo.transactions.get(id))?.extraInputs.phase).not.toBe('received');
});

it('does not invent the oldest owned recipient-and-amount identity for two different funded operations', async () => {
  const first = await drive();
  expect(first.error).toBeUndefined();
  expect(await takeAgglayerBridgeInInfo({ accountId: accounts.midenAccount, senderAccountId: '0xb41aed8db850a3d140fc2079216c60', amount: 100000000n })).toMatchObject({ bridgeReceiveTxId: first.id });
  const second = await drive(reviewedErc20Transfer('agglayer'), 'another-owned-operation');
  expect(second.error).toBeUndefined();
  expect(second.id).not.toBe(first.id);
  expect(second.row?.extraInputs.evmTxHash).toBe(`0x${'d'.repeat(64)}`);
  expect(await takeAgglayerBridgeInInfo({ accountId: accounts.midenAccount, senderAccountId: '0xb41aed8db850a3d140fc2079216c60', amount: 100000000n })).toBeUndefined();
  expect((await Repo.transactions.get(first.id))?.extraInputs.phase).not.toBe('received');
  expect((await Repo.transactions.get(second.id))?.extraInputs.phase).not.toBe('received');
});

it('retains the untagged legacy source-unit scaling contract', async () => {
  const { id, error } = await drive();
  expect(error).toBeUndefined();
  await Repo.transactions.where({ id }).modify(row => { Reflect.deleteProperty(row.extraInputs, 'bridgeOperation'); row.amount = 1000000000000000000n; });
  expect(await takeAgglayerBridgeInInfo({ accountId: accounts.midenAccount, senderAccountId: '0xb41aed8db850a3d140fc2079216c60', amount: 100000000n })).toMatchObject({ bridgeReceiveTxId: id });
});

it('accepts no-return approval and requires its confirmed allowance before bridging', async () => {
  const { error, row } = await drive();
  expect(error).toBeUndefined();
  expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({ to: tokenAddress, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [bridgeAddress, 1000000000000000000n] }) }));
  expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
  expect(signed).toHaveLength(2);
});

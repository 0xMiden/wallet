// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/deposit.test.ts (MIT).
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseUnits, type EIP1193Provider, type Hash, type Hex } from 'viem';

import { AGGLAYER_BRIDGE_ABI } from 'lib/agglayer/constant';
import { assertReviewedBridge, type ReviewedTransfer } from 'lib/bridge/core/review';
import { bridgeOperationOf, type BridgeOperationSnapshot } from 'lib/bridge/operation';
import { accounts, now, referenceSnapshot, testRoute } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import * as Repo from 'lib/miden/repo';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { submitAgglayerDeposit, type AgglayerClient } from './deposit';

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

async function drive(review = reviewedErc20Transfer('agglayer')) {
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
    agglayerRoute: route, operation: { operationId: 'agglayer-operation', review }
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
    if (tx.to.toLowerCase() === bridgeAddress.toLowerCase()) return depositHash;
    if (tx.to.toLowerCase() !== tokenAddress.toLowerCase()) throw new Error('Wrong signing target');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (decoded.functionName !== 'approve' || decoded.args[0].toLowerCase() !== bridgeAddress.toLowerCase()) throw new Error('Wrong approval call');
    return decoded.args[1] === 0n ? resetHash : approvalHash;
  });
});
afterEach(() => jest.restoreAllMocks());

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

it('accepts no-return approval and requires its confirmed allowance before bridging', async () => {
  const { error, row } = await drive();
  expect(error).toBeUndefined();
  expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({ to: tokenAddress, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [bridgeAddress, 1000000000000000000n] }) }));
  expect(row?.extraInputs.bridgeOperation?.approvals?.[0]?.hash).toBe(approvalHash);
  expect(signed).toHaveLength(2);
});

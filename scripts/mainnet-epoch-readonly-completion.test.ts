/** @jest-environment node */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';
import type { MainnetEpochCheckpoint } from '../playwright/e2e/helpers/mainnet-epoch-checkpoint';
import {
  epochCheckpointFixture,
  epochForwardRequestAuthorityFixture,
  epochReverseAuthorityFixture
} from './helpers/mainnet-epoch-fixture';

const mockClient = {
  readContract: jest.fn(),
  getBalance: jest.fn(),
  getChainId: jest.fn(),
  getTransaction: jest.fn(),
  getTransactionReceipt: jest.fn()
};
const mockVault = jest.fn();
const mockQueue = jest.fn();
const mockArm = jest.fn();
const mockExport = jest.fn();
jest.mock('@playwright/test', () => ({ expect: jest.fn() }));
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: () => mockClient }));
jest.mock('../playwright/e2e/ios/helpers/wc-counterparty', () => ({ WcCounterparty: jest.fn() }));
jest.mock('../playwright/e2e/helpers/balance-truth', () => ({
  vaultBalanceByFaucetId: (...args: unknown[]) => mockVault(...args)
}));
jest.mock('../playwright/e2e/helpers/history', () => ({
  plantQueueBlocker: (...args: unknown[]) => mockQueue(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-consume-authorization', () => ({
  armMainnetConsumeAuthorization: (...args: unknown[]) => mockArm(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-provider', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-request', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-ui', () => ({}));
jest.mock('../playwright/e2e/helpers/bridge', () => ({}));
jest.mock('../playwright/e2e/helpers/epoch-quote', () => ({}));
jest.mock('../playwright/e2e/helpers/swap', () => ({ exportMakerNote: (...args: unknown[]) => mockExport(...args) }));
jest.mock('../playwright/e2e/helpers/mainnet-epoch-evm', () => ({ reconcileEpochEvmReceipts: () => true }));
import {
  runEpochRefund,
  recoverEpochReturn,
  persistEpochEvmCheckpoint
} from '../playwright/e2e/helpers/mainnet-epoch-runtime';

const hash = `0x${'a'.repeat(64)}`;
const authority = {
  nonce: '11111111-1111-4111-8111-111111111111',
  sha256: '1'.repeat(64),
  canonicalSha256: '2'.repeat(64)
};
const refundState = () => ({
  ...epochCheckpointFixture(),
  phase: 'recovery-required' as const,
  paidMidenFees: '14',
  forwardNoteId: hash,
  forwardMidenTxId: hash,
  forwardAuthority: { minimumOutput: '1000001', bindingHash: hash, reclaimHeight: 7200, mandateReclaimHeight: 2200 },
  forwardRequestAuthority: epochForwardRequestAuthorityFixture(hash, epochCheckpointFixture().createdAt),
  returnNoteId: hash,
  returnMidenTxId: `0x${'b'.repeat(64)}`,
  consumeAuthority: authority
});
const returnState = () => ({
  ...refundState(),
  returnNoteId: `0x${'c'.repeat(64)}`,
  forwardReceived: '1001000',
  forwardEvmTxHash: `0x${'d'.repeat(64)}`,
  reverseNonce: '10',
  returnAmount: '1000501',
  evmNonceBefore: 0,
  reverseAuthority: epochReverseAuthorityFixture(),
  reverseReceived: '1000000',
  paidEvmFees: '1000',
  transactions: [{ kind: 'deposit' as const, nonce: 0, hash, feeWei: '1000' }]
});
let directory: string;
const wallet = { getAccountAddress: jest.fn(), refreshBalancesLanded: jest.fn(), page: {} };
beforeEach(() => {
  jest.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'epoch-readonly-completion-'));
  wallet.getAccountAddress.mockResolvedValue(refundState().account);
  wallet.refreshBalancesLanded.mockResolvedValue(undefined);
  mockClient.getChainId.mockResolvedValue(refundState().evm.chainId);
  mockClient.getTransaction.mockResolvedValue({});
  mockClient.getTransactionReceipt.mockResolvedValue({});
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const actor = wallet as unknown as GuardianAwareWalletPage;
const path = () => join(directory, 'checkpoint.json');
function noWrites() {
  expect(mockQueue).not.toHaveBeenCalled();
  expect(mockArm).not.toHaveBeenCalled();
  expect(mockExport).not.toHaveBeenCalled();
}
function pendingEvmState(): MainnetEpochCheckpoint {
  return {
    ...epochCheckpointFixture(),
    phase: 'reverse-authorized',
    forwardNoteId: hash,
    forwardMidenTxId: hash,
    forwardAuthority: { minimumOutput: '1000001', bindingHash: hash, reclaimHeight: 7200, mandateReclaimHeight: 2200 },
    forwardRequestAuthority: epochForwardRequestAuthorityFixture(hash, epochCheckpointFixture().createdAt),
    forwardEvmTxHash: hash,
    forwardReceived: '1001000',
    reverseNonce: '10',
    returnAmount: '1000501',
    evmNonceBefore: 0,
    reverseAuthority: epochReverseAuthorityFixture(),
    transactions: [{ kind: 'approve', nonce: 0, hash }]
  };
}
it('holds a signed EVM journal until its exact checkpoint upload is acknowledged', async () => {
  const state = pendingEvmState();
  const controller = new AbortController();
  const gate = join(directory, 'reverse');
  let settled = false;
  const pending = persistEpochEvmCheckpoint(state, path(), gate, controller.signal);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  try {
    await Promise.resolve();
    expect(existsSync(`${gate}.evm-1.ready`)).toBe(true);
    expect(settled).toBe(false);
    const bytes = readFileSync(path());
    expect(JSON.parse(bytes.toString()).transactions[0].hash).toBe(hash);
    const digest = `${createHash('sha256').update(bytes).digest('hex')}\n`;
    expect(readFileSync(`${gate}.evm-1.ready`, 'utf8')).toBe(digest);
    writeFileSync(`${gate}.evm-1`, digest, { flag: 'wx' });
    await pending;
    expect(state.transactions?.[0].hash).toBe(hash);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});
it('keeps an unacknowledged signed journal blocked after cancellation', async () => {
  const controller = new AbortController();
  const gate = join(directory, 'reverse');
  const pending = persistEpochEvmCheckpoint(pendingEvmState(), path(), gate, controller.signal);
  void pending.catch(() => undefined);
  try {
    await Promise.resolve();
    expect(existsSync(`${gate}.evm-1.ready`)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(JSON.parse(readFileSync(path(), 'utf8')).transactions[0].hash).toBe(hash);
    expect(existsSync(`${gate}.evm-1`)).toBe(false);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});
it('persists the actual EVM fee receipt without requesting another spending release', async () => {
  const state = pendingEvmState();
  state.transactions = [{ kind: 'approve', nonce: 0, hash, feeWei: '1000' }];
  state.paidEvmFees = '1000';
  const gate = join(directory, 'reverse');
  await persistEpochEvmCheckpoint(state, path(), gate, new AbortController().signal);
  expect(JSON.parse(readFileSync(path(), 'utf8')).paidEvmFees).toBe('1000');
  expect(existsSync(`${gate}.evm-1.ready`)).toBe(false);
});
it('finalizes a previously recorded actual return receipt using reads only and does not add its fee twice', async () => {
  const state = returnState();
  mockVault.mockResolvedValue(BigInt(state.native.balance) - BigInt(state.principal) + 1_000_000n - 14n);
  mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance) + 499n);
  mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance) - 1000n);
  await recoverEpochReturn(actor, state, path(), 'unused-upload', new AbortController().signal);
  const saved = JSON.parse(readFileSync(path(), 'utf8'));
  expect(saved.phase).toBe('complete');
  expect(saved.paidMidenFees).toBe('14');
  expect(saved.returnMidenTxId).toBe(state.returnMidenTxId);
  expect(saved.authorizationRunId).toBe(state.authorizationRunId);
  noWrites();
});
it('finalizes a previously recorded original collateral refund using reads only', async () => {
  const state = refundState();
  mockVault.mockResolvedValue(BigInt(state.native.balance) - 14n);
  mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance));
  mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance));
  await runEpochRefund(actor, state, path(), 'unused-upload', new AbortController().signal);
  const saved = JSON.parse(readFileSync(path(), 'utf8'));
  expect(saved.phase).toBe('cancelled');
  expect(saved.paidMidenFees).toBe('14');
  expect(saved.returnMidenTxId).toBe(state.returnMidenTxId);
  expect(saved.lossBudgetUsdMicros).toBe(state.lossBudgetUsdMicros);
  noWrites();
});
it('does not turn an unrelated balance change into a completed return', async () => {
  const state = returnState();
  mockVault.mockResolvedValue(BigInt(state.native.balance));
  mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance) + 499n);
  mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance) - 1000n);
  await expect(
    recoverEpochReturn(actor, state, path(), 'unused-upload', new AbortController().signal)
  ).rejects.toThrow();
  expect(JSON.parse(readFileSync(path(), 'utf8')).phase).toBe('recovery-required');
  noWrites();
});

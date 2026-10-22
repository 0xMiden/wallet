import { Account } from '@miden-sdk/miden-sdk/lazy';

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { snapshotCrashDiagnostics } from 'lib/telemetry/crash-diagnostics';

import { MultisigService, ProposalChainSyncError } from './index';

const hold = {};
const mockChainSync = jest.fn(async () => {});
const mockGetMidenClient = jest.fn(async () => ({ client: { syncChain: () => mockChainSync() } }));
const mockLockAdmission = jest.fn(async () => {});
const mockAssertHold = jest.fn((_hold: object, _label: string) => {});
const mockRetireTrap = jest.fn();
const mockBuildReclaim = jest.fn(async (..._args: unknown[]) => new Uint8Array([3, 4]));
const mockConsumeProposal = jest.fn(async (..._args: unknown[]) => ({ id: 'private-proposal', nonce: 7 }));
const mockReclaimProposal = jest.fn(async (..._args: unknown[]) => ({ id: 'private-reclaim-proposal', nonce: 8 }));
const mockSignProposal = jest.fn(async (..._args: unknown[]) => ({ metadata: { proposalType: 'consume_notes' } }));
const mockLoad = jest.fn(async (..._args: unknown[]) => ({
  accountId: 'private-account',
  signProposal: (...args: unknown[]) => mockSignProposal(...args),
  createTransactionProposalRequest: async () => 'private-request',
  createConsumeNotesProposal: (...args: unknown[]) => mockConsumeProposal(...args),
  createCustomProposal: (...args: unknown[]) => mockReclaimProposal(...args)
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  Account: { deserialize: () => ({ id: () => ({ toString: () => 'private-account' }) }) }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  ...jest.requireActual('@openzeppelin/miden-multisig-client'),
  MultisigClient: class {
    load(...args: unknown[]) {
      return mockLoad(...args);
    }
  }
}));
jest.mock('./signer', () => ({ WalletSigner: class {} }));
jest.mock('./native-http', () => ({ registerGuardianOrigin: () => {} }));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: () => mockGetMidenClient(),
  withWasmClientLock: async <T>(body: (held: object) => Promise<T>) => {
    await mockLockAdmission();
    return body(hold);
  },
  getCurrentWasmLockHold: () => hold,
  assertWasmHoldCurrent: (...args: [object, string]) => mockAssertHold(...args),
  retireWasmClientForCaughtTrap: (...args: unknown[]) => mockRetireTrap(...args)
}));
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: { buildPswapCancelRequest: (...args: unknown[]) => mockBuildReclaim(...args) }
}));
jest.mock('../sdk/sync-and-record-fee-faucet', () => ({
  syncAndRecordFeeFaucet: async (_client: unknown, sync: () => Promise<void>) => sync()
}));

const privateFailure = () =>
  new Error('unclassified private-account 0xabcdef1234 amount 987654321 https://private-boundary.example/path');
const service = async () => {
  const account = Account.deserialize(new Uint8Array());
  return MultisigService.init(
    account,
    'private-key',
    'private-commitment',
    async () => 'signature',
    'https://guardian.invalid'
  );
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('keeps a plain chain-sync rejection as the existing wrapper and original cause', async () => {
  const error = privateFailure();
  mockChainSync.mockRejectedValueOnce(error);
  const loaded = await service();
  const rejected: unknown = await loaded.createConsumeNotesProposal(['private-note']).catch(value => value);
  expect(rejected).toBeInstanceOf(ProposalChainSyncError);
  expect(rejected instanceof ProposalChainSyncError ? rejected.cause : undefined).toBe(error);
  expect(snapshotCrashDiagnostics(rejected)).toEqual({ proposalStep: 'chain_sync' });
  expect(mockConsumeProposal).not.toHaveBeenCalled();
  expect(mockRetireTrap).not.toHaveBeenCalled();
});

it.each(['lock admission', 'client build', 'hold validation'])(
  'keeps a pre-sync %s rejection raw and unlabelled',
  async boundary => {
    const loaded = await service();
    const error = privateFailure();
    if (boundary === 'lock admission') mockLockAdmission.mockRejectedValueOnce(error);
    else if (boundary === 'client build') mockGetMidenClient.mockRejectedValueOnce(error);
    else {
      mockAssertHold.mockImplementationOnce(() => {
        throw error;
      });
    }
    await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    expect(mockChainSync).not.toHaveBeenCalled();
    expect(mockConsumeProposal).not.toHaveBeenCalled();
    expect(mockReclaimProposal).not.toHaveBeenCalled();
    expect(mockRetireTrap).not.toHaveBeenCalled();
  }
);

it('retires a sync trap in its hold and rethrows it raw without a chain-sync diagnostic', async () => {
  const loaded = await service();
  const trap = new WebAssembly.RuntimeError('unreachable');
  mockChainSync.mockRejectedValueOnce(trap);
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(trap);
  expect(snapshotCrashDiagnostics(trap)).toEqual({});
  expect(mockRetireTrap).toHaveBeenCalledTimes(1);
  expect(mockRetireTrap).toHaveBeenCalledWith(hold, trap);
  expect(mockConsumeProposal).not.toHaveBeenCalled();
  expect(mockReclaimProposal).not.toHaveBeenCalled();
});

it.each([
  { label: 'watchdog eviction', failure: () => new WasmClientPoisonedError('watchdog') },
  { label: 'realm-error eviction', failure: () => new WasmClientPoisonedError('realm-error') },
  { label: 'offscreen abort', failure: () => new OperationAbortedError('private-operation', 'deadline') },
  { label: 'terminated client', failure: () => new Error('Client terminated') },
  { label: 'terminated web client', failure: () => new Error('WebClient terminated') }
])('keeps a sync $label raw without retirement, proposal or a chain-sync diagnostic', async ({ failure }) => {
  const loaded = await service();
  const error = failure();
  mockChainSync.mockRejectedValueOnce(error);
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toEqual({});
  expect(mockChainSync).toHaveBeenCalledTimes(1);
  expect(mockRetireTrap).not.toHaveBeenCalled();
  expect(mockConsumeProposal).not.toHaveBeenCalled();
  expect(mockReclaimProposal).not.toHaveBeenCalled();
});

it('names the signer facts beside the step on a Guardian authentication refusal, and only on one', async () => {
  const facts = { guardianSignerInSet: 'no', guardianSigningKey: 'hot', hotKeyRotationPending: 'yes' } as const;
  const refusal = Object.assign(privateFailure(), {
    name: 'GuardianHttpError',
    status: 401,
    code: 'authentication_failed'
  });
  mockConsumeProposal.mockRejectedValueOnce(refusal);
  const loaded = await service();
  loaded.authFacts = facts;
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(refusal);
  expect(snapshotCrashDiagnostics(refusal)).toEqual({ proposalStep: 'proposal_create', ...facts });
  const other = privateFailure();
  mockConsumeProposal.mockRejectedValueOnce(other);
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(other);
  expect(snapshotCrashDiagnostics(other)).toEqual({ proposalStep: 'proposal_create' });
});

it('names the signer facts on a Guardian authentication refusal while signing, for either signing path', async () => {
  const facts = { guardianSignerInSet: 'yes', guardianSigningKey: 'cold', hotKeyRotationPending: 'no' } as const;
  const loaded = await service();
  loaded.authFacts = facts;
  for (const sign of [
    () => loaded.signProposal('private-proposal'),
    () => loaded.signAndCreateTransactionRequest('private-proposal')
  ]) {
    const refusal = Object.assign(privateFailure(), {
      name: 'GuardianHttpError',
      status: 401,
      code: 'authentication_failed'
    });
    mockSignProposal.mockRejectedValueOnce(refusal);
    await expect(sign()).rejects.toBe(refusal);
    expect(snapshotCrashDiagnostics(refusal)).toEqual(facts);
  }
  const other = privateFailure();
  mockSignProposal.mockRejectedValueOnce(other);
  await expect(loaded.signProposal('private-proposal')).rejects.toBe(other);
  expect(snapshotCrashDiagnostics(other)).toEqual({});
});

it('names the consume proposal rejection without wrapping the original Error', async () => {
  const error = privateFailure();
  mockConsumeProposal.mockRejectedValueOnce(error);
  const loaded = await service();
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'proposal_create' });
});

it('keeps a reclaim build failure before persistence or proposal creation', async () => {
  const error = privateFailure();
  mockBuildReclaim.mockRejectedValueOnce(error);
  const persist = jest.fn(async () => {});
  const loaded = await service();
  await expect(loaded.createPswapCancelProposal('private-note', persist)).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'reclaim_build' });
  expect(persist).not.toHaveBeenCalled();
  expect(mockReclaimProposal).not.toHaveBeenCalled();
});

it('keeps a reclaim persistence failure before proposal creation', async () => {
  const error = privateFailure();
  const loaded = await service();
  const bytesSeen: Uint8Array[] = [];
  await expect(
    loaded.createPswapCancelProposal('private-note', async bytes => {
      bytesSeen.push(bytes);
      throw error;
    })
  ).rejects.toBe(error);
  expect(bytesSeen).toEqual([new Uint8Array([3, 4])]);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'reclaim_persist' });
  expect(mockReclaimProposal).not.toHaveBeenCalled();
});

it('names a reclaim proposal rejection only after its bytes were persisted', async () => {
  const error = privateFailure();
  const order: string[] = [];
  mockReclaimProposal.mockImplementationOnce(async () => {
    order.push('proposal');
    throw error;
  });
  const loaded = await service();
  await expect(
    loaded.createPswapCancelProposal('private-note', async () => {
      order.push('persist');
    })
  ).rejects.toBe(error);
  expect(order).toEqual(['persist', 'proposal']);
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'proposal_create' });
});

it('returns successful ordinary and reclaim proposals with unchanged request bytes', async () => {
  const loaded = await service();
  expect(await loaded.createConsumeNotesProposal(['private-note'])).toEqual({ id: 'private-proposal', nonce: 7 });
  const persisted: Uint8Array[] = [];
  expect(
    await loaded.createPswapCancelProposal('private-note', async bytes => {
      persisted.push(bytes);
    })
  ).toEqual({ id: 'private-reclaim-proposal', nonce: 8 });
  expect(persisted).toEqual([new Uint8Array([3, 4])]);
  expect(mockReclaimProposal).toHaveBeenCalledWith(new Uint8Array([3, 4]), 'custom_transaction');
});

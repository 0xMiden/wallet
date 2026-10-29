import { Account } from '@miden-sdk/miden-sdk/lazy';

import { OperationAbortedError } from 'lib/miden/back/offscreen-codec';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import { annotateCrash, snapshotCrashDiagnostics, withProposalStep } from 'lib/telemetry/crash-diagnostics';

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

const mockRequestDeserialize = jest.fn((_bytes: Uint8Array) => ({ expectedOutputOwnNotes: () => [] }));
const mockRebasedSerialize = jest.fn(() => new Uint8Array([5, 6]));
const mockFeeBuilder = jest.fn(async (..._args: unknown[]) => ({
  withOwnOutputNotes: () => ({ build: () => ({ serialize: () => mockRebasedSerialize() }) })
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  Account: { deserialize: () => ({ id: () => ({ toString: () => 'private-account' }) }) },
  TransactionRequest: { deserialize: (bytes: Uint8Array) => mockRequestDeserialize(bytes) },
  NoteArray: class {}
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  feeAwareRequestBuilder: (...args: unknown[]) => mockFeeBuilder(...args),
  randomFeeSalt: () => ({})
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
  expect(snapshotCrashDiagnostics(refusal)).toEqual({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'unmatched',
    ...facts
  });
  const other = privateFailure();
  mockConsumeProposal.mockRejectedValueOnce(other);
  await expect(loaded.createConsumeNotesProposal(['private-note'])).rejects.toBe(other);
  expect(snapshotCrashDiagnostics(other)).toEqual({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'unmatched'
  });
});

it('names the signer facts on a Guardian authentication refusal while signing, for either signing path', async () => {
  const facts = { guardianSignerInSet: 'yes', guardianSigningKey: 'cold', hotKeyRotationPending: 'no' } as const;
  const loaded = await service();
  loaded.authFacts = facts;
  for (const { sign, expected } of [
    { sign: () => loaded.signProposal('private-proposal'), expected: facts },
    {
      sign: () => loaded.signAndCreateTransactionRequest('private-proposal'),
      expected: { ...facts, proposalStep: 'proposal_sign' }
    }
  ]) {
    const refusal = Object.assign(privateFailure(), {
      name: 'GuardianHttpError',
      status: 401,
      code: 'authentication_failed'
    });
    mockSignProposal.mockRejectedValueOnce(refusal);
    await expect(sign()).rejects.toBe(refusal);
    expect(snapshotCrashDiagnostics(refusal)).toEqual(expected);
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
  expect(snapshotCrashDiagnostics(error)).toEqual({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'unmatched'
  });
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

describe('a rebased custom proposal (Sentry BREAD-WALLET-35)', () => {
  it.each([
    {
      boundary: 'request read',
      fail: (error: Error) =>
        mockRequestDeserialize.mockImplementationOnce(() => {
          throw error;
        })
    },
    { boundary: 'fee builder', fail: (error: Error) => mockFeeBuilder.mockRejectedValueOnce(error) },
    {
      boundary: 'request rebuild',
      fail: (error: Error) =>
        mockRebasedSerialize.mockImplementationOnce(() => {
          throw error;
        })
    }
  ])('names a failed $boundary as the rebase build, before any proposal', async ({ fail }) => {
    const error = privateFailure();
    fail(error);
    const loaded = await service();
    await expect(loaded.createRebasedCustomProposal(new Uint8Array([1]), 'swap')).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'rebase_build' });
    expect(mockReclaimProposal).not.toHaveBeenCalled();
  });

  it('keeps a lost hold after the rebuild unlabelled', async () => {
    const error = privateFailure();
    const loaded = await service();
    mockAssertHold.mockImplementation((_hold, label) => {
      if (label.includes('after the fee-aware builder')) throw error;
    });
    try {
      await expect(loaded.createRebasedCustomProposal(new Uint8Array([1]), 'swap')).rejects.toBe(error);
    } finally {
      mockAssertHold.mockImplementation(() => {});
    }
    expect(snapshotCrashDiagnostics(error)).toEqual({});
  });

  it('names the guardian rejecting the rebuilt request as proposal creation, not the rebuild', async () => {
    const error = privateFailure();
    mockReclaimProposal.mockRejectedValueOnce(error);
    const loaded = await service();
    await expect(loaded.createRebasedCustomProposal(new Uint8Array([1]), 'swap')).rejects.toBe(error);
    expect(mockReclaimProposal).toHaveBeenCalledWith(new Uint8Array([5, 6]), 'swap');
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'proposal_create' });
  });

  it('returns the proposal and the bytes it was made from', async () => {
    const loaded = await service();
    await expect(loaded.createRebasedCustomProposal(new Uint8Array([1]), 'swap')).resolves.toEqual({
      proposal: { id: 'private-reclaim-proposal', nonce: 8 },
      requestBytes: new Uint8Array([5, 6])
    });
  });
});

it.each([
  ['LegacyConsumeNotesNoteMissingError', 'consume_notes_legacy_note_missing', 'consume_note_missing'],
  ['ConsumeNoteNotAuthenticatedError', 'consume_notes_note_not_authenticated', 'consume_note_not_verified'],
  ['ConsumeNotesMetadataOversizeError', 'consume_notes_metadata_oversize', 'consume_metadata_oversize'],
  ['MultisigAuthArgsMissingError', 'multisig_auth_args_missing', 'multisig_required_args_missing'],
  ['BoundBlockNotDeclaredError', 'bound_block_not_declared', 'bound_block_not_declared'],
  ['TransactionSummaryLayoutError', 'transaction_summary_layout_unsupported', 'summary_layout_unsupported']
])('observes only the actual consume rejection family %s without changing the SDK call', async (name, code, family) => {
  const loaded = await service();
  const ids = ['private-note'];
  const error = Object.assign(new Error('failed to get input note: private-canary'), { name, code });
  mockConsumeProposal.mockRejectedValueOnce(error);
  await expect(loaded.createConsumeNotesProposal(ids)).rejects.toBe(error);
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  expect(mockConsumeProposal).toHaveBeenCalledWith(ids);
  expect(snapshotCrashDiagnostics(error)).toMatchObject({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: family
  });
});

it('does not carry a reused consume rejection observation into later signing', async () => {
  const loaded = await service();
  const error = new Error('failed to get account: private');
  mockConsumeProposal.mockRejectedValueOnce(error);
  await expect(loaded.createConsumeNotesProposal(['private'])).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('proposalCreateFamily', 'sdk_account_read');
  mockSignProposal.mockRejectedValueOnce(error);
  await loaded.signAndCreateTransactionRequest('private-proposal').catch(() => {});
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('proposalCreateFamily');
  const { snapshotProposalCreateDiagnostics } = await import('lib/telemetry/proposal-create-diagnostics');
  expect(snapshotProposalCreateDiagnostics(error)).toBeUndefined();
});

it('clears an earlier inline proving observation when the same Error is rejected by creation', async () => {
  const { annotateGuardianProving } = await import('lib/telemetry/guardian-proving-diagnostics');
  const error = new Error('failed to get account: private');
  annotateGuardianProving(error, { guardianProvingSubstep: 'prove_local' });
  const loaded = await service();
  mockConsumeProposal.mockRejectedValueOnce(error);
  await expect(loaded.createConsumeNotesProposal(['private'])).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('proposalCreateFamily', 'sdk_account_read');
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('guardianProvingSubstep');
});

it('rebinds a reused signing rejection to the next actual consume-creation boundary', async () => {
  const loaded = await service();
  const error = new Error('failed to get account: private');
  mockSignProposal.mockRejectedValueOnce(error);
  await expect(loaded.signAndCreateTransactionRequest('private-proposal')).rejects.toBe(error);
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('proposalStep', 'proposal_sign');
  const ids = ['private-note'];
  mockConsumeProposal.mockRejectedValueOnce(error);
  await expect(loaded.createConsumeNotesProposal(ids)).rejects.toBe(error);
  expect(mockSignProposal).toHaveBeenCalledTimes(1);
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  expect(mockConsumeProposal).toHaveBeenCalledWith(ids);
  expect(snapshotCrashDiagnostics(error)).toMatchObject({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'sdk_account_read'
  });
});

it('keeps current innermost creation evidence while an older outer boundary propagates the rejection', async () => {
  const loaded = await service();
  const error = new Error('failed to get account: private');
  mockConsumeProposal.mockRejectedValueOnce(error);
  await expect(withProposalStep('sign_lock', () => loaded.createConsumeNotesProposal(['private-note']))).rejects.toBe(
    error
  );
  expect(snapshotCrashDiagnostics(error)).toMatchObject({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'sdk_account_read'
  });
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
});

it.each(['proposal_sign', 'proposal_create'] as const)(
  'replaces the complete stale %s group when a new consume rejection is observed',
  async proposalStep => {
    const loaded = await service();
    const error = new Error('failed to get account: private');
    annotateCrash(error, { proposalStep, proposalGuard: 'hot_key_missing', securityChange: 'switch-guardian' });
    mockConsumeProposal.mockRejectedValueOnce(error);
    await expect(
      withProposalStep('sign_lock', () => loaded.createConsumeNotesProposal(['private-note']), 'replace-hot-key')
    ).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({
      proposalStep: 'proposal_create',
      proposalCreateApi: 'consume_notes',
      proposalCreateFamily: 'sdk_account_read'
    });
    expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  }
);

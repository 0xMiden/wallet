import { NoteType, TransactionProver } from '@miden-sdk/miden-sdk/lazy';

import { clearGuardianCache, type GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import { clearGuardianAccountLocks, getGuardianCandidate } from 'lib/miden/guardian/serialize';
import * as Repo from 'lib/miden/repo';
import * as nativeAsset from 'lib/miden-chain/native-asset';
import { isCrashReportingEnabledAsync } from 'lib/settings/helpers';
import type { WalletAccount } from 'lib/shared/types';
import { initCrashReporting, stopCrashReporting } from 'lib/telemetry/crash';
import { snapshotCrashDiagnostics } from 'lib/telemetry/crash-diagnostics';
import * as transactionFailure from 'lib/telemetry/transaction-failure';
import { WalletType } from 'screens/onboarding/types';

import { generateTransaction } from './index';
import { ITransactionStatus, type ITransaction } from '../db/types';

const hold = {};
const order: string[] = [];
// Per-test faults for the submit crossing and the completion, reset in beforeEach.
const mockState: {
  requestSerialize?: Error;
  clientBuild?: Error;
  proposalRequest?: Error;
  customAdvice?: Error;
  customBuild?: Error;
  signLock?: Error;
  resultRead?: Error;
  resultSerialize?: Error;
  noInputNotes?: boolean;
  noAssets?: boolean;
} = {};
const noteId = `0x${'ab'.repeat(32)}`;
const transactionId = `0x${'bc'.repeat(32)}`;
const accountId = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
const faucetId = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5devq';
const privateUrl = 'https://private-boundary.example/secret-path';
const privateAmount = '987654321';
const oldBytes = new Uint8Array([1, 2]);
const newBytes = new Uint8Array([3, 4]);
const accountRef = (value: string) => ({ toString: () => value, toHex: () => value });
const mockAccount = { id: () => accountRef(accountId) };
const mockAccountRead = jest.fn(async (..._args: unknown[]): Promise<typeof mockAccount | null> => mockAccount);
const mockSignerRead = jest.fn(async () => ({ commitment: 'commitment' }));
const mockReclaimBuild = jest.fn(async (..._args: unknown[]) => newBytes);
const mockConsumableNotes = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const mockConsumeProposal = jest.fn(async (..._args: unknown[]) => {
  order.push('proposal_returned');
  return { id: 'private-proposal-id', nonce: 7, metadata: { proposalType: 'consume' } };
});
const mockReclaimProposal = jest.fn(async (..._args: unknown[]) => ({
  id: 'private-reclaim-proposal-id',
  nonce: 8,
  metadata: { proposalType: 'custom' }
}));
const mockAbandon = jest.fn(async (..._args: unknown[]) => {});
const mockPrepareCustom = jest.fn(async (..._args: unknown[]) => {
  if (mockState.customAdvice) throw mockState.customAdvice;
  return {};
});
const mockSignProposal = jest.fn(async (..._args: unknown[]) => ({ metadata: { proposalType: 'consume' } }));
const mockSubmit = jest.fn(async () => ({ apply: async () => {} }));
const executedNote = {
  id: () => accountRef(noteId),
  metadata: () => ({ sender: () => accountRef('private-sender'), noteType: () => NoteType.Public }),
  assets: () => ({
    fungibleAssets: () =>
      mockState.noAssets ? [] : [{ faucetId: () => accountRef(faucetId), amount: () => 987654321n }]
  })
};
const header = () => ({ to_commitment: () => accountRef(`0x${'de'.repeat(32)}`), nonce: () => ({ asInt: () => 1n }) });
const result = {
  executedTransaction: () => ({
    id: () => accountRef(transactionId),
    accountId: () => accountRef(accountId),
    initialAccountHeader: header,
    finalAccountHeader: header,
    inputNotes: () => {
      if (mockState.resultRead && mockSubmit.mock.calls.length > 0) throw mockState.resultRead;
      return {
        notes: () =>
          mockState.noInputNotes
            ? []
            : [{ id: () => accountRef(noteId), serialize: () => new Uint8Array([7, 3]), note: () => executedNote }]
      };
    },
    outputNotes: () => ({ notes: () => [] }),
    userOutputNotes: () => []
  }),
  serialize: () => {
    if (mockState.resultSerialize) throw mockState.resultSerialize;
    return new Uint8Array([5, 6]);
  }
};
const mockExecute = jest.fn(async (..._args: unknown[]) => ({
  result,
  prove: async () => ({
    proof: {
      nullifiers: () => [accountRef(`0x${'cd'.repeat(32)}`)],
      refBlockNumber: () => 100,
      refBlockCommitment: () => accountRef(`0x${'ef'.repeat(32)}`),
      expirationBlockNumber: () => 120
    },
    submit: () => mockSubmit()
  })
}));
const mockLoad = jest.fn(async (..._args: unknown[]) => ({
  accountId,
  createConsumeNotesProposal: (...args: unknown[]) => mockConsumeProposal(...args),
  createCustomProposal: (...args: unknown[]) => mockReclaimProposal(...args),
  signProposal: (...args: unknown[]) => mockSignProposal(...args),
  prepareCustomExecution: (...args: unknown[]) => mockPrepareCustom(...args),
  abandonCandidate: (...args: unknown[]) => mockAbandon(...args),
  createTransactionProposalRequest: async () => {
    if (mockState.proposalRequest) throw mockState.proposalRequest;
    return {
      authArg: () => undefined,
      serialize: () => {
        if (mockState.requestSerialize) throw mockState.requestSerialize;
        return new Uint8Array([7, 8]);
      }
    };
  },
  syncState: async () => {}
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  NoteFile: {
    fromInputNote: (note: { serialize: () => Uint8Array }) => ({ serialize: () => note.serialize(), free: () => {} })
  },
  TransactionProver: { newLocalProver: () => ({}) },
  TransactionRequest: {
    deserialize: () => {
      if (mockState.customBuild) throw mockState.customBuild;
      return { extendAdviceMap: () => ({ authArg: () => undefined, serialize: () => oldBytes }) };
    }
  }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  ...jest.requireActual('@openzeppelin/miden-multisig-client'),
  MultisigClient: class {
    load(...args: unknown[]) {
      return mockLoad(...args);
    }
  }
}));
jest.mock('../guardian/account', () => ({
  ...jest.requireActual('../guardian/account'),
  getSignerDetailsFromAccount: () => mockSignerRead(),
  resolveGuardianEndpoint: () => 'https://guardian.invalid'
}));
jest.mock('../guardian/signer', () => ({ WalletSigner: class {} }));
jest.mock('../guardian/native-http', () => ({
  ...jest.requireActual('../guardian/native-http'),
  registerGuardianOrigin: () => {}
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  canonicalWalletAccountId: (value: string) => value,
  sameWalletAccountId: (left: string, right: string) => left === right,
  getBech32AddressFromAccountId: (value: { toString: () => string }) => value.toString()
}));
jest.mock('../sdk/miden-client', () => ({
  ...jest.requireActual('../sdk/miden-client'),
  getMidenClient: async () => {
    // Only the pipeline's own build runs after the Guardian signed.
    if (mockState.clientBuild && mockSignProposal.mock.calls.length > 0) throw mockState.clientBuild;
    return {
      getAccount: (...args: unknown[]) => mockAccountRead(...args),
      client: {
        syncChain: async () => {},
        transactions: { executeRequest: (...args: unknown[]) => mockExecute(...args) }
      }
    };
  },
  withWasmClientLock: async <T>(body: (held: object) => Promise<T>) => {
    if (mockState.signLock) {
      const error = mockState.signLock;
      delete mockState.signLock;
      throw error;
    }
    return body(hold);
  },
  withWasmLockWatchdogPaused: async <T>(body: () => Promise<T>) => body(),
  getCurrentWasmLockHold: () => hold,
  assertWasmHoldCurrent: () => {}
}));
jest.mock('../back/miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: (...args: unknown[]) => mockAccountRead(...args),
    buildPswapCancelRequest: (...args: unknown[]) => mockReclaimBuild(...args),
    getConsumableNotes: (...args: unknown[]) => mockConsumableNotes(...args)
  }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  __esModule: true,
  ...jest.requireActual('lib/miden-chain/native-asset')
}));
jest.mock('../sdk/sync-and-record-fee-faucet', () => ({
  syncAndRecordFeeFaucet: async (_client: unknown, sync: () => Promise<void>) => sync()
}));
jest.mock('../sync-lock', () => ({ syncUnderBoundedLock: async () => {} }));
jest.mock('../back/offscreen-prover', () => ({
  ...jest.requireActual('../back/offscreen-prover'),
  isOffscreenAvailable: () => true
}));
jest.mock('../guardian/tip-execution', () => ({ prepareGuardianTipExecution: async () => {} }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: async () => {},
  notifyBackgroundTransactionNotConfirmed: async () => {}
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn(), reportProve: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => ({
  __esModule: true,
  ...jest.requireActual('lib/telemetry/transaction-failure')
}));
jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(async () => true)
}));
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isMobile: jest.fn(() => false),
  isExtension: jest.fn(() => true)
}));

const account: WalletAccount = {
  publicKey: accountId,
  name: 'Local account',
  isPublic: false,
  type: WalletType.Guardian,
  hdIndex: 0,
  hotPublicKey: 'private-hot-key',
  authScheme: 'ecdsa'
};
const provider = (selected = account): GuardianAccountProvider => ({
  getAccounts: async () => [selected],
  getPublicKeyForCommitment: async () => 'private-key',
  signWord: async () => 'private-signature'
});
const row = (reclaim = false): ITransaction => ({
  id: 'private-row',
  type: 'consume',
  accountId,
  noteId,
  noteIds: [noteId],
  status: ITransactionStatus.Queued,
  initiatedAt: Math.floor(Date.now() / 1000),
  displayIcon: 'RECEIVE',
  delegateTransaction: false,
  ...(reclaim ? { requestBytes: oldBytes, extraInputs: { swapSettleKind: 'reclaim' } } : {})
});
const privateFailure = () =>
  new Error(
    `unclassified ${accountId} note ${noteId} transaction ${transactionId} faucet ${faucetId} amount ${privateAmount} ${privateUrl}`
  );
interface WireRequest {
  url: string;
  headers: string;
  body: string;
}
const requests: WireRequest[] = [];
const configRequests: (WireRequest & { method: string })[] = [];
const publicConfigUrl = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json';
let originalFetch: PropertyDescriptor | undefined;
let previousDsn: string | undefined;
let previousOffscreen: string | undefined;

beforeAll(() => {
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  previousDsn = process.env.SENTRY_DSN;
  previousOffscreen = process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: unknown, init?: { body?: unknown; headers?: unknown; method?: string }) => {
      const body = init?.body;
      const request = {
        url: String(input),
        headers:
          init?.headers instanceof Headers
            ? [...init.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n')
            : JSON.stringify(init?.headers ?? {}),
        body:
          typeof body === 'string'
            ? body
            : ArrayBuffer.isView(body)
              ? new TextDecoder().decode(body)
              : (JSON.stringify(body) ?? '')
      };
      const method = init?.method ?? 'GET';
      if (request.url === publicConfigUrl && method === 'GET' && body === undefined) {
        configRequests.push({ ...request, method });
      } else {
        requests.push(request);
      }
      return { status: 200, headers: new Headers() };
    }
  });
});
afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  if (previousDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = previousDsn;
  if (previousOffscreen === undefined) delete process.env.MIDEN_USE_OFFSCREEN_CLIENT;
  else process.env.MIDEN_USE_OFFSCREEN_CLIENT = previousOffscreen;
});
beforeEach(async () => {
  clearGuardianCache();
  clearGuardianAccountLocks();
  jest.clearAllMocks();
  requests.length = 0;
  configRequests.length = 0;
  order.length = 0;
  for (const key of Object.keys(mockState)) Reflect.deleteProperty(mockState, key);
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'false';
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  await Repo.transactions.clear();
  initCrashReporting({ listenToGlobals: false });
});
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
};
afterEach(async () => {
  await flush();
  stopCrashReporting();
  jest.restoreAllMocks();
});

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('Missing event object');
  const nested: unknown = Reflect.get(value, key);
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) throw new Error(`Missing event ${key}`);
  return Object.fromEntries(Object.entries(nested));
}
const consumeAtProposal =
  'Transaction failed: tx_receive; stage signing; signing step creating_proposal; realm unknown; ' +
  'proving preference local; platform extension; queued by unrecorded; last deferral none; ' +
  'claim fee admission unrecorded; submit crossing unavailable; point pipeline; unknown; thrown error. authentication';
async function failureEvent(step: string, guard?: string, message = consumeAtProposal): Promise<void> {
  await failureEventWith({ proposalStep: step, proposalGuard: guard }, message);
}
async function failureEventWith(expected: Record<string, string | undefined>, message: string): Promise<void> {
  await flush();
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (!request) throw new Error('No outgoing Sentry request');
  const lines = request.body.split('\n');
  const item = lines.findIndex(line => {
    try {
      return JSON.parse(line).type === 'event';
    } catch {
      return false;
    }
  });
  expect(item).toBeGreaterThanOrEqual(0);
  const event: unknown = JSON.parse(lines[item + 1] ?? '');
  const values = objectAt(event, 'exception').values;
  expect(Array.isArray(values)).toBe(true);
  if (!Array.isArray(values)) throw new Error('Missing exception values');
  expect(values).toHaveLength(1);
  const exception = objectAt(values, '0');
  expect(exception.type).toBe('WalletTransactionFailure');
  expect(exception.value).toEqual(expect.stringContaining(message));
  const diagnostics = objectAt(objectAt(event, 'extra'), 'walletDiagnostics');
  for (const [key, value] of Object.entries(expected)) expect(diagnostics[key]).toBe(value);
  const wholeRequest = JSON.stringify(request);
  for (const value of [
    accountId,
    noteId,
    transactionId,
    faucetId,
    privateAmount,
    privateUrl,
    'private-boundary.example',
    'secret-path',
    'ab'.repeat(16),
    'bc'.repeat(16),
    accountId.slice(0, 20),
    'private-hot-key',
    'private-row',
    'private-proposal-id'
  ]) {
    expect(wholeRequest).not.toContain(value);
  }
}
async function run(
  selected = account,
  reclaim = false,
  selectedProvider = provider(selected)
): Promise<ITransaction | undefined> {
  const transaction = row(reclaim);
  await Repo.transactions.put(transaction);
  await generateTransaction(transaction, async () => new Uint8Array(), false, selectedProvider);
  return Repo.transactions.get(transaction.id);
}
function expectTerminal(stored: ITransaction | undefined, stage = 'creating-proposal'): void {
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage });
  expect(stored?.failureDiagnostics).toBeUndefined();
  expect(stored).not.toHaveProperty('proposalStep');
  expect(stored).not.toHaveProperty('proposalGuard');
  expect(stored?.nextEligibleAt).toBeUndefined();
  expect(stored?.requeueStreak).toBeUndefined();
  expect(mockSignProposal).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(mockAbandon).not.toHaveBeenCalled();
  expect(getGuardianCandidate(accountId)).toBeUndefined();
}

it('reports the consume service-selection read after routing and the guardian check succeed', async () => {
  const error = privateFailure();
  const getAccounts = jest
    .fn(async () => [account])
    .mockResolvedValueOnce([account])
    .mockResolvedValueOnce([account])
    .mockRejectedValueOnce(error);
  expectTerminal(await run(account, false, { ...provider(), getAccounts }));
  expect(getAccounts).toHaveBeenCalledTimes(3);
  expect(mockAccountRead).not.toHaveBeenCalled();
  expect(mockSignerRead).not.toHaveBeenCalled();
  expect(mockLoad).not.toHaveBeenCalled();
  expect(mockConsumeProposal).not.toHaveBeenCalled();
  expect(mockReclaimProposal).not.toHaveBeenCalled();
  await failureEvent('service_select');
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select' });
});

it('carries the inner real service-load fact through the full terminal report path', async () => {
  const error = privateFailure();
  mockLoad.mockRejectedValueOnce(error);
  expectTerminal(await run());
  await failureEvent('service_load');
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
  expect(mockConsumeProposal).not.toHaveBeenCalled();
});

it('reports the real consume proposal boundary once without changing terminal behavior', async () => {
  const error = privateFailure();
  mockConsumeProposal.mockRejectedValueOnce(error);
  expectTerminal(await run());
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  await failureEvent('proposal_create');
  expect(snapshotCrashDiagnostics(error)).toEqual({
    proposalStep: 'proposal_create',
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'unmatched'
  });
});

it('sends the signer facts with a Guardian authentication refusal and no key, signature or identifier', async () => {
  const refusal = Object.assign(privateFailure(), {
    name: 'GuardianHttpError',
    status: 401,
    code: 'authentication_failed'
  });
  mockConsumeProposal.mockRejectedValueOnce(refusal);
  await run();
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  await failureEventWith(
    {
      proposalStep: 'proposal_create',
      guardianSignerInSet: 'unknown',
      guardianSigningKey: 'hot',
      hotKeyRotationPending: 'no'
    },
    'stage signing'
  );
});

function expectHookRejection(
  report: jest.SpyInstance<
    ReturnType<typeof transactionFailure.reportTransactionFailure>,
    Parameters<typeof transactionFailure.reportTransactionFailure>
  >,
  original: Error
): void {
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0].error).toBe(original);
}

it('reports failed reclaim persistence before proposing and keeps the stored retry bytes', async () => {
  const error = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  const rejectPersist = (changes: unknown) => {
    if (typeof changes !== 'object' || changes === null) return;
    if (Object.keys(changes).some(key => key === 'requestBytes' || key.startsWith('requestBytes.'))) throw error;
  };
  Repo.transactions.hook('updating', rejectPersist);
  try {
    const stored = await run(account, true);
    expectTerminal(stored);
    expect(stored?.requestBytes).toEqual(oldBytes);
    expect(mockReclaimBuild).toHaveBeenCalledTimes(1);
    expect(mockReclaimProposal).not.toHaveBeenCalled();
    expectHookRejection(report, error);
    await failureEvent('reclaim_persist');
  } finally {
    Repo.transactions.hook('updating').unsubscribe(rejectPersist);
  }
});

it('reports a failed signing-stage write after proposal return without resending', async () => {
  const error = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  const rejectStage = (changes: unknown) => {
    if (typeof changes === 'object' && changes !== null && Reflect.get(changes, 'stage') === 'signing-proposal') {
      order.push('signing_stage_write');
      throw error;
    }
  };
  Repo.transactions.hook('updating', rejectStage);
  try {
    expectTerminal(await run());
    expect(order).toEqual(['proposal_returned', 'signing_stage_write']);
    expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
    expect(mockSignProposal).not.toHaveBeenCalled();
    expectHookRejection(report, error);
    await failureEvent('signing_stage_write');
  } finally {
    Repo.transactions.hook('updating').unsubscribe(rejectStage);
  }
});

it('reports only the source-known missing-hot-key guard without key material', async () => {
  expectTerminal(await run({ ...account, hotPublicKey: undefined }));
  expect(mockLoad).not.toHaveBeenCalled();
  await failureEvent('service_select', 'hot_key_missing');
});

it('completes an ordinary consume without producing a failure report', async () => {
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Completed, stage: 'complete', amount: 987654321n });
  expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  await flush();
  expect(requests).toEqual([]);
  expect(configRequests).toEqual([
    { url: publicConfigUrl, method: 'GET', headers: '{"Accept":"application/json"}', body: '' }
  ]);
});

it.each([
  {
    label: 'backpressure',
    error: { status: 409, code: 'conflict_pending_delta' },
    reason: 'guardian_backpressure',
    cooldown: 15,
    arm: 'guardian-pending-conflict',
    busy: true
  },
  {
    label: 'outage',
    error: new TypeError('Failed to fetch'),
    reason: 'guardian_unreachable',
    cooldown: 60,
    arm: 'guardian-unreachable',
    busy: undefined
  }
])(
  'preserves the existing $label requeue without a terminal failure report',
  async ({ error, reason, cooldown, arm, busy }) => {
    const now = 1800000000123;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockConsumeProposal.mockRejectedValueOnce(error);
    const stored = await run();
    expect(stored).toMatchObject({
      status: ITransactionStatus.Queued,
      stage: 'creating-proposal',
      lastDeferral: reason
    });
    expect(stored?.nextEligibleAt).toBe(Math.floor(now / 1000) + cooldown);
    expect(stored?.requeueStreak).toEqual({ arm, count: 1 });
    expect(stored?.guardianBusy).toBe(busy);
    expect(stored?.processingStartedAt).toBeUndefined();
    expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
    expect(mockReclaimProposal).not.toHaveBeenCalled();
    expect(mockSignProposal).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    await flush();
    expect(requests).toEqual([]);
  }
);

const failingRead = (call: number, error: Error) =>
  jest.fn(async () => {
    if (++reads === call) throw error;
    return [account];
  });
let reads = 0;

// The routing read sits before the pipeline's own catch, so its rejection leaves generateTransaction for the loop,
// whose cancel reports the same error object.
it('names a failed routing account read as service selection on the error the loop reports', async () => {
  reads = 0;
  const error = privateFailure();
  const getAccounts = failingRead(1, error);
  await expect(run(account, false, { ...provider(), getAccounts })).rejects.toBe(error);
  expect(getAccounts).toHaveBeenCalledTimes(1);
  expect(mockAccountRead).not.toHaveBeenCalled();
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select' });
});

it('reports a failed Guardian preflight account read as service selection before any service exists', async () => {
  reads = 0;
  const error = privateFailure();
  const getAccounts = failingRead(2, error);
  expectTerminal(await run(account, false, { ...provider(), getAccounts }), 'sending');
  expect(getAccounts).toHaveBeenCalledTimes(2);
  expect(mockAccountRead).not.toHaveBeenCalled();
  expect(mockLoad).not.toHaveBeenCalled();
  await failureEvent('service_select', undefined, 'Transaction failed: tx_receive; stage sending; ');
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select' });
});

const structuralRow = (type: 'update-procedure-threshold' | 'replace-hot-key'): ITransaction => ({
  id: 'private-row',
  type,
  accountId,
  status: ITransactionStatus.Queued,
  initiatedAt: Math.floor(Date.now() / 1000),
  displayIcon: 'DEFAULT',
  delegateTransaction: false,
  extraInputs:
    type === 'update-procedure-threshold'
      ? { procedure: 'update_guardian', threshold: 2 }
      : { newHotPublicKey: 'private-new-hot-key' }
});
const structuralAtProposal = 'Transaction failed: tx_guardian; stage signing; signing step creating_proposal; ';

describe.each(['update-procedure-threshold', 'replace-hot-key'] as const)('a %s row', type => {
  const coldAccount: WalletAccount = { ...account, coldPublicKey: 'private-cold-key' };
  async function runStructural(selectedProvider = provider(coldAccount)): Promise<ITransaction | undefined> {
    const transaction = structuralRow(type);
    await Repo.transactions.put(transaction);
    await generateTransaction(transaction, async () => new Uint8Array(), false, selectedProvider);
    return Repo.transactions.get(transaction.id);
  }

  it('reports its cold provider read as service selection', async () => {
    reads = 0;
    const error = privateFailure();
    const getAccounts = failingRead(3, error);
    expectTerminal(await runStructural({ ...provider(coldAccount), getAccounts }));
    expect(mockAccountRead).not.toHaveBeenCalled();
    await failureEvent('service_select', undefined, structuralAtProposal);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_select' });
  });

  it('reports a missing account as the account guard at service selection', async () => {
    reads = 0;
    const getAccounts = jest.fn(async () => (++reads >= 3 ? [] : [coldAccount]));
    expectTerminal(await runStructural({ ...provider(coldAccount), getAccounts }));
    expect(mockAccountRead).not.toHaveBeenCalled();
    await failureEvent('service_select', 'account_not_guardian', structuralAtProposal);
  });

  it('reports a failed or empty SDK account read as the account read', async () => {
    const error = privateFailure();
    mockAccountRead.mockRejectedValueOnce(error);
    expectTerminal(await runStructural());
    expect(mockLoad).not.toHaveBeenCalled();
    await failureEvent('service_account_read', undefined, structuralAtProposal);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_account_read' });
  });

  it('reports a missing SDK account as the account read', async () => {
    mockAccountRead.mockResolvedValueOnce(null);
    expectTerminal(await runStructural());
    expect(mockLoad).not.toHaveBeenCalled();
    await failureEvent('service_account_read', undefined, structuralAtProposal);
  });

  it('reports a failed cold service build as the service load', async () => {
    const error = privateFailure();
    mockLoad.mockRejectedValueOnce(error);
    expectTerminal(await runStructural());
    await failureEvent('service_load', undefined, structuralAtProposal);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
  });
});

it('reports a failed cold service load for a claim that funds the everyday key rotation', async () => {
  const error = privateFailure();
  mockLoad.mockRejectedValueOnce(error);
  jest.spyOn(nativeAsset, 'getNativeAssetId').mockResolvedValue(faucetId);
  mockConsumableNotes.mockResolvedValueOnce([{ noteId, assets: [{ faucetId }], standardPayment: true }]);
  const rotating: WalletAccount = {
    ...account,
    hotPublicKey: undefined,
    requiresHotKeyRotation: true,
    coldPublicKey: 'private-cold-key'
  };
  const transaction: ITransaction = { ...row(), rotationFunding: true };
  await Repo.transactions.put(transaction);
  await generateTransaction(transaction, async () => new Uint8Array(), false, provider(rotating));
  expectTerminal(await Repo.transactions.get(transaction.id));
  await failureEvent('service_load');
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
});

const consumeAtSending = 'Transaction failed: tx_receive; stage sending; ';
const consumeAfterSync = 'Transaction failed: tx_receive; stage confirming; confirming step guardian_synced; ';

it('reports the guardian sync guard as a refusal at service selection before any proposal', async () => {
  const stored = await run({ ...account, guardianSyncStatus: 'resolving' });
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'sending' });
  expect(mockLoad).not.toHaveBeenCalled();
  expect(mockConsumeProposal).not.toHaveBeenCalled();
  await failureEventWith({ proposalStep: 'service_select', proposalGuard: 'guardian_out_of_sync' }, consumeAtSending);
});

it('reports a failed pipeline client build after the co-sign as the client build', async () => {
  const error = privateFailure();
  mockState.clientBuild = error;
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'sending' });
  expect(mockSignProposal).toHaveBeenCalledTimes(1);
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  await failureEventWith({ proposalStep: 'client_build', proposalGuard: undefined }, consumeAtSending);
  expect(snapshotCrashDiagnostics(error)).toMatchObject({
    proposalStep: 'client_build',
    executionRoute: 'guardian_signed_request',
    authObservation: 'not_reached',
    authArgPresence: 'unavailable'
  });
});

describe('with the offscreen pipeline', () => {
  beforeEach(() => {
    process.env.MIDEN_USE_OFFSCREEN_CLIENT = 'true';
  });

  it('reports a request that cannot be packed for the pipeline as the submit serialization', async () => {
    const error = privateFailure();
    mockState.requestSerialize = error;
    const stored = await run();
    expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'sending' });
    expect(stored?.mayHaveSubmitted).toBeUndefined();
    expect(mockSubmit).not.toHaveBeenCalled();
    await failureEventWith({ proposalStep: 'submit_serialize', proposalGuard: undefined }, consumeAtSending);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'submit_serialize' });
  });

  it('reports a failed crossing pin as the submit pin', async () => {
    const error = privateFailure();
    const rejectPin = (changes: unknown) => {
      if (typeof changes === 'object' && changes !== null && 'mayHaveSubmitted' in changes) throw error;
    };
    Repo.transactions.hook('updating', rejectPin);
    try {
      const stored = await run(account, true);
      expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'sending' });
      expect(mockSubmit).not.toHaveBeenCalled();
      await failureEventWith({ proposalStep: 'submit_pin', proposalGuard: undefined }, consumeAtSending);
    } finally {
      Repo.transactions.hook('updating').unsubscribe(rejectPin);
    }
  });
});

describe('a claim that fails while recording its result after the guardian sync', () => {
  function expectSubmittedOnce(stored: ITransaction | undefined): void {
    expect(stored?.status).not.toBe(ITransactionStatus.Completed);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  }

  it.each([
    ['result_read', () => (mockState.resultRead = privateFailure())],
    ['result_serialize', () => (mockState.resultSerialize = privateFailure())]
  ])('reports a failed %s as the finishing step', async (step, arm) => {
    const error = arm();
    expectSubmittedOnce(await run());
    await failureEventWith({ completionStep: step, completionGuard: undefined }, consumeAfterSync);
    expect(snapshotCrashDiagnostics(error)).toMatchObject({ completionStep: step });
  });

  it.each([
    ['no_input_notes', () => (mockState.noInputNotes = true)],
    ['no_fungible_assets', () => (mockState.noAssets = true)]
  ])('reports the %s check as a refusal while reading the result', async (guard, arm) => {
    arm();
    const stored = await run();
    expect(stored?.status).not.toBe(ITransactionStatus.Completed);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    await failureEventWith({ completionStep: 'result_read', completionGuard: guard }, consumeAfterSync);
  });

  it('reports a failed read of its own record as the row read', async () => {
    const error = privateFailure();
    let synced = false;
    let thrown = false;
    const markSynced = (changes: unknown) => {
      if (typeof changes === 'object' && changes !== null && Reflect.get(changes, 'stage') === 'guardian-synced')
        synced = true;
    };
    const rejectRead = (record: unknown) => {
      if (synced && !thrown) {
        thrown = true;
        throw error;
      }
      return record;
    };
    Repo.transactions.hook('updating', markSynced);
    Repo.transactions.hook('reading', rejectRead);
    try {
      expectSubmittedOnce(await run());
      expect(thrown).toBe(true);
      await failureEventWith({ completionStep: 'row_read', completionGuard: undefined }, consumeAfterSync);
    } finally {
      Repo.transactions.hook('updating').unsubscribe(markSynced);
      Repo.transactions.hook('reading').unsubscribe(rejectRead);
    }
  });

  it('reports a failed completed-status write as the status write', async () => {
    const error = privateFailure();
    let thrown = false;
    const rejectComplete = (changes: unknown) => {
      if (
        !thrown &&
        typeof changes === 'object' &&
        changes !== null &&
        Reflect.get(changes, 'status') === ITransactionStatus.Completed
      ) {
        thrown = true;
        throw error;
      }
    };
    Repo.transactions.hook('updating', rejectComplete);
    try {
      expectSubmittedOnce(await run());
      expect(thrown).toBe(true);
      await failureEventWith({ completionStep: 'status_write', completionGuard: undefined }, consumeAfterSync);
    } finally {
      Repo.transactions.hook('updating').unsubscribe(rejectComplete);
    }
  });
});

it.each(['proposal_sign', 'custom_advice', 'custom_request_build', 'proposal_request'])(
  'post-create %s reaches actual cancellation and the sanitized wire with the original error',
  async step => {
    const error = privateFailure();
    const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
    if (step === 'proposal_sign') mockSignProposal.mockRejectedValueOnce(error);
    if (step === 'proposal_request') mockState.proposalRequest = error;
    const custom = step === 'custom_advice' || step === 'custom_request_build';
    if (custom) mockSignProposal.mockResolvedValueOnce({ metadata: { proposalType: 'custom' } });
    if (step === 'custom_advice') mockState.customAdvice = error;
    if (step === 'custom_request_build') mockState.customBuild = error;
    const stored = await run(account, custom);
    expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'signing-proposal' });
    expectHookRejection(report, error);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
    await failureEventWith({ proposalStep: step }, 'signing step signing_proposal');
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: step });
  }
);

it('observes the actual inline Guardian request through cancellation and the real sanitized wire', async () => {
  const original = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  mockExecute.mockRejectedValueOnce(original);
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'executing' });
  expectHookRejection(report, original);
  expect(mockExecute).toHaveBeenCalledTimes(1);
  expect(mockSubmit).not.toHaveBeenCalled();
  await failureEventWith(
    {
      executionRoute: 'guardian_signed_request',
      executionObservation: 'observed',
      executionArguments: 'absent',
      executionLayout: 'absent',
      commitmentMatch: 'unavailable',
      accountCodeFamily: 'unavailable'
    },
    'authentication preparation unavailable; layout absent; commitment match unavailable; account code unavailable'
  );
});

it('retains a typed post-create Guardian refusal through actual cancellation without sending its text', async () => {
  const original = Object.assign(privateFailure(), { name: 'GuardianHttpError', status: 400, code: 'invalid_input' });
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  mockSignProposal.mockRejectedValueOnce(original);
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'signing-proposal' });
  expectHookRejection(report, original);
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  await failureEventWith({ proposalStep: 'proposal_sign' }, 'guardian_http_400; guardian code invalid_input');
});

it('post-create sign_lock reaches actual cancellation and the real sanitized wire', async () => {
  const original = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  mockConsumeProposal.mockImplementationOnce(async () => {
    mockState.signLock = original;
    return { id: 'private-proposal-id', nonce: 7, metadata: { proposalType: 'consume' } };
  });
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'signing-proposal' });
  expectHookRejection(report, original);
  expect(mockSignProposal).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockSubmit).not.toHaveBeenCalled();
  await failureEventWith({ proposalStep: 'sign_lock' }, 'signing step signing_proposal');
  expect(snapshotCrashDiagnostics(original)).toEqual({ proposalStep: 'sign_lock' });
});

jest.mock('../recovery/checkpoint', () => ({
  checkpointTransactionRecovery: jest.fn(async (_id: string, capture: unknown) => {
    jest.requireActual<typeof import('../recovery/capture')>('../recovery/capture').decodeRecoveryCapture(capture);
    jest.requireActual<typeof import('../storage-health')>('../storage-health').assertStorageHealthy();
  })
}));
it.each(['extension', 'mobile'])(
  'carries only the observed consume family through final serialization for %s',
  async platform => {
    const { isMobile, isExtension } = jest.requireMock('lib/platform');
    isMobile.mockReturnValue(platform === 'mobile');
    isExtension.mockReturnValue(platform === 'extension');
    const error = Object.assign(privateFailure(), {
      name: 'ConsumeNoteNotAuthenticatedError',
      code: 'consume_notes_note_not_authenticated'
    });
    mockConsumeProposal.mockRejectedValueOnce(error);
    expectTerminal(await run());
    expect(mockConsumeProposal).toHaveBeenCalledTimes(1);
    await failureEventWith(
      {
        proposalStep: 'proposal_create',
        proposalCreateApi: 'consume_notes',
        proposalCreateFamily: 'consume_note_not_verified'
      },
      'stage signing'
    );
    expect(snapshotCrashDiagnostics(new Error('wrapper', { cause: error }))).not.toHaveProperty('proposalCreateFamily');
    isMobile.mockReturnValue(false);
    isExtension.mockReturnValue(true);
  }
);

it.each(['local_prover_build', 'prove_local', 'proof_evidence'] as const)(
  'observes only the escaping inline %s boundary',
  async step => {
    const error = privateFailure();
    const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
    const prove = jest.fn(async () => {
      throw error;
    });
    if (step === 'local_prover_build')
      jest.spyOn(TransactionProver, 'newLocalProver').mockImplementationOnce(() => {
        throw error;
      });
    else if (step === 'prove_local') mockExecute.mockResolvedValueOnce({ result, prove });
    else
      mockExecute.mockResolvedValueOnce({
        get result(): typeof result {
          throw error;
        },
        prove: async () => ({
          proof: {
            nullifiers: () => [],
            refBlockNumber: () => 100,
            refBlockCommitment: () => accountRef('private'),
            expirationBlockNumber: () => 120
          },
          submit: () => mockSubmit()
        })
      });
    expect(await run()).toMatchObject({ status: ITransactionStatus.Failed, stage: 'proving' });
    expectHookRejection(report, error);
    expect(snapshotCrashDiagnostics(error)).toHaveProperty('guardianProvingSubstep', step);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSubmit).not.toHaveBeenCalled();
    await failureEventWith({ guardianProvingSubstep: step }, 'stage');
  }
);

it('does not promote a swallowed proof accessor failure to terminal proving evidence', async () => {
  const getter = jest.fn(() => {
    throw privateFailure();
  });
  mockExecute.mockResolvedValueOnce({
    result,
    prove: async () => ({
      proof: {
        nullifiers: getter,
        refBlockNumber: () => 100,
        refBlockCommitment: () => accountRef('private'),
        expirationBlockNumber: () => 120
      },
      submit: () => mockSubmit()
    })
  });
  const stored = await run();
  expect(stored?.status).toBe(ITransactionStatus.Completed);
  expect(getter).toHaveBeenCalledTimes(1);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(0);
});

it('leaves a telemetry throw unobserved even when it reuses an earlier prove error', async () => {
  const error = privateFailure();
  const { annotateGuardianProving } = await import('lib/telemetry/guardian-proving-diagnostics');
  annotateGuardianProving(error, { guardianProvingSubstep: 'prove_local' });
  const telemetry = jest.requireMock('lib/telemetry/report-operation');
  telemetry.reportProve.mockImplementationOnce(() => {
    throw error;
  });
  expect(await run()).toMatchObject({ status: ITransactionStatus.Failed, stage: 'proving' });
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('guardianProvingSubstep');
  expect(mockSubmit).not.toHaveBeenCalled();
});

it('observes a fallback constructor rejection without changing delegated calls', async () => {
  const error = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  const prove = jest.fn(async () => {
    throw new Error('remote rejection');
  });
  mockExecute.mockResolvedValueOnce({ result, prove });
  jest.spyOn(TransactionProver, 'newLocalProver').mockImplementationOnce(() => {
    throw error;
  });
  const transaction = { ...row(), delegateTransaction: true };
  await Repo.transactions.put(transaction);
  await generateTransaction(transaction, async () => new Uint8Array(), false, provider(account));
  expect(report).not.toHaveBeenCalled();
  expect(prove).toHaveBeenCalledTimes(1);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('guardianProvingSubstep', 'fallback_prover_build');
  expect((await Repo.transactions.get(transaction.id))?.status).toBe(ITransactionStatus.Queued);
});

it('reports the reliable submitting precondition rejection as its own boundary', async () => {
  const error = privateFailure();
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  const rejectCrossing = (changes: unknown) => {
    if (
      typeof changes === 'object' &&
      changes !== null &&
      Object.keys(changes).some(key => key === 'submitEvidence' || key.startsWith('submitEvidence.'))
    )
      throw error;
  };
  Repo.transactions.hook('updating', rejectCrossing);
  try {
    await run();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(snapshotCrashDiagnostics(report.mock.calls[0]?.[0].error)).toHaveProperty(
      'guardianProvingSubstep',
      'submitting_stage_write'
    );
    await failureEventWith({ guardianProvingSubstep: 'submitting_stage_write' }, 'stage');
  } finally {
    Repo.transactions.hook('updating').unsubscribe(rejectCrossing);
  }
});

it('sends the next actual consume family after the same root previously failed signing', async () => {
  const error = new Error('failed to get account: ' + accountId);
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  mockSignProposal.mockRejectedValueOnce(error);
  await run();
  await flush();
  expect(snapshotCrashDiagnostics(error)).toHaveProperty('proposalStep', 'proposal_sign');
  requests.length = 0;
  report.mockClear();
  mockConsumeProposal.mockRejectedValueOnce(error);
  const stored = await run();
  expect(stored).toMatchObject({ status: ITransactionStatus.Failed, stage: 'creating-proposal' });
  expectHookRejection(report, error);
  expect(mockConsumeProposal).toHaveBeenCalledTimes(2);
  expect(mockSignProposal).toHaveBeenCalledTimes(1);
  await failureEventWith(
    { proposalStep: 'proposal_create', proposalCreateApi: 'consume_notes', proposalCreateFamily: 'sdk_account_read' },
    'stage signing'
  );
});

it('preserves an undefined execute rejection without manufacturing a proving error', async () => {
  const report = jest.spyOn(transactionFailure, 'reportTransactionFailure');
  mockExecute.mockRejectedValueOnce(undefined);
  await run();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0].error).toBeUndefined();
  expect(mockExecute).toHaveBeenCalledTimes(1);
  expect(mockSubmit).not.toHaveBeenCalled();
  await failureEventWith({ guardianProvingSubstep: undefined }, 'stage');
});

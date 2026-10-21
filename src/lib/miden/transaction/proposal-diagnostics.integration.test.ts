import { NoteType } from '@miden-sdk/miden-sdk/lazy';

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
const mockSignProposal = jest.fn(async (..._args: unknown[]) => ({ metadata: { proposalType: 'consume' } }));
const mockSubmit = jest.fn(async () => ({ apply: async () => {} }));
const executedNote = {
  id: () => accountRef(noteId),
  metadata: () => ({ sender: () => accountRef('private-sender'), noteType: () => NoteType.Public }),
  assets: () => ({ fungibleAssets: () => [{ faucetId: () => accountRef(faucetId), amount: () => 987654321n }] })
};
const header = () => ({ to_commitment: () => accountRef(`0x${'de'.repeat(32)}`), nonce: () => ({ asInt: () => 1n }) });
const result = {
  executedTransaction: () => ({
    id: () => accountRef(transactionId),
    accountId: () => accountRef(accountId),
    initialAccountHeader: header,
    finalAccountHeader: header,
    inputNotes: () => ({ notes: () => [{ note: () => executedNote }] }),
    outputNotes: () => ({ notes: () => [] }),
    userOutputNotes: () => []
  }),
  serialize: () => new Uint8Array([5, 6])
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
  abandonCandidate: (...args: unknown[]) => mockAbandon(...args),
  createTransactionProposalRequest: async () => ({ serialize: () => new Uint8Array([7, 8]) }),
  syncState: async () => {}
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  TransactionProver: { newLocalProver: () => ({}) }
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
  getMidenClient: async () => ({
    getAccount: (...args: unknown[]) => mockAccountRead(...args),
    client: {
      syncChain: async () => {},
      transactions: { executeRequest: (...args: unknown[]) => mockExecute(...args) }
    }
  }),
  withWasmClientLock: async <T>(body: (held: object) => Promise<T>) => body(hold),
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
jest.mock('../guardian/tip-execution', () => ({ prepareGuardianTipExecution: async () => {} }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: async () => {},
  notifyBackgroundTransactionNotConfirmed: async () => {}
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: () => {}, reportProve: () => {} }));
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
  isMobile: () => false,
  isExtension: () => true
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
  'claim fee admission unrecorded; point pipeline; unknown; thrown error. authentication';
async function failureEvent(step: string, guard?: string, message = consumeAtProposal): Promise<void> {
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
  expect(diagnostics).toMatchObject({ proposalStep: step });
  expect(diagnostics.proposalGuard).toBe(guard);
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
  expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'proposal_create' });
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

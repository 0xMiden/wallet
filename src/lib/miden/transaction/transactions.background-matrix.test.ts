/**
 * An app that leaves the foreground at each stage of a Guardian attempt (#2060). The row, the WASM lock, both background
 * clocks, the verdict and Retry are the real ones; the node, the Guardian, the prover and the SDK client are stand-ins
 * holding one chain under the rules the report turned on: a 20-block proof window and the node's refusal of a proof
 * within two blocks of expiry.
 *
 * An app switch and a screen lock reach this code the same way, as a hidden document, so a cell stands for both. They
 * differ in one place, and those cells say so: a hot key minted before keys could sign on a locked device.
 */
import { clearGuardianAccountLocks } from 'lib/miden/guardian/serialize';
import * as Repo from 'lib/miden/repo';
import { bindFeeFaucetClientScope } from 'lib/miden/sdk/sync-and-record-fee-faucet';
import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';
import { WalletType } from 'screens/onboarding/types';

import { getCompletedTransactions, getUncompletedTransactions } from './get';
import { generateTransactionsLoop, requeueFailedTransaction } from './index';
import type { NodeReads } from './reconcile-reads';
import { reconcileUnconfirmedTransactions } from './reconcile-unconfirmed';
import { acknowledgementOf, type RetryOptions } from './retry';
import { isGuardianHoldRetryError } from './retry-refusal';
import { GUARDIAN_PENDING_HOLD_SEC } from './verdict-rules';
import { ITransaction, ITransactionStatus, SendTransaction } from '../db/types';

jest.mock('shared/logger', () => ({ logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('lib/telemetry/crash', () => ({
  ...jest.requireActual('lib/telemetry/crash'),
  captureCrash: jest.fn(),
  captureDiagnosticLog: jest.fn()
}));
jest.mock('lib/intercom', () => ({ getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() }) }));
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));
jest.mock('../front', () => ({
  putToStorage: jest.fn(async () => {}),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));
jest.mock('lib/miden/front/storage', () => ({
  ...jest.requireActual('lib/miden/front/storage'),
  fetchFromStorage: async () => undefined
}));
jest.mock('lib/settings/constants', () => ({}));
jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => 'fixture-rpc|testnet',
  captureNativeAssetSnapshot: (scope: string) => ({ scope, revision: 0 }),
  recordSyncedFeeFaucetId: jest.fn(async () => true),
  getNativeAssetId: jest.fn(async () => '0xfee0000000000000000000000000000000'),
  getNativeAssetIdSync: jest.fn(() => '0xfee0000000000000000000000000000000'),
  getVerificationBaseFee: jest.fn(async () => 10000),
  getVerificationBaseFeeSync: jest.fn(() => null)
}));
jest.mock('lib/miden/assets/faucet-id-setting', () => ({
  getFaucetIdSetting: async () => '0xfee0000000000000000000000000000000'
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  accountRefToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  walletAccountIdToSdk: (id: string) => ({ toString: () => `sdk-${id}` }),
  canonicalWalletAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
  TransactionProver: {
    newLocalProver: jest.fn(() => 'local-prover'),
    newCallbackProver: jest.fn(() => 'callback-prover')
  }
}));
jest.mock('../sdk/native-prover-mobile', () => ({
  buildNativeProverCallback: jest.fn(() => async () => new Uint8Array())
}));
// A constant: `cancel.ts` asks at import, ahead of anything a test could set. `isExtension` stays jsdom's true, which
// arms no requeue wake, so the laps here stand in for the page's interval.
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: () => true }));

const mockService = jest.fn();
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: async () => true,
  getOrCreateMultisigService: () => mockService(),
  clearGuardianServiceFor: jest.fn()
}));
jest.mock('lib/miden/guardian', () => {
  const actual = jest.requireActual<typeof import('lib/miden/guardian')>('lib/miden/guardian');
  return {
    GUARDIAN_CANDIDATE_HOLD_MS: actual.GUARDIAN_CANDIDATE_HOLD_MS,
    PRIOR_CANDIDATE_CHECK_TIMEOUT_MS: actual.PRIOR_CANDIDATE_CHECK_TIMEOUT_MS,
    ProposalChainSyncError: actual.ProposalChainSyncError,
    isProposalChainSyncError: actual.isProposalChainSyncError,
    MultisigService: { buildColdMultisigService: jest.fn() }
  };
});

const mockClient = jest.fn();
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  ...jest.requireActual('../sdk/miden-client'),
  getMidenClient: async () => mockClient()
}));
const mockReadChainTip = jest.fn();
jest.mock('lib/miden/sdk/pswap-order-note', () => jest.requireMock('../sdk/pswap-order-note'));
jest.mock('../sdk/pswap-order-note', () => ({
  ...jest.requireActual('../sdk/pswap-order-note'),
  readChainTip: () => mockReadChainTip()
}));
const mockNodeReads: NodeReads = {
  blockCommitment: async block => hex(block),
  account: async (_accountId, atBlock) => {
    const blockNum = atBlock ?? chainTip();
    return { ok: true, state: { blockNum, commitment: commitmentAt(blockNum) } };
  },
  noteInclusions: async () => new Map(),
  nullifierHeight: async () => null
};
jest.mock('./reconcile-reads', () => ({
  ...jest.requireActual('./reconcile-reads'),
  createNodeReads: async () => mockNodeReads
}));

const TX = 'tx-1';
const ACCOUNT = 'guardian-acc';
const OPENING_BALANCE = 5_000;
const AMOUNT = 1_000;
const AWAY_MS = 80_000;
const HOLD_MS = GUARDIAN_PENDING_HOLD_SEC * 1000;
const BLOCK_MS = 3_000;
const OPENING_HEIGHT = 1_000;
const FEE_POLICY_WINDOW_BLOCKS = 20;
const NODE_ADMISSION_SLACK_BLOCKS = 2;
const OPENING_COMMITMENT = hex(1);
const EXPIRED_REFUSAL =
  'failed to submit proven transaction: RPC error: grpc request failed for submit_proven_transaction: ' +
  "invalid request parameters (transaction expired): status: 'invalid request parameters (transaction expired)'";
const LOST_ANSWER = `submission of transaction ${hex(2)} came back without a definite outcome, so the node may or may not have accepted it; nothing was recorded locally`;
const DEVICE_LOCKED = Object.assign(new Error('Hot key not accessible while device is locked'), {
  code: 'DEVICE_LOCKED'
});

function hex(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

type Stage = 'proposal' | 'co-sign' | 'executing' | 'proving' | 'submitting';
/** What happens while a stage's call is in flight, once. At 'submitting', `post` is the request reaching the node. */
type Scene = (post: () => void) => void;

interface Execution {
  transactionId: string;
  refBlock: number;
  expirationBlock: number;
  initialCommitment: string;
  finalCommitment: string;
  balanceWhenExecuted: number;
}

let doc: HiddenDocument;
let scenes: Partial<Record<Stage, Scene>>;
let openedAtMs: number;
let syncedHeight: number;
let executions: Execution[];
/** The attempt behind each submit the node received. */
let posts: (string | undefined)[];
let landings: { transactionId: string; block: number; finalCommitment: string }[];
/** The wallet's local store: only an apply writes it. */
let vault: { balance: number; applied: string[] };

const chainTip = (): number => OPENING_HEIGHT + Math.floor((Date.now() - openedAtMs) / BLOCK_MS);

const commitmentAt = (block: number): string =>
  landings.filter(landing => landing.block <= block).at(-1)?.finalCommitment ?? OPENING_COMMITMENT;

const row = async (): Promise<ITransaction> => (await Repo.transactions.where({ id: TX }).first())!;

const play = (stage: Stage, post: () => void = () => {}): void => {
  const scene = scenes[stage] ?? (() => post());
  delete scenes[stage];
  scene(post);
};

const goAway = (ms: number = AWAY_MS): void => {
  doc.setHidden(true);
  doc.freezeFor(ms);
  doc.setHidden(false);
};

const away: Scene = () => goAway();
const awayThenFails =
  (error: Error): Scene =>
  () => {
    goAway();
    throw error;
  };

const admit = (execution: Execution, attemptId: string | undefined): void => {
  posts.push(attemptId);
  if (execution.expirationBlock <= chainTip() + NODE_ADMISSION_SLACK_BLOCKS) throw new Error(EXPIRED_REFUSAL);
  landings.push({
    transactionId: execution.transactionId,
    block: chainTip() + 1,
    finalCommitment: execution.finalCommitment
  });
};

const resultOf = (execution: Execution) => {
  const header = (commitment: string, nonce: bigint) => ({
    to_commitment: () => ({ toHex: () => commitment }),
    nonce: () => ({ asInt: () => nonce })
  });
  const executed = {
    id: () => ({ toHex: () => execution.transactionId }),
    accountId: () => ACCOUNT,
    initialAccountHeader: () => header(execution.initialCommitment, 5n),
    finalAccountHeader: () => header(execution.finalCommitment, 6n),
    userOutputNotes: () => [],
    outputNotes: () => ({ notes: () => [] }),
    inputNotes: () => ({ notes: () => [] })
  };
  return { executedTransaction: () => executed, serialize: () => new Uint8Array([9]) };
};

const proofOf = (execution: Execution) => ({
  nullifiers: () => [],
  refBlockNumber: () => execution.refBlock,
  refBlockCommitment: () => ({ toHex: () => hex(execution.refBlock) }),
  expirationBlockNumber: () => execution.expirationBlock
});

const client = {
  transactions: {
    executeRequest: async () => {
      const ordinal = executions.length;
      const execution: Execution = {
        transactionId: hex(0x1000 + ordinal),
        refBlock: syncedHeight,
        expirationBlock: syncedHeight + FEE_POLICY_WINDOW_BLOCKS,
        initialCommitment: commitmentAt(chainTip()),
        finalCommitment: hex(0x2000 + ordinal),
        balanceWhenExecuted: vault.balance
      };
      executions.push(execution);
      play('executing');
      const result = resultOf(execution);
      return {
        id: result.executedTransaction().id(),
        result,
        prove: async () => {
          play('proving');
          return {
            proof: proofOf(execution),
            result,
            submit: async () => {
              const { attemptId } = await row();
              play('submitting', () => admit(execution, attemptId));
              return {
                blockNumber: chainTip(),
                result,
                apply: async () => {
                  vault.applied.push(execution.transactionId);
                  vault.balance -= AMOUNT;
                }
              };
            }
          };
        }
      };
    }
  },
  syncChain: async () => {
    syncedHeight = chainTip();
  },
  getSyncHeight: async () => syncedHeight,
  feeFaucetId: async () => ({ toString: () => '0xfee0000000000000000000000000000000' })
};
bindFeeFaucetClientScope(client as never, 'fixture-rpc|testnet');

const service = {
  guardianEndpoint: 'https://guardian.test',
  createSendProposal: async () => {
    play('proposal');
    return { id: 'proposal', nonce: 5 };
  },
  signAndCreateTransactionRequest: async () => {
    play('co-sign');
    return { serialize: () => new Uint8Array([1]), authArg: () => undefined };
  },
  abandonCandidate: async () => {},
  // The Guardian has let go of any candidate by the next proposal: what a held row waits for is the hold.
  priorCandidateState: async () => 'settled',
  sync: async () => {}
};

const provider = {
  getAccounts: async () => [
    {
      publicKey: ACCOUNT,
      name: 'Guardian account',
      isPublic: true,
      type: WalletType.Guardian,
      hdIndex: 0,
      authScheme: 'ecdsa' as const,
      guardianEndpoint: service.guardianEndpoint
    }
  ],
  getPublicKeyForCommitment: async () => 'pk',
  signWord: async () => 'sig'
};

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Run the queue until the row stops coming back, waiting out a requeue's cooldown in the foreground. */
const runQueue = async (): Promise<void> => {
  for (let lap = 0; lap < 8; lap += 1) {
    await generateTransactionsLoop(
      jest.fn(async () => new Uint8Array([2])),
      false,
      provider as never
    );
    const { status, nextEligibleAt } = await row();
    if (status !== ITransactionStatus.Queued) return;
    await jest.advanceTimersByTimeAsync(Math.max(0, (nextEligibleAt ?? 0) - nowSec() + 1) * 1000);
  }
  throw new Error('the row was still queued after every lap');
};

const send = async (): Promise<void> => {
  await Repo.transactions.add({
    id: TX,
    type: 'send',
    accountId: ACCOUNT,
    secondaryAccountId: 'recipient',
    faucetId: 'faucet',
    amount: BigInt(AMOUNT),
    noteType: 'public',
    status: ITransactionStatus.Queued,
    initiatedAt: nowSec(),
    delegateTransaction: true,
    displayIcon: 'SEND',
    extraInputs: {}
  } as SendTransaction);
  await runQueue();
};

const tapRetry = async (options?: RetryOptions): Promise<unknown> => {
  const refusal = await requeueFailedTransaction(TX, options).then(
    () => undefined,
    (error: unknown) => error
  );
  await runQueue();
  return refusal;
};

/** The sync tick's verdict pass, on a schedule of its own so the pass is due at once. */
const reconcile = (): Promise<void> => {
  const data: Record<string, unknown> = {};
  return reconcileUnconfirmedTransactions({
    storage: {
      get: async () => data,
      set: async items => void Object.assign(data, items),
      remove: async () => {}
    }
  });
};

const expectEveryAttemptPostedOnce = (): void => expect(new Set(posts).size).toBe(posts.length);

/** The cell's closing check: Retry, tapped twice, adds no landing to the `landed` the chain already has. */
const expectRetryAddsNoLanding = async (landed = 1): Promise<void> => {
  await tapRetry();
  await tapRetry();
  expect(landings).toHaveLength(landed);
  expectEveryAttemptPostedOnce();
};

const activityRows = async (): Promise<ITransaction[]> => [
  ...(await getUncompletedTransactions(ACCOUNT)),
  ...(await getCompletedTransactions(ACCOUNT, undefined, undefined, true))
];

beforeEach(async () => {
  // Dexie needs real task scheduling; these four are what keeps fake-indexeddb running under a fake clock.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  doc = installHiddenDocument();
  initBackgroundTimeTracking();
  scenes = {};
  openedAtMs = Date.now();
  syncedHeight = OPENING_HEIGHT;
  executions = [];
  posts = [];
  landings = [];
  vault = { balance: OPENING_BALANCE, applied: [] };
  mockReadChainTip.mockImplementation(async () => chainTip());
  mockClient.mockReturnValue({ getAccount: async () => undefined, syncState: async () => {}, client });
  mockService.mockResolvedValue(service);
  await Repo.transactions.clear();
});

afterEach(() => {
  __resetBackgroundTimeForTest();
  doc.restore();
  clearGuardianAccountLocks();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

afterAll(() => Repo.db.close());

it('foreground-only control: one execution, one submit, one landing', async () => {
  await send();

  expect((await row()).status).toBe(ITransactionStatus.Completed);
  expect(executions).toHaveLength(1);
  expect(posts).toHaveLength(1);
  await expectRetryAddsNoLanding();
});

describe('hidden about 80 s with the call in flight, an app switch and a screen lock alike', () => {
  it.each<[string, Stage, Scene, number]>([
    ['proposal, which has executed nothing that could go stale', 'proposal', away, 1],
    ['co-sign, which has executed nothing that could go stale', 'co-sign', away, 1],
    ['executing, whose proof comes back stale and is executed again', 'executing', away, 2],
    ['proving, whose proof comes back stale and is executed again', 'proving', away, 2],
    [
      'submitting, where the node took it before the freeze',
      'submitting',
      post => {
        post();
        goAway();
      },
      1
    ]
  ])('%s: Completed, with one submit and one landing', async (_name, stage, scene, executed) => {
    scenes[stage] = scene;

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(executions).toHaveLength(executed);
    expect(posts).toHaveLength(1);
    expect(landings[0]?.transactionId).toBe(executions.at(-1)?.transactionId);
    await expectRetryAddsNoLanding();
  });
});

describe('a network interruption on resume', () => {
  it.each<[string, Stage, Error, number]>([
    ['proposal, requeued while the Guardian is unreachable', 'proposal', new TypeError('Failed to fetch'), 1],
    ['co-sign, requeued while the Guardian is unreachable', 'co-sign', new TypeError('Failed to fetch'), 1],
    ['executing, requeued while the node is unreachable', 'executing', new TypeError('Load failed'), 2],
    ['proving, proved locally and then executed again', 'proving', new TypeError('Load failed'), 2]
  ])('%s: Completed, with one submit and one landing', async (_name, stage, error, executed) => {
    scenes[stage] = awayThenFails(error);

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(executions).toHaveLength(executed);
    expect(posts).toHaveLength(1);
    await expectRetryAddsNoLanding();
  });

  it('submitting, with the node holding it and the answer lost: Not confirmed, then the landing the verdict finds', async () => {
    scenes.submitting = post => {
      post();
      goAway();
      throw new Error(LOST_ANSWER);
    };

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Unconfirmed);
    expect(isGuardianHoldRetryError(await tapRetry())).toBe(true);
    expect(landings).toHaveLength(1);

    await reconcile();

    expect((await row()).status).toBe(ITransactionStatus.Completed);
    await expectRetryAddsNoLanding();
  });

  it('submitting, with the request lost: Not confirmed, then Retry lands it once the hold has cleared', async () => {
    scenes.submitting = () => {
      goAway();
      throw new Error(LOST_ANSWER);
    };

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Unconfirmed);
    expect(isGuardianHoldRetryError(await tapRetry())).toBe(true);
    expect(posts).toHaveLength(0);

    await reconcile();

    expect((await row()).status).toBe(ITransactionStatus.Failed);
    expect(isGuardianHoldRetryError(await tapRetry())).toBe(true);

    goAway(HOLD_MS);

    expect(await tapRetry()).toBeUndefined();
    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(landings).toHaveLength(1);
    await expectRetryAddsNoLanding();
  });

  it('the tip read, which sends the stale proof: the node refuses it and Retry waits for the hold', async () => {
    scenes.executing = away;
    mockReadChainTip.mockRejectedValue(new TypeError('Load failed'));

    await send();

    const { status, submitEvidence } = await row();
    expect(status).toBe(ITransactionStatus.Failed);
    expect(submitEvidence).toEqual([expect.objectContaining({ candidateKept: true })]);
    expect(posts).toHaveLength(1);
    expect(landings).toHaveLength(0);
    expect(isGuardianHoldRetryError(await tapRetry())).toBe(true);

    mockReadChainTip.mockImplementation(async () => chainTip());
    goAway(HOLD_MS);

    expect(await tapRetry()).toBeUndefined();
    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(posts).toHaveLength(2);
    await expectRetryAddsNoLanding();
  });
});

describe('a refused submit and the Guardian hold', () => {
  const postOnResume: Scene = post => {
    goAway();
    post();
  };

  it('returning inside the hold: Retry and Retry anyway are both refused, and nothing is sent', async () => {
    scenes.submitting = postOnResume;

    await send();

    const refused = await row();
    expect(refused.status).toBe(ITransactionStatus.Failed);
    expect(posts).toHaveLength(1);
    expect(isGuardianHoldRetryError(await tapRetry())).toBe(true);
    expect(isGuardianHoldRetryError(await tapRetry({ acknowledged: { attemptId: refused.attemptId ?? null } }))).toBe(
      true
    );
    expect(posts).toHaveLength(1);
    await expectRetryAddsNoLanding(0);
  });

  it('returning after the hold expires: Retry judges the dead proof and lands the send once', async () => {
    scenes.submitting = post => {
      goAway(HOLD_MS);
      post();
    };

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Failed);
    expect(await tapRetry()).toBeUndefined();
    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(posts).toHaveLength(2);
    await expectRetryAddsNoLanding();
  });

  it('returning after the hold expires, with the node holding it and the answer lost: Retry finds the landing', async () => {
    scenes.submitting = post => {
      post();
      goAway(HOLD_MS);
      throw new Error(LOST_ANSWER);
    };

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Unconfirmed);
    expect(await tapRetry()).toBeUndefined();
    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(posts).toHaveLength(1);
    await expectRetryAddsNoLanding();
  });

  it('returning after the hold expires, with the request lost: Retry proves it dead and lands the send once', async () => {
    scenes.submitting = () => {
      goAway(HOLD_MS);
      throw new Error(LOST_ANSWER);
    };

    await send();

    expect((await row()).status).toBe(ITransactionStatus.Unconfirmed);
    expect(await tapRetry()).toBeUndefined();
    expect((await row()).status).toBe(ITransactionStatus.Completed);
    expect(posts).toHaveLength(1);
    await expectRetryAddsNoLanding();
  });
});

describe('a screen lock alone: a hot key from before keys could sign on a locked device', () => {
  it.each<[Stage]>([['co-sign'], ['executing']])(
    '%s: Failed with nothing sent, and Retry anyway after the unlock lands it once',
    async stage => {
      scenes[stage] = awayThenFails(DEVICE_LOCKED);

      await send();

      const { status, attemptId } = await row();
      expect(status).toBe(ITransactionStatus.Failed);
      expect(posts).toHaveLength(0);

      // Nothing durable on a byteless send tells this from a lost reply, so Retry takes the user's word for it.
      expect(acknowledgementOf(await tapRetry())).toEqual({ attemptId });
      expect(posts).toHaveLength(0);

      expect(await tapRetry({ acknowledged: { attemptId: attemptId ?? null } })).toBeUndefined();
      expect((await row()).status).toBe(ITransactionStatus.Completed);
      await expectRetryAddsNoLanding();
    }
  );
});

describe('the balance and Activity until the single landing', () => {
  it('a re-executed attempt moves neither until the one landing, whose apply moves them once', async () => {
    scenes.executing = away;
    let balanceAtSubmit: number | undefined;
    scenes.submitting = post => {
      balanceAtSubmit = vault.balance;
      post();
    };

    await send();

    expect(executions.map(execution => execution.balanceWhenExecuted)).toEqual([OPENING_BALANCE, OPENING_BALANCE]);
    expect(balanceAtSubmit).toBe(OPENING_BALANCE);
    expect(vault).toEqual({ balance: OPENING_BALANCE - AMOUNT, applied: [executions[1]!.transactionId] });
    expect(await activityRows()).toEqual([
      expect.objectContaining({ id: TX, transactionId: executions[1]!.transactionId })
    ]);
    await expectRetryAddsNoLanding();
  });

  it('a refused submit leaves both alone, through the hold, until Retry`s one landing', async () => {
    scenes.submitting = post => {
      goAway();
      post();
    };

    await send();

    expect(vault).toEqual({ balance: OPENING_BALANCE, applied: [] });
    const refused = await activityRows();
    expect(refused).toHaveLength(1);
    expect(refused[0]?.transactionId).toBeUndefined();

    goAway(HOLD_MS);
    await tapRetry();

    expect(vault).toEqual({ balance: OPENING_BALANCE - AMOUNT, applied: [landings[0]?.transactionId] });
    expect(await activityRows()).toEqual([
      expect.objectContaining({ id: TX, transactionId: landings[0]?.transactionId })
    ]);
    await expectRetryAddsNoLanding();
  });
});

import type { Hex } from 'viem';

import { RelayExpiredError, RelayNotSubmittedError, RelayRevertedError } from 'lib/evm-relay/errors';
import { RELAY_FINAL_JOB_RETENTION_SECONDS, type RelayJobCheck } from 'lib/evm-relay/submit';
import type { RelayJobRef } from 'lib/evm-relay/types';

import { BridgeReceiveLockManager, createBridgeReceiveReconciler, reconcileBridgedReceives } from './bridge-receive';
import type { ITransaction } from '../db/types';

const rows: Record<string, unknown>[] = [];
const updatePhase = jest.fn();
const checkJob = jest.fn<Promise<RelayJobCheck>, [RelayJobRef]>();
const findRelaySource = jest.fn();
const buildRelaySubmitter = jest.fn();
const readOutcome = jest.fn();
const fetchDeposits = jest.fn();

jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() =>
      jest
        .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
        .testBridgeSnapshot()
    )
);
jest.mock('lib/miden/repo', () => ({
  transactions: {
    get: async (id: string) => rows.find(row => row.id === id),
    where: jest.fn((index: string) => ({
      equals: (value: string) => ({
        filter: (predicate: (row: Record<string, unknown>) => boolean) => ({
          toArray: async () => rows.filter(row => row[index] === value && predicate(row))
        })
      })
    }))
  }
}));
jest.mock('lib/evm-relay/source', () => ({
  findRelaySource: (...args: unknown[]) => findRelaySource(...args),
  buildRelaySubmitter: (...args: unknown[]) => buildRelaySubmitter(...args)
}));
jest.mock('lib/i18n/core', () => ({ getMessage: (key: string) => `text:${key}` }));
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt'),
  readEvmReceiptOutcome: (...args: unknown[]) => readOutcome(...args)
}));
jest.mock('lib/agglayer/status', () => ({
  ...jest.requireActual('lib/agglayer/status'),
  fetchDeposits: (...args: unknown[]) => fetchDeposits(...args)
}));
jest.mock('lib/epoch/sdk', () => ({ getEpochReadOnlySdk: jest.fn() }));
jest.mock('../transaction/complete', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) => updatePhase(...args)
}));
jest.mock('./bridge-in', () => ({
  BRIDGE_RECEIVE_MAX_AGE_MS: jest.requireActual('./bridge-in').BRIDGE_RECEIVE_MAX_AGE_MS,
  BRIDGE_DELIVERY_TIMED_OUT: jest.requireActual('./bridge-in').BRIDGE_DELIVERY_TIMED_OUT,
  registerPendingBridgeIn: jest.fn(async () => undefined),
  resolveBridgeInNoteId: jest.fn(async () => undefined)
}));

const RELAY_ADDRESS = '0x00000000000000000000000000000000000000aa';
const SOURCE = { accountPublicKey: 'account-key', address: RELAY_ADDRESS };
const SEPOLIA = 11155111;
const BASE_SEPOLIA = 84532;
const JOB: RelayJobRef = { chainId: SEPOLIA, id: `0x${'ab'.repeat(32)}`, deadline: 1_900_000_000 };
const HASH: Hex = `0x${'c1'.repeat(32)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function relayRow(
  provider: 'agglayer' | 'epoch',
  extra: Record<string, unknown> = {},
  row: Partial<ITransaction> = {}
) {
  return {
    id: `${provider}-relayed`,
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: nowSec() - 60,
    ...row,
    extraInputs: {
      provider,
      phase: 'submitting',
      sourceAddress: RELAY_ADDRESS.toUpperCase().replace('0X', '0x'),
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      relayJob: JOB,
      ...extra
    }
  };
}

/** The options that the reconciler passed to its write, with the `canUpdate` guard. */
function guardOf(call: unknown[] | undefined): (row: unknown) => boolean {
  const options: unknown = call?.[4];
  const guard: unknown = options && typeof options === 'object' ? Reflect.get(options, 'canUpdate') : undefined;
  if (typeof guard !== 'function') throw new Error('no canUpdate guard');
  return row => Reflect.apply(guard, undefined, [row]) === true;
}

beforeEach(() => {
  rows.splice(0);
  jest.clearAllMocks();
  updatePhase.mockResolvedValue(undefined);
  findRelaySource.mockReturnValue(SOURCE);
  buildRelaySubmitter.mockImplementation(() => ({ check: checkJob }));
  checkJob.mockResolvedValue({ state: 'pending', hash: HASH });
  readOutcome.mockResolvedValue('pending');
  fetchDeposits.mockResolvedValue([]);
});

describe('an AggLayer row that holds a relay job', () => {
  it('writes the hash of a job that succeeded, in one read and with a guard on the job', async () => {
    rows.push(relayRow('agglayer'));
    checkJob.mockResolvedValue({ state: 'succeeded', hash: HASH });

    await reconcileBridgedReceives();

    expect(findRelaySource).toHaveBeenCalledWith(RELAY_ADDRESS.toUpperCase().replace('0X', '0x'));
    expect(buildRelaySubmitter).toHaveBeenCalledWith(SOURCE, SEPOLIA);
    expect(checkJob).toHaveBeenCalledTimes(1);
    expect(checkJob).toHaveBeenCalledWith(JOB);
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith(
      'agglayer-relayed',
      'submitting',
      { evmTxHash: HASH },
      undefined,
      expect.objectContaining({ canUpdate: expect.any(Function) })
    );
    // The hash path is the next pass's: this pass reads no receipt and no deposit.
    expect(readOutcome).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    const guard = guardOf(updatePhase.mock.calls[0]);
    expect(guard(relayRow('agglayer'))).toBe(true);
    expect(guard(relayRow('agglayer', { evmTxHash: HASH }))).toBe(false);
    expect(guard(relayRow('agglayer', { relayJob: { ...JOB, id: `0x${'cd'.repeat(32)}` } }))).toBe(false);
    expect(guard(relayRow('agglayer', { phase: 'failed' }))).toBe(false);
  });

  it('follows the hash that the pass wrote on the next pass, with no new job read', async () => {
    rows.push(relayRow('agglayer', { evmTxHash: HASH }));
    readOutcome.mockResolvedValue('success');

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(readOutcome).toHaveBeenCalledWith(HASH, expect.objectContaining({ id: SEPOLIA }));
    expect(updatePhase).toHaveBeenCalledWith('agglayer-relayed', 'delivering');
  });

  it.each<[string, RelayJobCheck, string, unknown]>([
    ['reverted', { state: 'reverted', hash: HASH }, 'depositFlowRelayReverted', expect.any(RelayRevertedError)],
    ['expired', { state: 'expired', hash: HASH }, 'depositFlowRelayExpired', expect.any(RelayExpiredError)],
    ['not submitted', { state: 'not-submitted' }, 'depositFlowRelayExpired', expect.any(RelayNotSubmittedError)]
  ])('fails the row of a %s job in the words of the deposit screen', async (_name, checked, key, cause) => {
    rows.push(relayRow('agglayer'));
    checkJob.mockResolvedValue(checked);

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'agglayer-relayed',
      'failed',
      {
        error: `text:${key}`,
        errorId: 'raw_bridge_deposit_failed',
        failure: { step: 'wallet_deposit', cause, requestClient: 'relay' }
      },
      undefined,
      expect.objectContaining({ canUpdate: expect.any(Function) })
    );
  });

  it('names the job and its hash in the cause of a reverted job', async () => {
    rows.push(relayRow('agglayer'));
    checkJob.mockResolvedValue({ state: 'reverted', hash: HASH });

    await reconcileBridgedReceives();

    const extra: unknown = updatePhase.mock.calls[0]?.[2];
    const failure: unknown = extra && typeof extra === 'object' ? Reflect.get(extra, 'failure') : undefined;
    const cause: unknown = failure && typeof failure === 'object' ? Reflect.get(failure, 'cause') : undefined;
    expect(cause).toMatchObject({ id: JOB.id, txHash: HASH });
  });

  it.each<[string, RelayJobCheck]>([
    ['pending', { state: 'pending', hash: HASH }],
    ['unknown', { state: 'unknown', cause: new Error('down') }]
  ])('keeps the row of a %s job as it is', async (_name, checked) => {
    rows.push(relayRow('agglayer'));
    checkJob.mockResolvedValue(checked);

    await reconcileBridgedReceives();

    expect(checkJob).toHaveBeenCalledTimes(1);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('does not trust not-submitted once the relay can have deleted the final job', async () => {
    rows.push(relayRow('agglayer', {}, { initiatedAt: nowSec() - RELAY_FINAL_JOB_RETENTION_SECONDS }));
    checkJob.mockResolvedValue({ state: 'not-submitted' });

    await reconcileBridgedReceives();

    expect(checkJob).toHaveBeenCalledTimes(1);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('trusts not-submitted a few seconds before the relay can have deleted the final job', async () => {
    rows.push(relayRow('agglayer', {}, { initiatedAt: nowSec() - RELAY_FINAL_JOB_RETENTION_SECONDS + 5 }));
    checkJob.mockResolvedValue({ state: 'not-submitted' });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'agglayer-relayed',
      'failed',
      expect.objectContaining({ error: 'text:depositFlowRelayExpired' }),
      undefined,
      expect.anything()
    );
  });

  it('times out a row past its delivery window with no job read', async () => {
    rows.push(relayRow('agglayer', {}, { initiatedAt: nowSec() - 8 * 24 * 60 * 60 }));

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith(
      'agglayer-relayed',
      'failed',
      expect.objectContaining({ failure: { step: 'delivery_timed_out' } })
    );
  });

  it('reads the job once in each pass', async () => {
    rows.push(relayRow('agglayer'));

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(checkJob).toHaveBeenCalledTimes(2);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('never reads the job of a row restored from a backup', async () => {
    rows.push(relayRow('agglayer', {}, { restoredFromBackup: true }));

    await reconcileBridgedReceives();

    expect(findRelaySource).not.toHaveBeenCalled();
    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('agglayer-relayed', 'failed', {
      error: expect.stringContaining('Restored')
    });
  });

  it('reads no job when the source is not a relay address of this wallet', async () => {
    rows.push(relayRow('agglayer'));
    findRelaySource.mockReturnValue(null);

    await reconcileBridgedReceives();

    expect(buildRelaySubmitter).not.toHaveBeenCalled();
    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('reads no job for another chain than the row', async () => {
    rows.push(relayRow('agglayer', { sourceChainId: BASE_SEPOLIA }));

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('keeps the row when the relay does not serve the chain or the reference is not valid', async () => {
    rows.push(relayRow('agglayer'));
    buildRelaySubmitter.mockImplementation(() => {
      throw new Error('not served');
    });

    await reconcileBridgedReceives();
    checkJob.mockRejectedValue(new TypeError('bad reference'));
    buildRelaySubmitter.mockImplementation(() => ({ check: checkJob }));
    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('reads no job while a deposit flow holds the submission lock', async () => {
    rows.push(relayRow('agglayer'));
    const busy: BridgeReceiveLockManager = { request: async (_name, _options, callback) => callback(null) };

    await createBridgeReceiveReconciler({ getLocks: () => busy }).reconcile();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('reads no job of a row that is no longer submitting', async () => {
    rows.push(relayRow('agglayer', { phase: 'delivering' }));

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });
});

describe('an Epoch row that holds a relay job', () => {
  it('keeps the row of a job whose outcome is not known yet', async () => {
    rows.push(relayRow('epoch', { sourceChainId: SEPOLIA }));
    checkJob.mockResolvedValue({ state: 'unknown', cause: new Error('down') });

    await reconcileBridgedReceives();

    expect(buildRelaySubmitter).toHaveBeenCalledWith(SOURCE, SEPOLIA);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('fails the row of a reverted job in the words of the deposit screen', async () => {
    rows.push(relayRow('epoch'));
    checkJob.mockResolvedValue({ state: 'reverted', hash: HASH });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'epoch-relayed',
      'failed',
      expect.objectContaining({ error: 'text:depositFlowRelayReverted', errorId: 'raw_bridge_deposit_failed' }),
      undefined,
      expect.objectContaining({ canUpdate: expect.any(Function) })
    );
  });

  it('fails the row of a job that succeeded as interrupted before an intent', async () => {
    rows.push(relayRow('epoch'));
    checkJob.mockResolvedValue({ state: 'succeeded', hash: HASH });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'epoch-relayed',
      'failed',
      {
        error: 'Bridge submission was interrupted before an intent was recorded.',
        failure: { step: 'submission_interrupted', orphanCheck: 'realm_idle' }
      },
      undefined,
      expect.objectContaining({ canUpdate: expect.any(Function) })
    );
  });

  it('reads no job for another chain than the row', async () => {
    rows.push(relayRow('epoch', { sourceChainId: BASE_SEPOLIA }));

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('still fails an interrupted row with no relay job', async () => {
    rows.push(relayRow('epoch', { relayJob: undefined }));

    await reconcileBridgedReceives();

    expect(checkJob).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('epoch-relayed', 'failed', {
      error: 'Bridge submission was interrupted before an intent was recorded.',
      failure: { step: 'submission_interrupted', orphanCheck: 'realm_idle' }
    });
  });
});

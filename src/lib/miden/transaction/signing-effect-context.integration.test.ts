/**
 * The effect check on a single-key account's writes, driven through the real transaction loop, the real proxy
 * (flag off, inline) and the real WASM lock with its realm keystore. Only the SDK client is a stand-in: its writes
 * ask the keystore for a signature the way the SDK does, through the sign callback the realm built it with.
 */
import { SigningInputs } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import { getMessage } from 'lib/i18n/core';
import * as Repo from 'lib/miden/repo';
import { getVerificationBaseFee, isVerificationBaseFeeKnownAbsent } from 'lib/miden-chain/native-asset';

import { completeConsumeTransaction, completeCustomTransaction } from './complete';
import { ProposalEffectRefusedError } from './constants';
import { withEffectCheckedSigner, type RawSigner } from './effect-checked-signer';
import { generateTransactionsLoop } from './index';
import { isRequeueableTransaction } from './retry';
import { midenClientProxy } from '../back/miden-client-proxy';
import { ConsumeTransaction, ITransaction, ITransactionStatus, SendTransaction, SwapTransaction } from '../db/types';
import { NoteTypeEnum } from '../types';
import { buildSdkSignCallback } from './sign-callback';
import {
  getCurrentWasmLockHold,
  installRealmKeystore,
  withWasmClientLock,
  yieldWasmClientLock
} from '../sdk/miden-client';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  SigningInputs: { deserialize: jest.fn() },
  SigningInputsType: { TransactionSummary: 0, Arbitrary: 1, Blind: 2 }
}));

// The proxy reads the lock through the `lib/` alias, which the root manual mock answers unless pointed here.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireActual('../sdk/miden-client'));

type SdkSign = (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>;
type FakeClient = Record<string, jest.Mock>;
// eslint-disable-next-line no-var
var mockClient: { sign?: SdkSign; methods: FakeClient } = { methods: {} };
jest.mock('../sdk/miden-client-interface', () => ({
  ...jest.requireActual('../sdk/miden-client-interface'),
  MidenClientInterface: class {
    // Built once per realm, so each method reads the current test's stub when it is called.
    static create = async (options: { signCallback: SdkSign }) => {
      mockClient.sign = options.signCallback;
      const current =
        (method: string) =>
        (...args: unknown[]) =>
          mockClient.methods[method]!(...args);
      return {
        syncState: current('syncState'),
        newTransaction: current('newTransaction'),
        consumeNoteId: current('consumeNoteId'),
        sendTransaction: current('sendTransaction'),
        swapTransaction: current('swapTransaction'),
        free: jest.fn(),
        markPoisoned: jest.fn(),
        isDisposed: false
      };
    };
  }
}));
// Stub ids are already the bech32 the decoder would spell.
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: unknown) => String(id)
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'bech32:usdcx',
  getVerificationBaseFeeSync: () => 0,
  getVerificationBaseFee: jest.fn(async () => 0),
  isVerificationBaseFeeKnownAbsent: jest.fn(() => false)
}));
jest.mock('lib/miden/swap/fee-context', () => ({ readSwapFeeContext: jest.fn(async () => ({})) }));
jest.mock('../activity/notes', () => ({ importAllNotes: jest.fn(), queueNoteImport: jest.fn() }));
// Read lazily: `complete` sits on an import cycle with the loop, so its exports exist only once both have loaded.
jest.mock('./complete', () => {
  const done = async (id: string) =>
    jest.requireActual('./helper').updateTransactionStatus(id, 2, { completedAt: Math.floor(Date.now() / 1000) });
  const completed: Record<string, jest.Mock> = {
    completeConsumeTransaction: jest.fn(async (id: string) => done(id)),
    completeCustomTransaction: jest.fn(async (transaction: { id: string }) => done(transaction.id))
  };
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === '__esModule') return true;
        if (typeof key === 'string' && key in completed) return completed[key];
        return Reflect.get(jest.requireActual('./complete'), key);
      }
    }
  );
});
jest.mock('lib/telemetry/transaction-failure', () => ({ reportTransactionFailure: jest.fn() }));
jest.mock('lib/telemetry/crash', () => ({ captureCrash: jest.fn() }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  notifyBackgroundTransactionNotConfirmed: jest.fn()
}));

const RESULT = { __result: true };
const SIGNATURE = new Uint8Array([7]);
const PUBLIC_KEY = new Uint8Array([0x0a]);

type Asset = { faucetId: () => string; amount: () => bigint };
const fa = (faucet: string, amount: bigint): Asset => ({ faucetId: () => faucet, amount: () => amount });
const note = (assets: Asset[]) => ({
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => [] })
});
/** The summary of `account`'s transaction: `removed` leaves its vault, `added` comes in through one input note. */
const summary = (account: string, { removed, added = [] }: { removed: Asset[]; added?: Asset[] }) => {
  const vault = () => ({
    removedFungibleAssets: () => removed,
    addedFungibleAssets: () => added,
    numAssets: () => removed.length + added.length
  });
  const inputs = added.length > 0 ? [note(added)] : [];
  return {
    accountDelta: () => ({ id: () => account, vault, storage: () => ({ isEmpty: () => true }) }),
    inputNotes: () => ({ numNotes: () => inputs.length, notes: () => inputs.map(input => ({ note: () => input })) }),
    outputNotes: () => ({ numNotes: () => removed.length, notes: () => removed.map(asset => note([asset])) })
  };
};
const summaryInputs = (payload: object) => ({ variantType: 0, transactionSummaryPayload: () => payload });

/** What each signing-inputs byte string asks to sign, read as `SigningInputs.deserialize` would. */
const givenSigning = (byHex: Record<string, object>) =>
  jest
    .mocked(SigningInputs.deserialize)
    .mockImplementation(bytes => byHex[Buffer.from(bytes).toString('hex')] as never);

/** A client write that asks the keystore to sign `inputs` once, failing as the SDK does when the sign fails. */
const signingWrite = (inputs: number) =>
  jest.fn(async () => {
    try {
      await mockClient.sign!(PUBLIC_KEY, new Uint8Array([inputs]));
    } catch (error) {
      throw new Error(`failed to execute transaction: ${error instanceof Error ? error.message : String(error)}`);
    }
    return RESULT;
  });

const realmSigner = jest.fn(async (_publicKey: string, _signingInputs: string) => SIGNATURE);
const loopSigner = jest.fn(async (_publicKey: string, _signingInputs: string) => SIGNATURE);
const provider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => '',
  signWord: async () => ''
};

const queued = (fields: Partial<ITransaction>): ITransaction => ({
  id: 'row',
  type: 'execute',
  accountId: 'acct-a',
  status: ITransactionStatus.Queued,
  initiatedAt: Math.floor(Date.now() / 1000),
  displayIcon: 'DEFAULT',
  ...fields
});
const executeRow = queued({
  id: 'execute',
  type: 'execute',
  requestBytes: new Uint8Array([1]),
  approvedOutflow: [{ faucetId: 'bech32:fA', amount: 100n }]
});
const claimRow: ConsumeTransaction = {
  ...queued({ id: 'claim', type: 'consume' }),
  noteId: 'note-1',
  noteIds: ['note-1'],
  faucetId: 'bech32:fB'
};

const runRow = async (row: ITransaction): Promise<ITransaction> => {
  await Repo.transactions.put(row);
  await generateTransactionsLoop(loopSigner, false, provider);
  const stored = await Repo.transactions.get(row.id);
  if (!stored) throw new Error(`row ${row.id} vanished`);
  return stored;
};

beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => 0);
  jest.mocked(isVerificationBaseFeeKnownAbsent).mockImplementation(() => false);
  mockClient.methods = {
    syncState: jest.fn(async () => ({ blockNum: () => 1 })),
    newTransaction: signingWrite(0xaa),
    consumeNoteId: signingWrite(0xbb),
    sendTransaction: signingWrite(0xcc),
    swapTransaction: signingWrite(0xdd)
  };
  installRealmKeystore({ sign: buildSdkSignCallback(realmSigner) });
  await Repo.transactions.clear();
});

describe('the loop on a single-key account', () => {
  it('fails a dApp transaction whose summary moves more than was approved, unsigned and without a Retry', async () => {
    givenSigning({ aa: summaryInputs(summary('acct-a', { removed: [fa('bech32:fA', 500n)] })) });
    const row = await runRow(executeRow);
    expect(mockClient.methods.newTransaction).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.proposalEffectRefused).toBe(true);
    expect(row.rawError).toBe(
      'ProposalEffectRefusedError: Refused to sign this execute transaction: 500 of bech32:fA leaves (approved 100)'
    );
    expect(isRequeueableTransaction(row)).toBe(false);
    expect(loopSigner).not.toHaveBeenCalled();
    expect(realmSigner).not.toHaveBeenCalled();
    expect(completeCustomTransaction).not.toHaveBeenCalled();
  });

  it('completes a dApp transaction whose summary moves what was approved, signed by the write', async () => {
    givenSigning({ aa: summaryInputs(summary('acct-a', { removed: [fa('bech32:fA', 100n)] })) });
    const row = await runRow(executeRow);
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.proposalEffectRefused).toBeUndefined();
    expect(loopSigner).toHaveBeenCalledTimes(1);
    expect(loopSigner).toHaveBeenCalledWith('0a', 'aa');
    expect(realmSigner).not.toHaveBeenCalled();
    expect(completeCustomTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'execute' }), RESULT);
  });

  it('fails a claim whose summary pays out, the same way', async () => {
    givenSigning({ bb: summaryInputs(summary('acct-a', { removed: [fa('bech32:fA', 500n)] })) });
    const row = await runRow(claimRow);
    expect(mockClient.methods.consumeNoteId).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.proposalEffectRefused).toBe(true);
    expect(row.rawError).toBe(
      'ProposalEffectRefusedError: Refused to sign this consume transaction: 500 of bech32:fA leaves (approved 0)'
    );
    expect(isRequeueableTransaction(row)).toBe(false);
    expect(loopSigner).not.toHaveBeenCalled();
    expect(realmSigner).not.toHaveBeenCalled();
    expect(completeConsumeTransaction).not.toHaveBeenCalled();
  });

  it('requeues a claim while the chain fee is unknown, and fails a dApp transaction at once, as the Guardian leaf does', async () => {
    jest.mocked(getVerificationBaseFee).mockImplementation(async () => null);
    givenSigning({
      aa: summaryInputs(summary('acct-a', { removed: [fa('bech32:fA', 100n)] })),
      bb: summaryInputs(summary('acct-a', { removed: [], added: [fa('bech32:fB', 50n)] }))
    });
    const claim = await runRow(claimRow);
    expect(claim.status).toBe(ITransactionStatus.Queued);
    expect(claim.stage).toBe('syncing');
    expect(claim.nextEligibleAt).toEqual(expect.any(Number));
    expect(claim.lastDeferral).toBe('guardian_unreachable');
    expect(claim.requeueStreak).toEqual({ arm: 'guardian-unreachable', count: 1 });
    expect(claim.proposalEffectRefused).toBeUndefined();

    await Repo.transactions.clear();
    const executed = await runRow(executeRow);
    expect(executed.status).toBe(ITransactionStatus.Failed);
    expect(executed.error).toBe(getMessage('chainFeeUnknown'));
    expect(executed.rawError).toBe(
      'ProposalFeeUnknownError: The chain fee is not known yet, so this transaction was not signed.'
    );
    expect(executed.proposalEffectRefused).toBeUndefined();
    expect(executed.nextEligibleAt).toBeUndefined();
    expect(loopSigner).not.toHaveBeenCalled();
  });
});

describe("an inline write's signer", () => {
  const sendRow = new SendTransaction('acct-a', 5n, 'acct-b', 'bech32:fA', NoteTypeEnum.Private);
  const swapRow = new SwapTransaction('acct-a', 'bech32:fA', 5n, 'bech32:fB', 1n);
  const writes: Array<[string, string, (signer: RawSigner) => Promise<unknown>]> = [
    ['consumeNoteId', 'bb', signer => midenClientProxy.consumeNoteId(claimRow, signer)],
    ['sendTransaction', 'cc', signer => midenClientProxy.sendTransaction(sendRow, signer)],
    ['swapTransaction', 'dd', signer => midenClientProxy.swapTransaction(swapRow, signer)],
    ['newTransaction', 'aa', signer => midenClientProxy.newTransaction('acct-a', new Uint8Array([1]), false, signer)]
  ];

  it.each(writes)(
    '%s signs through the signer it was handed, while a dry run that takes the lock meanwhile keeps the realm signer',
    async (method, inputs, write) => {
      const dryRunInputs = new Uint8Array([0xee]);
      const signs = mockClient.methods[method]!;
      const signed = signs.getMockImplementation()!;
      // The write yields its hold before it signs, as a delegated prove does, and a dry run takes the lock.
      signs.mockImplementation(async () => {
        const hold = getCurrentWasmLockHold();
        await yieldWasmClientLock(
          () => withWasmClientLock(async () => mockClient.sign!(PUBLIC_KEY, dryRunInputs)),
          hold
        );
        return signed();
      });
      const perWrite = jest.fn(async (_publicKey: string, _signingInputs: string) => SIGNATURE);
      await expect(write(perWrite)).resolves.toBe(RESULT);
      expect(perWrite).toHaveBeenCalledTimes(1);
      expect(perWrite).toHaveBeenCalledWith('0a', inputs);
      expect(realmSigner).toHaveBeenCalledTimes(1);
      expect(realmSigner).toHaveBeenCalledWith('0a', 'ee');
    }
  );

  it("refuses an inline write that moves more than its row's approval, while a dry run of the same account signs", async () => {
    const drain = summaryInputs(summary('acct-a', { removed: [fa('bech32:fA', 500n)] }));
    givenSigning({ aa: drain, ee: drain });
    mockClient.methods.newTransaction!.mockImplementationOnce(async () => {
      const hold = getCurrentWasmLockHold();
      await yieldWasmClientLock(
        () => withWasmClientLock(async () => mockClient.sign!(PUBLIC_KEY, new Uint8Array([0xee]))),
        hold
      );
      return signingWrite(0xaa)();
    });
    const written = withEffectCheckedSigner(executeRow, loopSigner, signer =>
      midenClientProxy.newTransaction('acct-a', new Uint8Array([1]), false, signer)
    );
    await expect(written).rejects.toBeInstanceOf(ProposalEffectRefusedError);
    expect(loopSigner).not.toHaveBeenCalled();
    expect(realmSigner).toHaveBeenCalledTimes(1);
    expect(realmSigner).toHaveBeenCalledWith('0a', 'ee');
  });
});

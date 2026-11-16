import type { GetTaskDataParams, SolveIntentParams } from '@epoch-protocol/epoch-intents-sdk';
import { parseUnits } from 'viem';

import { deriveBridgeRoutes } from 'lib/bridge/catalog';
import { bindTransferQuote } from 'lib/bridge/core/quote';
import { assertReviewedBridge } from 'lib/bridge/core/review';
import { quoteEpochSend, runEpochSend } from 'lib/bridge/providers/epoch';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { NoteTypeEnum } from 'lib/miden/types';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { buildEpochCollateralRequestBytes } from './collateral-note';
import { bridgeEpochSend, type EpochSendArgs } from './epoch-send';
import { createBridgeP2IDENote, type CreateBridgeP2IDENoteArgs } from './miden-note';
import { deferred } from './testing/earn-locks';

const mockTaskData = jest.fn();
const mockQuote = jest.fn();
const mockSolve = jest.fn();
const mockSdk = { getTaskData: mockTaskData, getIntentQuote: mockQuote, solveIntent: mockSolve };
const mockReadSdk = jest.fn();
const mockBlock = jest.fn();
const mockWait = jest.fn();
let mockSnapshot: BridgeConfigSnapshot;
let input: EpochSendArgs;
let callback: NonNullable<SolveIntentParams['createMidenP2IDENote']>;
let noteBuilds: number;

jest.mock('./sdk', () => ({ getEpochReadOnlySdk: (...args: unknown[]) => mockReadSdk(...args) }));
jest.mock('./chain', () => ({
  getCurrentMidenBlock: () => mockBlock(),
  MIDEN_MIN_RECLAIM_BLOCKS: 1000,
  MIDEN_RECLAIM_BUFFER_BLOCKS: 200
}));
jest.mock('./collateral-note', () => ({ buildEpochCollateralRequestBytes: jest.fn() }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => true }));
jest.mock('lib/miden/activity', () => ({
  initiateBridgedSendTransaction: (...args: unknown[]) =>
    Reflect.apply(jest.requireActual('lib/miden/transaction/initiate').initiateBridgedSendTransaction, undefined, args),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  waitForTransactionCompletion: (id: string) => mockWait(id),
  markBridgedSendFailed: (
    ...args: Parameters<(typeof import('lib/miden/transaction/complete'))['markBridgedSendFailed']>
  ) =>
    jest
      .requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .markBridgedSendFailed(...args),
  updateBridgeClaimStatus: (
    ...args: Parameters<(typeof import('lib/miden/transaction/complete'))['updateBridgeClaimStatus']>
  ) =>
    jest
      .requireActual<typeof import('lib/miden/transaction/complete')>('lib/miden/transaction/complete')
      .updateBridgeClaimStatus(...args)
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  accountRefToSdk: (value: string) => value,
  getBech32AddressFromAccountId: (value: string) => value
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
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockSnapshot)
);

async function createNote(recallBlocks = 5000, attachment = [1n, 2n]) {
  return callback(input.faucetId, input.amount.toString(), accounts.midenAccount, recallBlocks, attachment);
}

async function admitOriginal(noteId = 'original-built-note', bytes = new Uint8Array([81, 82])) {
  const operation = input.operation;
  if (!operation) throw new Error('Missing original operation fixture');
  return initiateBridgedSendTransaction(
    input.senderPublicKey,
    input.amount,
    input.faucetId,
    input.destinationAddress,
    input.destinationChainId!,
    'epoch',
    noteId,
    bytes,
    true,
    {
      recipientId: accounts.midenAccount,
      noteType: NoteTypeEnum.Public,
      recallBlocks: 5000,
      reclaimHeight: 6000,
      reclaimNoteId: noteId
    },
    undefined,
    undefined,
    undefined,
    undefined,
    operation.review.route.recovery.config['bridge-providers'].epoch.allocatorUrl,
    operation,
    {
      minimumOutputBaseUnits: '1000000000000000000',
      outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      outputTokenDecimals: 18,
      validity: { kind: 'time', expiresAt: now + 60000 }
    }
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
  await Repo.transactions.clear();
  await Repo.spendingLimits.clear();
  mockSnapshot = referenceSnapshot('testnet');
  const review = reviewedErc20Transfer('epoch', 'send');
  assertReviewedBridge(review, structuredClone(review), now);
  const { source, destination, recovery } = review.route;
  const chain = recovery.config.supportedEvmChains[destination.network];
  if (source.kind !== 'miden' || destination.kind !== 'erc20' || !chain || !review.quote)
    throw new Error('Missing accepted send fixture');
  input = {
    amount: parseUnits(review.amount, source.decimals),
    minimumOutputBaseUnits: parseUnits('1', destination.decimals),
    faucetId: source.faucetId,
    destinationAddress: `0x${accounts.evmAddress.slice(2)}`,
    destinationChainId: chain.chainId,
    senderPublicKey: accounts.midenAccount,
    operation: { operationId: 'reviewed-epoch-send', review },
    deps: {
      signTransaction: jest.fn(),
      guardianProvider: {
        getAccounts: async () => [],
        getPublicKeyForCommitment: async () => '',
        signWord: async () => ''
      }
    }
  };
  mockReadSdk.mockResolvedValue(mockSdk);
  mockBlock.mockResolvedValue(1000);
  mockTaskData.mockImplementation(async (params: GetTaskDataParams) =>
    jest
      .requireActual<
        typeof import('@epoch-protocol/epoch-intents-sdk/dist/sdk/get-task-data')
      >('@epoch-protocol/epoch-intents-sdk/dist/sdk/get-task-data')
      .getTaskData(params)
  );
  mockQuote.mockImplementation(async () => ({
    success: true,
    resourceLockRequired: true,
    transactions: [],
    tokenIn: input.amount.toString(),
    tokenOut: input.minimumOutputBaseUnits.toString()
  }));
  noteBuilds = 0;
  jest.mocked(buildEpochCollateralRequestBytes).mockImplementation(async () => {
    noteBuilds++;
    return { requestBytes: new Uint8Array([81, 82]), reclaimHeight: 6000, noteId: 'original-built-note' };
  });
  mockWait.mockImplementation(async (id: string) => {
    await Repo.transactions.update(id, {
      outputNoteIds: ['original-built-note'],
      status: ITransactionStatus.Completed
    });
    return { txHash: 'original-source-hash' };
  });
  mockSolve.mockImplementation(async (params: SolveIntentParams) => {
    if (!params.createMidenP2IDENote) throw new Error('Missing real collateral callback');
    callback = params.createMidenP2IDENote;
    const result = await createNote();
    if (!result.success) throw new Error('Collateral refused');
    return { nonce: 'original-nonce', hash: 'original-solve-hash' };
  });
});
afterEach(() => jest.restoreAllMocks());

function directNoteInput(): CreateBridgeP2IDENoteArgs {
  const operation = input.operation;
  if (!operation) throw new Error('Missing valid original operation');
  return {
    senderAccountId: input.senderPublicKey,
    faucetId: input.faucetId,
    amount: input.amount.toString(),
    allocatorId: accounts.midenAccount,
    recallBlocks: 5000,
    bindingAttachmentFelts: [1n, 2n],
    destinationAddress: input.destinationAddress,
    destinationNetwork: input.destinationChainId!,
    allocatorUrl: operation.review.route.recovery.config['bridge-providers'].epoch.allocatorUrl,
    operation,
    reviewedOutput: {
      minimumOutputBaseUnits: '1000000000000000000',
      outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      outputTokenDecimals: 18,
      validity: { kind: 'time', expiresAt: now + 60000 }
    },
    deps: input.deps
  };
}

it('admits a same-scope direct owned note with native-captured protected RPC and original review', async () => {
  const result = await createBridgeP2IDENote(directNoteInput());
  expect(result.success).toBe(true);
  const row = await Repo.transactions.get(result.txId!);
  expect(row?.extraInputs.bridgeOperation?.review).toEqual(input.operation?.review);
  expect(row?.extraInputs.bridgeOperation?.walletScope).toEqual({
    network: 'testnet',
    rpcUrl: 'https://wallet-rpc.example/private'
  });
  expect(noteBuilds).toBe(1);
});

it.each(['outer', 'direct'])(
  'refuses a changed RPC during the WASM note build before real owned native admission: %s',
  async caller => {
    jest.mocked(buildEpochCollateralRequestBytes).mockImplementation(async () => {
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://changed-during-build.example/private');
      return { requestBytes: new Uint8Array([81, 82]), reclaimHeight: 6000, noteId: 'original-built-note' };
    });
    const outcome =
      caller === 'outer'
        ? await bridgeEpochSend(input).then(
            () => 'admitted',
            () => 'refused'
          )
        : (await createBridgeP2IDENote(directNoteInput())).success
          ? 'admitted'
          : 'refused';
    const rows = await Repo.transactions.toArray();
    expect({
      outcome,
      admitted: rows.map(row => ({
        operationId: row.extraInputs.bridgeOperation?.operationId,
        rpcUrl: row.extraInputs.bridgeOperation?.walletScope?.rpcUrl
      }))
    }).toEqual({ outcome: 'refused', admitted: [] });
  }
);

it('uses an explicit pre-build scope only to refuse, never as native capture authority', async () => {
  const result = await createBridgeP2IDENote({
    ...directNoteInput(),
    expectedWalletScope: { network: 'testnet', rpcUrl: 'https://earlier-reviewed-rpc.example/private' }
  });
  expect({ success: result.success, rows: await Repo.transactions.count() }).toEqual({ success: false, rows: 0 });
});

it('preserves configured native EVM output identity through the Command send adapter', async () => {
  mockSnapshot = referenceSnapshot('mainnet');
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
  const route = deriveBridgeRoutes(mockSnapshot).find(
    candidate => candidate.provider === 'epoch' && candidate.mode === 'send' && candidate.destination.kind === 'native'
  );
  if (!route || route.source.kind !== 'miden') throw new Error('Missing accepted native Epoch route');
  const request = { route, amount: '1', ...accounts };
  const review = {
    route,
    amount: '1',
    accounts: { ...accounts },
    quote: bindTransferQuote(request, { kind: 'epoch', received: '1', validity: { kind: 'provider' } })
  };
  assertReviewedBridge(review, structuredClone(review), now);
  input = {
    ...input,
    amount: parseUnits('1', route.source.decimals),
    faucetId: route.source.faucetId,
    destinationChainId: route.recovery.config.supportedEvmChains[route.destination.network]!.chainId,
    operation: { operationId: 'native-output-send', review }
  };
  const result = await runEpochSend(input.operation!, input.deps);
  const row = await Repo.transactions.get(result.txId!);
  expect(row?.extraInputs.epochReviewedOutput).toEqual({
    minimumOutputBaseUnits: '1000000000000000000',
    outputTokenDecimals: 18,
    outputTokenAddress: '0x0000000000000000000000000000000000000000',
    validity: { kind: 'provider' }
  });
  expect(noteBuilds).toBe(1);
});

it('quotes the supported Command Miden-source direction without invented expiry or signing', async () => {
  const review = input.operation?.review;
  if (!review) throw new Error('Missing accepted Command review');
  const result = await quoteEpochSend({ route: review.route, amount: review.amount, ...review.accounts });
  expect(result).toEqual({ kind: 'epoch', received: '1', validity: { kind: 'provider' } });
  expect(mockSolve).not.toHaveBeenCalled();
  expect(await Repo.transactions.count()).toBe(0);
});

it('runs Command through the existing owned collateral controller, never an EVM source signature', async () => {
  const operation = input.operation;
  if (!operation) throw new Error('Missing accepted Command operation');
  const result = await runEpochSend(operation, input.deps);
  const row = await Repo.transactions.get(result.txId!);
  expect(row?.extraInputs.bridgeOperation?.operationId).toBe('reviewed-epoch-send');
  expect(row?.extraInputs.intentNonce).toBe('original-nonce');
  expect(noteBuilds).toBe(1);
  expect(mockSolve).toHaveBeenCalledTimes(1);
});

it('queues the original owned review, exact destination floor and built note before exposing the row', async () => {
  const exposed: unknown[] = [];
  input.onRowCreated = id => {
    exposed.push(Repo.transactions.get(id));
  };
  const result = await bridgeEpochSend(input);
  const row = await Repo.transactions.get(result.txId!);
  expect(noteBuilds).toBe(1);
  expect(row?.approvedOutputNoteIds).toEqual(['original-built-note']);
  expect(row?.extraInputs.bridgeOperation?.review).toEqual(input.operation?.review);
  expect(row?.extraInputs.epochReviewedOutput).toEqual({
    minimumOutputBaseUnits: '1000000000000000000',
    outputTokenDecimals: 18,
    outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    validity: { kind: 'time', expiresAt: now + 60000 }
  });
  const exposedRows = await Promise.all(exposed);
  expect(exposedRows).toEqual([
    expect.objectContaining({
      extraInputs: expect.objectContaining({
        epochReviewedOutput: expect.objectContaining({ minimumOutputBaseUnits: '1000000000000000000' })
      })
    })
  ]);
  expect(row?.extraInputs.intentNonce).toBe('original-nonce');
  expect(mockTaskData).toHaveBeenCalledWith(
    expect.objectContaining({
      intentData: expect.objectContaining({ minTokenOut: '1000000000000000000' })
    })
  );
  expect(mockSolve).toHaveBeenCalledWith(
    expect.objectContaining({
      intentData: expect.objectContaining({ minTokenOut: '1000000000000000000' }),
      quoteResult: expect.objectContaining({ tokenOut: '1000000000000000000' })
    })
  );
});

it.each(['entry', 'sdk', 'block', 'quote', 'callback', 'note-build'])(
  'refuses an expired original review at %s before any collateral row is admitted',
  async boundary => {
    const expire = () => jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
    if (boundary === 'entry') expire();
    if (boundary === 'sdk')
      mockReadSdk.mockImplementation(async () => {
        expire();
        return mockSdk;
      });
    if (boundary === 'block')
      mockBlock.mockImplementation(async () => {
        expire();
        return 1000;
      });
    if (boundary === 'quote')
      mockQuote.mockImplementation(async () => {
        expire();
        return { success: true, resourceLockRequired: true, transactions: [], tokenOut: '1000000000000000000' };
      });
    if (boundary === 'callback')
      mockSolve.mockImplementation(async (params: SolveIntentParams) => {
        callback = params.createMidenP2IDENote!;
        expire();
        await createNote();
        return { nonce: 'should-not-fund' };
      });
    if (boundary === 'note-build')
      jest.mocked(buildEpochCollateralRequestBytes).mockImplementation(async () => {
        expire();
        return { requestBytes: new Uint8Array([81]), reclaimHeight: 6000, noteId: 'expired-note' };
      });
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
    expect(mockReadSdk).toHaveBeenCalledTimes(boundary === 'entry' ? 0 : 1);
  }
);

it.each(['sdk', 'quote', 'callback'])(
  'refuses original wallet scope departure after the %s await before collateral admission',
  async boundary => {
    const leave = () => jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
    if (boundary === 'sdk')
      mockReadSdk.mockImplementation(async () => {
        leave();
        return mockSdk;
      });
    if (boundary === 'quote')
      mockQuote.mockImplementation(async () => {
        leave();
        return { success: true, resourceLockRequired: true, transactions: [], tokenOut: '1000000000000000000' };
      });
    if (boundary === 'callback')
      mockSolve.mockImplementation(async (params: SolveIntentParams) => {
        callback = params.createMidenP2IDENote!;
        leave();
        await createNote();
        return { nonce: 'should-not-fund' };
      });
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
    expect(noteBuilds).toBe(0);
  }
);

it('does not substitute a changed allocator configuration after the quote await', async () => {
  mockQuote.mockImplementation(async () => {
    const config = mockSnapshot.config;
    if (!config) throw new Error('Missing accepted config');
    mockSnapshot = {
      ...mockSnapshot,
      config: {
        ...config,
        'bridge-providers': {
          ...config['bridge-providers'],
          epoch: {
            ...config['bridge-providers'].epoch,
            allocatorUrl: 'https://other-allocator.example'
          }
        }
      }
    };
    return { success: true, resourceLockRequired: true, transactions: [], tokenOut: '1000000000000000000' };
  });
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
  expect(noteBuilds).toBe(0);
});

it.each(['amount', 'faucet', 'sender', 'recipient', 'chain', 'floor', 'scope'])(
  'does not fund when the caller changes the original reviewed %s',
  async changed => {
    if (changed === 'amount') input.amount++;
    if (changed === 'faucet') input.faucetId = '0x123456789abcdef0123456789abcde';
    if (changed === 'sender') input.senderPublicKey = '0x123456789abcdef0123456789abcde';
    if (changed === 'recipient') input.destinationAddress = '0x9999999999999999999999999999999999999999';
    if (changed === 'chain') input.destinationChainId = 1;
    if (changed === 'floor') input.minimumOutputBaseUnits--;
    if (changed === 'scope') jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
    expect(noteBuilds).toBe(0);
  }
);

it('coalesces identical concurrent and late callbacks onto the original pending note and result', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  mockWait.mockImplementation(async (id: string) => {
    entered.resolve();
    await release.promise;
    await Repo.transactions.update(id, {
      outputNoteIds: ['original-built-note'],
      status: ITransactionStatus.Completed
    });
    return { txHash: 'original-source-hash' };
  });
  mockSolve.mockImplementation(async (params: SolveIntentParams) => {
    callback = params.createMidenP2IDENote!;
    const first = createNote();
    await entered.promise;
    const second = createNote();
    release.resolve();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual([
      { success: true, noteId: 'original-built-note' },
      { success: true, noteId: 'original-built-note' }
    ]);
    expect(await createNote()).toEqual(outcomes[0]);
    return { nonce: 'original-nonce' };
  });
  await bridgeEpochSend(input);
  expect(noteBuilds).toBe(1);
  expect(mockWait).toHaveBeenCalledTimes(1);
  expect(await Repo.transactions.count()).toBe(1);
});

it.each(['recall', 'attachment'])(
  'refuses a changed %s callback without losing the original note or returned nonce',
  async changed => {
    mockSolve.mockImplementation(async (params: SolveIntentParams) => {
      callback = params.createMidenP2IDENote!;
      expect(await createNote()).toEqual({ success: true, noteId: 'original-built-note' });
      const second = changed === 'recall' ? await createNote(6000) : await createNote(5000, [9n, 2n]);
      expect(second.success).toBe(false);
      return { nonce: 'original-nonce', hash: 'original-solve-hash' };
    });
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    const rows = await Repo.transactions.toArray();
    expect(noteBuilds).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.extraInputs.intentNonce).toBe('original-nonce');
    expect(rows[0]?.extraInputs.reclaimNoteId).toBe('original-built-note');
  }
);

it('keeps original funded continuation and nonce after deadline and scope departure while the note confirms', async () => {
  mockWait.mockImplementation(async (id: string) => {
    jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
    await Repo.transactions.update(id, {
      outputNoteIds: ['original-built-note'],
      status: ITransactionStatus.Completed
    });
    return { txHash: 'original-source-hash' };
  });
  const result = await bridgeEpochSend(input);
  const row = await Repo.transactions.get(result.txId!);
  expect(row?.extraInputs.intentNonce).toBe('original-nonce');
  expect(row?.extraInputs.reclaimNoteId).toBe('original-built-note');
  expect(noteBuilds).toBe(1);
  expect(mockSolve).toHaveBeenCalledTimes(1);
});

it.each(['scope', 'collateral'])(
  'retains the original %s callback refusal instead of funding a later callback',
  async refusal => {
    mockSolve.mockImplementation(async (params: SolveIntentParams) => {
      callback = params.createMidenP2IDENote!;
      if (refusal === 'scope') {
        jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://temporarily-changed.example/private');
      }
      const first =
        refusal === 'scope'
          ? await createNote()
          : await callback('0x123456789abcdef0123456789abcde', input.amount.toString(), accounts.midenAccount, 5000, [
              1n,
              2n
            ]);
      expect(first).toEqual({ success: false });
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
      expect(await createNote()).toEqual({ success: false });
      return { nonce: 'refused-callback-nonce' };
    });
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(noteBuilds).toBe(0);
    expect(await Repo.transactions.count()).toBe(0);
  }
);

it('does not retry a failed callback or create a second collateral row', async () => {
  mockWait.mockResolvedValue({ errorMessage: 'original interrupted attempt' });
  mockSolve.mockImplementation(async (params: SolveIntentParams) => {
    callback = params.createMidenP2IDENote!;
    expect(await createNote()).toEqual({ success: false });
    expect(await createNote()).toEqual({ success: false });
    throw new Error('original interrupted attempt');
  });
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  expect(noteBuilds).toBe(1);
  expect(await Repo.transactions.count()).toBe(1);
});

it('retains the winning row on an interrupted completion read without retrying collateral', async () => {
  mockWait.mockRejectedValue(new Error('completion read interrupted'));
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  const rows = await Repo.transactions.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.extraInputs.reclaimNoteId).toBe('original-built-note');
  expect(rows[0]?.status).toBe(ITransactionStatus.Failed);
  expect(noteBuilds).toBe(1);
});

it('preserves the original source result and nonce even if navigation throws at row exposure', async () => {
  const navigationError = new Error('view unmounted');
  input.onRowCreated = () => {
    throw navigationError;
  };
  await expect(bridgeEpochSend(input)).rejects.toBe(navigationError);
  const rows = await Repo.transactions.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.extraInputs.intentNonce).toBe('original-nonce');
  expect(rows[0]?.outputNoteIds).toEqual(['original-built-note']);
  expect(noteBuilds).toBe(1);
});

it('passively resumes the original admitted row after expiry and scope departure without another solve or note', async () => {
  const id = await admitOriginal();
  await Repo.transactions.update(id, {
    status: ITransactionStatus.Completed,
    outputNoteIds: ['original-built-note'],
    'extraInputs.intentNonce': 'retained-original-nonce'
  });
  jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
  jest.mocked(getEffectiveNetworkName).mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
  const result = await bridgeEpochSend(input);
  expect(result).toEqual({ txId: id });
  expect(mockReadSdk).not.toHaveBeenCalled();
  expect(mockSolve).not.toHaveBeenCalled();
  expect(noteBuilds).toBe(0);
  expect((await Repo.transactions.get(id))?.extraInputs.intentNonce).toBe('retained-original-nonce');
  expect(await Repo.transactions.count()).toBe(1);
});

it.each(['review', 'alias', 'restored', 'malformed'])(
  'refuses %s recovery identity without changing the original receipt or starting source work',
  async changed => {
    const id = await admitOriginal();
    const row = await Repo.transactions.get(id);
    if (!row) throw new Error('Missing actually admitted original');
    if (changed === 'review') input.minimumOutputBaseUnits--;
    if (changed === 'alias') await Repo.transactions.add({ ...row, id: 'foreign-alias' });
    if (changed === 'restored') await Repo.transactions.update(id, { restoredFromBackup: true });
    if (changed === 'malformed') await Repo.transactions.update(id, { 'extraInputs.bridgeOperation.version': 2 });
    const before = await Repo.transactions.toArray();
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(mockReadSdk).not.toHaveBeenCalled();
    expect(await Repo.transactions.toArray()).toEqual(before);
  }
);

it('does not hand a racing different note to the SDK or demote the actual native admission winner', async () => {
  let originalId = '';
  jest.mocked(buildEpochCollateralRequestBytes).mockImplementation(async () => {
    originalId = await admitOriginal('winning-note', new Uint8Array([91, 92]));
    return { requestBytes: new Uint8Array([81, 82]), reclaimHeight: 6000, noteId: 'losing-note' };
  });
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  const row = await Repo.transactions.get(originalId);
  expect(await Repo.transactions.count()).toBe(1);
  expect(row?.status).toBe(ITransactionStatus.Queued);
  expect(row?.approvedOutputNoteIds).toEqual(['winning-note']);
  expect(row?.requestBytes).toEqual(new Uint8Array([91, 92]));
  expect(row?.extraInputs.claimStatus).toBe('not-applicable');
  expect(mockWait).not.toHaveBeenCalled();
});

it('rechecks compact reviewed validity inside the real native admission after waiting for storage', async () => {
  delete input.operation;
  input.reviewedQuote = {
    outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    outputTokenDecimals: 18,
    validity: { kind: 'time', expiresAt: now + 60000 }
  };
  const transaction = Repo.db.transaction.bind(Repo.db);
  jest.spyOn(Repo.db, 'transaction').mockImplementationOnce((...args) => {
    jest.spyOn(Date, 'now').mockReturnValue(now + 60000);
    return Reflect.apply(transaction, Repo.db, args);
  });
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  expect(await Repo.transactions.count()).toBe(0);
});

it.each(['token', 'scale', 'expired', 'invalid-time'])(
  'refuses compact %s review binding before external work',
  async changed => {
    delete input.operation;
    input.reviewedQuote = {
      outputTokenAddress:
        changed === 'token'
          ? '0x9999999999999999999999999999999999999999'
          : '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      outputTokenDecimals: changed === 'scale' ? 6 : 18,
      validity: {
        kind: 'time',
        expiresAt: changed === 'expired' ? now : changed === 'invalid-time' ? NaN : now + 60000
      }
    };
    await expect(bridgeEpochSend(input)).rejects.toThrow();
    expect(mockReadSdk).not.toHaveBeenCalled();
    expect(noteBuilds).toBe(0);
  }
);

it('refuses a compact binding that disagrees with the owned original review', async () => {
  input.reviewedQuote = {
    outputTokenAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    outputTokenDecimals: 18,
    validity: { kind: 'provider' }
  };
  await expect(bridgeEpochSend(input)).rejects.toThrow();
  expect(noteBuilds).toBe(0);
});

it('keeps explicit untagged positive-minimum calls without manufacturing review or expiry authority', async () => {
  delete input.operation;
  const result = await bridgeEpochSend(input);
  const row = await Repo.transactions.get(result.txId!);
  expect(noteBuilds).toBe(1);
  expect(row?.extraInputs.bridgeOperation).toBeUndefined();
  expect(row?.extraInputs.epochReviewedOutput).toBeUndefined();
  expect(row?.extraInputs.intentNonce).toBe('original-nonce');
});

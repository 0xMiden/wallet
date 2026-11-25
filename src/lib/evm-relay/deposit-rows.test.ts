import type { Hex } from 'viem';

import { createBridgeReceiveReconciler } from 'lib/miden/activity/bridge-receive';
import { ITransactionStatus, type IBridgedReceiveRelay } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { readEvmReceiptOutcome } from 'lib/walletconnect/receipt';

import { createRelayRow, readOpenRelayRows } from './deposit-rows';
import type { RelayRowDraft } from './deposit-store';

jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: jest.fn(() => 'testnet')
}));
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() =>
      jest
        .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
        .testBridgeSnapshot()
    )
);
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual('lib/walletconnect/receipt'),
  readEvmReceiptOutcome: jest.fn()
}));
jest.mock('lib/agglayer/status', () => ({
  ...jest.requireActual('lib/agglayer/status'),
  fetchDeposits: jest.fn(async () => [])
}));

const CHAIN_ID = 11155111;
const ACCOUNT = 'mtst1account';
const TX1: Hex = `0x${'71'.repeat(32)}`;
const TOKEN = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

const DRAFT: RelayRowDraft = {
  accountId: ACCOUNT,
  sourceAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  chainId: CHAIN_ID,
  token: TOKEN,
  amount: '2500000000000000000',
  sourceAmount: '2.5',
  sourceSymbol: 'USDC',
  outputAmount: '2.5',
  outputSymbol: 'USDC',
  agglayerRoute: {
    chainId: CHAIN_ID,
    contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
    midenBridgeId: 'mtst1bridge',
    indexerUrl: 'https://indexer.example',
    rollupId: 73,
    evmNetworkId: 0
  },
  agglayerDelivery: { originToken: TOKEN, faucetId: '0xb41aed8db850a3d140fc2079216c60', scale: 10 }
};

function relay(jobId: string, overrides: Partial<IBridgedReceiveRelay> = {}): IBridgedReceiveRelay {
  return {
    jobId,
    chainId: CHAIN_ID,
    kind: 'agglayer-deposit',
    token: TOKEN,
    state: 'pending',
    txHash: TX1,
    ...overrides
  };
}

const JOB_A = `0x${'aa'.repeat(32)}`;
const JOB_B = `0x${'bb'.repeat(32)}`;

beforeEach(async () => {
  await Repo.transactions.clear();
  jest.mocked(readEvmReceiptOutcome).mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createRelayRow', () => {
  it('writes the row of a WalletConnect Agglayer deposit with its hash, once per job', async () => {
    const id = await createRelayRow(DRAFT, relay(JOB_A));
    expect(await createRelayRow(DRAFT, relay(JOB_A.toUpperCase().replace('0X', '0x')))).toBe(id);
    expect(await Repo.transactions.count()).toBe(1);

    const row = await Repo.transactions.get(id);
    expect(row).toEqual(
      expect.objectContaining({
        type: 'bridged-receive',
        status: ITransactionStatus.Completed,
        accountId: ACCOUNT,
        amount: 2_500_000_000_000_000_000n,
        faucetId: ''
      })
    );
    expect(row?.extraInputs).toEqual({
      provider: 'agglayer',
      phase: 'submitting',
      evmTxHash: TX1,
      sourceAddress: DRAFT.sourceAddress,
      sourceChainId: CHAIN_ID,
      sourceAmount: '2.5',
      sourceSymbol: 'USDC',
      outputAmount: '2.5',
      outputSymbol: 'USDC',
      agglayerRoute: DRAFT.agglayerRoute,
      agglayerDelivery: DRAFT.agglayerDelivery,
      relay: relay(JOB_A)
    });
  });

  it('does not count a row restored from a backup as the job', async () => {
    const restored = await createRelayRow(DRAFT, relay(JOB_A));
    await Repo.transactions.update(restored, { restoredFromBackup: true });
    const local = await createRelayRow(DRAFT, relay(JOB_A));
    expect(local).not.toBe(restored);
    expect((await readOpenRelayRows(ACCOUNT, CHAIN_ID)).map(row => row.id)).toEqual([local]);
  });
});

describe('readOpenRelayRows', () => {
  it('lists the rows the Agglayer tracking still follows, for the chain', async () => {
    const open = await createRelayRow(DRAFT, relay(JOB_A));
    const ready = await createRelayRow(DRAFT, relay(JOB_B));
    await updateBridgedReceivePhase(ready, 'ready');
    await createRelayRow({ ...DRAFT, chainId: 1 }, relay(`0x${'cc'.repeat(32)}`, { chainId: 1 }));

    expect(await readOpenRelayRows(ACCOUNT, CHAIN_ID)).toEqual([
      expect.objectContaining({ id: open, phase: 'submitting', evmTxHash: TX1, relay: relay(JOB_A) })
    ]);
  });
});

it('hands a relay row to the existing Agglayer reconciler', async () => {
  const id = await createRelayRow(DRAFT, relay(JOB_A));
  jest.mocked(readEvmReceiptOutcome).mockResolvedValue('success');

  await createBridgeReceiveReconciler({ getLocks: () => undefined }).reconcile();

  expect(readEvmReceiptOutcome).toHaveBeenCalledWith(TX1, expect.objectContaining({ id: CHAIN_ID }));
  const row = await Repo.transactions.get(id);
  expect(row?.extraInputs.phase).toBe('delivering');
  expect(row?.extraInputs.relay).toEqual(relay(JOB_A));
});

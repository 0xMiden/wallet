import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import type { BridgeToken, DerivedChainConfig } from 'lib/remote-config/derive';
import { type BridgeConfigSnapshot, initBridgeConfig } from 'lib/remote-config/runtime';
import type { AgglayerRecoveryConfig, SupportedEvmChainConfig } from 'lib/remote-config/schema';
import { testBridgeSnapshot } from 'lib/remote-config/testing/fixture';
import { selectNativeEthToken } from 'lib/remote-config/values';

import {
  agglayerDeliveredAmount,
  agglayerDeliverySenders,
  isAgglayerBridgeDelivery,
  findPendingBridgeInByEarnWithdrawTxId,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  suppressedLinkedConsumeIds,
  takeAgglayerBridgeInInfo,
  takeUsdcxBridgeInInfo,
  _resetLiveRegistryReadsForTest,
  applyBridgeInInfoForNotes,
  setAgglayerSenderForE2E
} from './bridge-in';
import { IBridgeInInfo, ITransaction } from '../db/types';

const mockStore: Record<string, unknown> = {};

jest.mock('../front/storage', () => ({
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  fetchFromStorage: jest.fn(async (key: string) => mockStore[key]),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = value;
  })
}));

const mockAnyOfToArray = jest.fn();
const mockTransactions: any[] = [];
// Rows `tagConsumeRow` searches by note id, kept apart from `mockTransactions`
// so the AggLayer suites above are unaffected.
const mockNoteIdRows: any[] = [];
const mockModify = jest.fn(async (mutate: (row: ITransaction) => void, index: unknown) => {
  const row =
    typeof index === 'object' && index !== null
      ? mockNoteIdRows.find(record => record.id === Reflect.get(index, 'id'))
      : undefined;
  if (row) mutate(row);
  return row ? 1 : 0;
});
jest.mock('lib/agglayer/constant', () => ({ AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL: 'ETH' }));
// The delivery sender is the registry's native-ETH faucet (hex); the consume reads its sender in bech32. The bridge
// registers that faucet with scale 10: a deposit of w wei arrives as floor(w / 10^10) (#1326).
const nativeEth = (midenFaucetId: string, scale: number): BridgeToken => ({
  midenFaucetId,
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale
});
const registryReads = (tokens: BridgeToken[]): DerivedChainConfig => ({
  agglayer: {
    rollupId: { state: 'ok', value: 86 },
    tokens: { state: 'ok', value: tokens },
    evmNetworkId: { state: 'ok', value: 0 },
    l1BridgeCode: { state: 'ok', value: true },
    depositTokens: { state: 'skipped' }
  },
  epoch: { tokens: {} }
});
// The published testnet document, its AggLayer route on Sepolia, with the registry read on each listed chain.
const snapshotWith = (
  registries: Record<number, BridgeToken[]>,
  extraChains: Record<string, SupportedEvmChainConfig> = {}
): BridgeConfigSnapshot => {
  const published = testBridgeSnapshot();
  const config = published.config;
  if (!config) throw new Error('The test document is missing');
  return {
    ...published,
    config: { ...config, supportedEvmChains: { ...config.supportedEvmChains, ...extraChains } },
    derived: {
      network: 'testnet',
      version: config.version,
      derivedAt: 0,
      chains: Object.fromEntries(Object.entries(registries).map(([id, tokens]) => [id, registryReads(tokens)])),
      agglayer: { indexer: { state: 'ok', value: true } },
      epoch: {
        allocator: { state: 'skipped' },
        market: { state: 'skipped' },
        midenUsdcFaucet: { state: 'skipped' },
        vaults: { state: 'skipped' }
      }
    }
  };
};
// The live read of a bridge's faucet registry, for a row whose token the snapshot does not hold yet.
const mockReadBridgeRegistry = jest.fn(
  async (_bridge: string, _rpcUrl: string): Promise<{ rollupId: number; tokens: BridgeToken[] }> => ({
    rollupId: 86,
    tokens: []
  })
);
jest.mock('lib/remote-config/derive', () => ({
  readBridgeRegistry: (bridge: string, rpcUrl: string) => mockReadBridgeRegistry(bridge, rpcUrl)
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => 'https://rpc.miden.test'
}));
let mockSnapshot: BridgeConfigSnapshot;
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: jest.fn(() => mockSnapshot),
  initBridgeConfig: jest.fn(async () => ({}))
}));
// The real selectors, the registry read wrapped so a case can stand in for it.
jest.mock('lib/remote-config/values', () => {
  const actual = jest.requireActual<typeof import('lib/remote-config/values')>('lib/remote-config/values');
  return {
    ...actual,
    selectNativeEthToken: jest.fn(actual.selectNativeEthToken)
  };
});
// As the SDK parses ids: one text per account whichever form names it, and not the text the registry names the faucet
// in, so only a match that converts both sides finds the sender.
const mockAccountText: Record<string, string> = {
  'agg-sender': 'agg-account',
  '0xagg': 'agg-account',
  'base-sender': 'base-account',
  '0xbase': 'base-account',
  'usdc-sender': 'usdc-faucet-account',
  '0xusdcfaucet': 'usdc-faucet-account',
  'elsewhere-sender': 'elsewhere-faucet-account',
  '0xelsewhere': 'elsewhere-faucet-account',
  'usdcx-faucet-bech32': 'usdcx-faucet-account',
  '0xusdcx': 'usdcx-faucet-account'
};
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => {
    if (ref === 'unreadable-sender') throw new Error('not an account id');
    return { toString: () => mockAccountText[ref] ?? `${ref}-account` };
  },
  sameWalletAccountId: (a: string, b: string) => (mockAccountText[a] ?? a) === (mockAccountText[b] ?? b)
}));
// The note-id poll's Epoch SDK names the allocator it was built for, so a case can answer per allocator.
const mockGetEpochReadOnlySdk = jest.fn(async (_address: string, _saved?: string) => ({ allocatorUrl: '' }));
jest.mock('lib/epoch/sdk', () => ({
  getEpochReadOnlySdk: (address: string, saved?: string) => mockGetEpochReadOnlySdk(address, saved)
}));
const mockReadIntentStatus = jest.fn(async (_sdk: { allocatorUrl: string }): Promise<unknown[]> => []);
jest.mock('lib/epoch/intent-status', () => ({
  readEpochIntentStatus: (sdk: { allocatorUrl: string }) => mockReadIntentStatus(sdk)
}));
// USDCx is the chain's native asset: the wallet discovers the faucet id, here in hex.
const mockGetNativeAssetId = jest.fn(async () => '0xusdcx');
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockGetNativeAssetId()
}));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((index?: unknown) => ({
      anyOf: jest.fn(() => ({ toArray: mockAnyOfToArray })),
      anyOfIgnoreCase: jest.fn((...noteIds: string[]) => ({
        filter: jest.fn((predicate: (tx: ITransaction) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows
              .filter(row => row.noteIds?.some((id: string) => noteIds.includes(id.toLowerCase())))
              .find(predicate)
          )
        }))
      })),
      // `where({ id })` for the modify path; `where('noteIds').equals(id)` for the lookup.
      modify: (mutate: (row: ITransaction) => void) => mockModify(mutate, index),
      // `where('noteIds').equals(id)` for the note lookup; `where('type').equals(type)` for the bridge-in matchers.
      equals: jest.fn((value: string) => ({
        filter: jest.fn((predicate: (tx: any) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows.filter(row => row.noteIds?.includes(value)).find(row => predicate(row))
          ),
          toArray: jest.fn(async () =>
            index === 'type' ? mockTransactions.filter(tx => tx.type === value && predicate(tx)) : []
          )
        }))
      })),
      first: jest.fn(async () =>
        typeof index === 'object' && index !== null
          ? mockNoteIdRows.find(row => row.id === Reflect.get(index, 'id'))
          : undefined
      ),
      index
    }))
    // No table-level `filter`: the matchers read bridged-receive rows through the `type` index, never the whole table.
  }
}));

const REGISTRY_KEY = 'epoch_bridge_in_intents';
const EVM_OWNER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  _resetLiveRegistryReadsForTest();
  mockSnapshot = snapshotWith({ 11155111: [nativeEth('0xagg', 10)] });
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  mockTransactions.splice(0);
  mockNoteIdRows.splice(0);
});

describe('resolveBridgeInNoteId', () => {
  const NOTE_ID = 'note-abc';
  const info: IBridgeInInfo = {
    provider: 'epoch',
    sourceAmount: '5',
    sourceSymbol: 'ETH',
    intentNonce: 'N1'
  };

  const consumeRow = (over: Record<string, unknown> = {}) => ({
    id: 'consume-1',
    type: 'consume',
    status: 2,
    noteIds: [NOTE_ID],
    amount: 5n,
    faucetId: 'faucet-a',
    ...over
  });

  it('tags the consume row that claimed the note, and drops the intent', async () => {
    mockNoteIdRows.push(consumeRow());
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  // A restored row records someone else's claim. Adopting it would retitle it
  // "Bridged from EVM", file this intent's amounts against it, and — because a
  // hit drops the intent — leave the wallet's own consume untagged forever.
  it('refuses a row restored from a backup, and keeps the intent pending', async () => {
    mockNoteIdRows.push(consumeRow({ restoredFromBackup: true }));
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).not.toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toHaveLength(1);
  });

  // A batch row is no single delivery's receipt: tagged, it would hide itself and the other notes it claimed.
  it('drops a resolved intent without tagging or relabelling the batch row it names', async () => {
    mockNoteIdRows.push(consumeRow({ noteIds: [NOTE_ID, 'note-other'] }));
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).not.toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });
});

// The registry scale the mock above names for the native-ETH faucet.
const SCALE = 10n ** 10n;

describe('takeAgglayerBridgeInInfo', () => {
  const DAY_SEC = 24 * 60 * 60;
  // The fixtures sit near the epoch; the clock is pinned just past them so every one is inside the delivery window.
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('reads the delivery sender only once this realm has hydrated the bridge config', async () => {
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });
    let hydrated: () => void = () => undefined;
    jest.mocked(initBridgeConfig).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          hydrated = () =>
            resolve({ network: 'testnet', status: 'ready', config: null, derived: null, lastFetch: null });
        })
    );
    const taken = takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(selectNativeEthToken).not.toHaveBeenCalled();
    hydrated();
    await expect(taken).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
    expect(selectNativeEthToken).toHaveBeenCalled();
  });

  it('matches sender, recipient and amount and selects the oldest pending row', async () => {
    mockTransactions.push(
      {
        id: 'newer',
        type: 'bridged-receive',
        accountId: 'miden-account_tag',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'older',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'submitting', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ provider: 'agglayer', bridgeReceiveTxId: 'older' });
  });

  // An ERC-20 row names its delivery faucet: the USDC faucet's note settles it, at the faucet's scale, and the ETH
  // faucet's note of the same amount never does.
  it('settles an ERC-20 tracker by the delivery faucet it saved, never by the ETH faucet', async () => {
    const usdc = { originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', faucetId: '0xusdcfaucet', scale: 10 };
    mockTransactions.push({
      id: 'usdc-row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: {
        provider: 'agglayer',
        phase: 'delivering',
        sourceAmount: '5',
        sourceSymbol: 'USDC',
        agglayerDelivery: usdc
      }
    });
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toMatchObject({ provider: 'agglayer', sourceSymbol: 'USDC', bridgeReceiveTxId: 'usdc-row' });
  });

  // A test network registers the faucet on the first deposit, so a row made before that names only the token: its
  // faucet and scale come from the registry of the row's chain once it holds them.
  it('settles an ERC-20 tracker that saved no faucet once the registry holds one for its token', async () => {
    const usdcToken: BridgeToken = {
      midenFaucetId: '0xusdcfaucet',
      originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      originNetwork: 0,
      scale: 8
    };
    mockTransactions.push({
      id: 'usdc-row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * 10n ** 8n,
      initiatedAt: 1,
      extraInputs: {
        provider: 'agglayer',
        phase: 'delivering',
        sourceAmount: '5',
        sourceSymbol: 'USDC',
        agglayerDelivery: { originToken: usdcToken.originToken }
      }
    });
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toBeUndefined();
    mockSnapshot = snapshotWith({ 11155111: [nativeEth('0xagg', 10), usdcToken] });
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row' });
    // The registered faucet is a delivery sender from then on.
    expect(isAgglayerBridgeDelivery('usdc-sender')).toBe(true);
  });

  // The route the deposit screen saves with an AggLayer row: its bridge account and the network it deposited from.
  const usdcRoute: AgglayerRecoveryConfig = {
    chainId: 11155111,
    contractAddress: '0x00000000000000000000000000000000000000b2',
    midenBridgeId: '0xbridge',
    indexerUrl: 'https://indexer.test',
    rollupId: 86,
    evmNetworkId: 0
  };
  const firstDeposit = (originToken: string) => ({
    id: 'usdc-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    amount: 5n * 10n ** 8n,
    initiatedAt: 1,
    extraInputs: {
      provider: 'agglayer',
      phase: 'delivering',
      sourceAmount: '5',
      sourceSymbol: 'USDC',
      agglayerRoute: usdcRoute,
      agglayerDelivery: { originToken }
    }
  });

  // The first deposit's claim registers the faucet, usually before this realm's hourly refresh: the row's own bridge
  // is read once, and a note from a faucet the snapshot already holds never asks for it.
  it('settles a first-deposit ERC-20 tracker from a live registry read', async () => {
    const usdcToken: BridgeToken = {
      midenFaucetId: '0xusdcfaucet',
      originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      originNetwork: 0,
      scale: 8
    };
    mockTransactions.push(firstDeposit(usdcToken.originToken));
    mockReadBridgeRegistry.mockResolvedValue({ rollupId: 86, tokens: [nativeEth('0xagg', 10), usdcToken] });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row', sourceToken: usdcToken.originToken });
    // Both notes of the batch share one read of the row's bridge.
    expect(mockReadBridgeRegistry).toHaveBeenCalledTimes(1);
    expect(mockReadBridgeRegistry).toHaveBeenCalledWith('0xbridge', 'https://rpc.miden.test');
  });

  // A sender another chain's snapshot holds says nothing about the row's own chain, whose registry read may have
  // failed: the row's bridge is still read.
  it('reads the bridge for a sender only another chain knows', async () => {
    const usdcToken: BridgeToken = {
      ...nativeEth('0xusdcfaucet', 8),
      originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'
    };
    const baseSepolia: SupportedEvmChainConfig = {
      chainId: 84532,
      bridges: {
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
          midenBridgeId: '0x187cabbc404359d16be94954ca9879'
        }
      }
    };
    mockSnapshot = snapshotWith(
      { 11155111: [nativeEth('0xagg', 10)], 84532: [usdcToken] },
      { 'base-sepolia': baseSepolia }
    );
    expect(isAgglayerBridgeDelivery('usdc-sender')).toBe(true);
    mockTransactions.push(firstDeposit(usdcToken.originToken));
    mockReadBridgeRegistry.mockResolvedValue({ rollupId: 86, tokens: [usdcToken] });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row' });
    expect(mockReadBridgeRegistry).toHaveBeenCalledWith('0xbridge', 'https://rpc.miden.test');
  });

  // The same address registered from another network is not the row's faucet: such a read counts as one without it.
  it('reads the bridge again soon when the kept read holds the token only from another network', async () => {
    const originToken = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
    const elsewhere: BridgeToken = { midenFaucetId: '0xelsewhere', originToken, originNetwork: 3, scale: 8 };
    const own: BridgeToken = { midenFaucetId: '0xusdcfaucet', originToken, originNetwork: 0, scale: 8 };
    mockTransactions.push(firstDeposit(originToken));
    const take = () =>
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n });

    mockReadBridgeRegistry.mockResolvedValueOnce({ rollupId: 86, tokens: [elsewhere] });
    await expect(take()).resolves.toBeUndefined();
    mockReadBridgeRegistry.mockResolvedValue({ rollupId: 86, tokens: [elsewhere, own] });
    nowSpy.mockReturnValue(10_000 + 10_001);
    await expect(take()).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row' });
    expect(mockReadBridgeRegistry).toHaveBeenCalledTimes(2);
  });

  // A failed read is read again on the next note; a read that lacked the token, once ten seconds have passed.
  it('keeps neither a failed registry read nor one without the token', async () => {
    const usdcToken: BridgeToken = {
      ...nativeEth('0xusdcfaucet', 8),
      originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'
    };
    mockTransactions.push(firstDeposit(usdcToken.originToken));
    const take = () =>
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n });

    mockReadBridgeRegistry.mockRejectedValueOnce(new Error('node down'));
    await expect(take()).resolves.toBeUndefined();
    mockReadBridgeRegistry.mockResolvedValueOnce({ rollupId: 86, tokens: [] });
    await expect(take()).resolves.toBeUndefined();
    expect(mockReadBridgeRegistry).toHaveBeenCalledTimes(2);

    mockReadBridgeRegistry.mockResolvedValue({ rollupId: 86, tokens: [usdcToken] });
    await expect(take()).resolves.toBeUndefined();
    expect(mockReadBridgeRegistry).toHaveBeenCalledTimes(2);
    nowSpy.mockReturnValue(10_000 + 10_001);
    await expect(take()).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row' });
    expect(mockReadBridgeRegistry).toHaveBeenCalledTimes(3);
  });

  // The same token registered from another network mints another bridged token: while the chain's network id read
  // fails, the row's own deposit network still picks its faucet, and the other network's never settles it.
  it('settles an ERC-20 tracker only by the faucet of the network it deposited from', async () => {
    const originToken = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
    const elsewhere: BridgeToken = { midenFaucetId: '0xelsewhere', originToken, originNetwork: 3, scale: 8 };
    const own: BridgeToken = { midenFaucetId: '0xusdcfaucet', originToken, originNetwork: 0, scale: 8 };
    const reads = registryReads([nativeEth('0xagg', 10), elsewhere, own]);
    mockSnapshot = {
      ...snapshotWith({}),
      derived: {
        ...snapshotWith({}).derived!,
        chains: {
          11155111: { ...reads, agglayer: { ...reads.agglayer, evmNetworkId: { state: 'error', message: 'down' } } }
        }
      }
    };
    mockTransactions.push(firstDeposit(originToken));

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'elsewhere-sender', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'usdc-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'usdc-row' });
  });

  // Matching rewrites the tracker row to `received` and makes the real consume
  // hide beneath it in history, so a restored tracker would adopt a genuine
  // incoming note and file the user's money under whatever the dump said.
  // The sender delivers bridged ETH, so an ERC-20 tracker must not adopt its note
  // even when it is older and its base-unit amount is the same.
  it('settles the ETH tracker, never an older ERC-20 tracker with the same amount', async () => {
    mockTransactions.push(
      {
        id: 'usdc',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'USDC' }
      },
      {
        id: 'eth',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'eth' });
  });

  it('never adopts a genuine note into a restored tracker', async () => {
    mockTransactions.push(
      {
        id: 'restored',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        restoredFromBackup: true,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'mine',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    // `restored` is the older row and would otherwise win the oldest-first pick.
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'mine' });
  });

  it('does not match a different sender or amount', async () => {
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'other', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();

    // Positive control: the same row matches with the configured sender and its amount.
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  it('matches the sender as an account, not as the text the registry names the faucet in', async () => {
    expect(accountRefToSdk('0xagg').toString()).not.toBe('0xagg');
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  it('logs a sender it cannot compare and takes no row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'unreadable-sender', amount: 5n })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[bridge-in] could not compare the delivery sender',
        'unreadable-sender',
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('matches nothing while the bridge config names no native-ETH faucet', async () => {
    mockSnapshot = snapshotWith({ 11155111: [] });
    expect(isAgglayerBridgeDelivery('agg-sender')).toBe(false);
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();
  });

  it('takes an E2E sender instead of the registry faucet', async () => {
    setAgglayerSenderForE2E('cli-faucet');
    try {
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });
      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
      ).resolves.toBeUndefined();
      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'cli-faucet', amount: 5n })
      ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
    } finally {
      // An empty override clears it, so no later case inherits it.
      setAgglayerSenderForE2E('');
    }
  });

  describe('on more than one AggLayer chain', () => {
    const BASE_ROUTE: AgglayerRecoveryConfig = {
      chainId: 84532,
      contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
      midenBridgeId: '0x187cabbc404359d16be94954ca9879',
      indexerUrl: 'https://indexer.test/api',
      rollupId: 86,
      evmNetworkId: 6
    };
    const baseSepolia: SupportedEvmChainConfig = {
      chainId: 84532,
      bridges: {
        agglayer: {
          depositEnabled: true,
          withdrawalEnabled: true,
          contractAddress: BASE_ROUTE.contractAddress,
          midenBridgeId: BASE_ROUTE.midenBridgeId
        }
      }
    };
    const ethRow = (id: string, agglayerRoute: AgglayerRecoveryConfig, amount: bigint) => ({
      id,
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH', agglayerRoute }
    });

    it('recognises a delivery from any listed chain and settles the row made on that chain at its scale', async () => {
      mockSnapshot = snapshotWith(
        { 11155111: [nativeEth('0xagg', 10)], 84532: [nativeEth('0xbase', 8)] },
        { 'base-sepolia': baseSepolia }
      );
      expect(isAgglayerBridgeDelivery('base-sender')).toBe(true);
      mockTransactions.push(ethRow('base', BASE_ROUTE, 5n * 10n ** 8n));

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'base-sender', amount: 5n })
      ).resolves.toMatchObject({ bridgeReceiveTxId: 'base' });
    });

    it('settles a row by the faucet and scale it saved after the document drops its chain', async () => {
      const saved = { ...BASE_ROUTE, nativeEthFaucetId: '0xbase', nativeEthScale: 8 };
      mockTransactions.push(ethRow('saved', saved, 5n * 10n ** 8n));

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
      ).resolves.toBeUndefined();
      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'base-sender', amount: 5n })
      ).resolves.toMatchObject({ bridgeReceiveTxId: 'saved' });
    });

    it('recognises a delivery from the faucet an open row saved after the document drops its chain', async () => {
      const saved = { ...BASE_ROUTE, nativeEthFaucetId: '0xbase', nativeEthScale: 8 };
      const settled = ethRow('settled', saved, 5n);
      settled.extraInputs.phase = 'received';
      mockTransactions.push(settled, { ...ethRow('restored', saved, 5n), restoredFromBackup: true });
      expect((await agglayerDeliverySenders())('base-sender')).toBe(false);

      mockTransactions.push(ethRow('open', saved, 5n));
      const isDelivery = await agglayerDeliverySenders();

      expect(isAgglayerBridgeDelivery('base-sender')).toBe(false);
      expect(isDelivery('base-sender')).toBe(true);
      expect(isDelivery('agg-sender')).toBe(true);
      expect(isDelivery('usdcx-faucet-bech32')).toBe(false);
    });
  });

  it('floors a tracked wei amount at the scale it is given', () => {
    expect(agglayerDeliveredAmount(123_456_789_012_345_678n, 10)).toBe(12_345_678n);
    expect(agglayerDeliveredAmount(123_456_789_012_345_678n, 8)).toBe(1_234_567_890n);
  });

  it('compares at the scale the registry names for the native-ETH faucet', async () => {
    jest.mocked(selectNativeEthToken).mockReturnValueOnce({
      midenFaucetId: '0xagg',
      originToken: '0x0000000000000000000000000000000000000000',
      originNetwork: 0,
      scale: 8
    });
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * 10n ** 8n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  // An E2E sender stands in for the faucet only: the delivery's scale is still the registry's.
  it('matches nothing while the registry names no native-ETH scale, even from an E2E sender', async () => {
    setAgglayerSenderForE2E('cli-faucet');
    try {
      jest.mocked(selectNativeEthToken).mockReturnValueOnce(null);
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'cli-faucet', amount: 5n })
      ).resolves.toBeUndefined();
    } finally {
      setAgglayerSenderForE2E('');
    }
  });

  it('matches a scale-10 delivery to its wei tracker and never the unscaled wei amount', async () => {
    mockTransactions.push({
      id: 'wei',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 100_000_000_000_000_000n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '0.1', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({
        accountId: 'miden-account',
        senderAccountId: 'agg-sender',
        amount: 100_000_000_000_000_000n
      })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 10_000_000n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'wei' });
  });

  it('floors sub-scale dust the way the bridge does', async () => {
    mockTransactions.push({
      id: 'dust',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE + 123n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'dust' });
  });

  it('picks the oldest of two trackers that floor to the same delivery', async () => {
    mockTransactions.push(
      {
        id: 'exact',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'dusty',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE + 999n,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'dusty' });
  });

  it('skips a tracker with no amount', async () => {
    mockTransactions.push(
      {
        id: 'no-amount',
        type: 'bridged-receive',
        accountId: 'miden-account',
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'with-amount',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'with-amount' });
  });

  // A `ready` tracker is never polled again, so its 7-day timeout never fails it: without the bound, a tracker whose
  // delivery came long ago (and went untagged) would take the next deposit of the same amount (#1326).
  it('never adopts a delivery into a tracker older than the delivery window', async () => {
    nowSpy.mockReturnValue((8 * DAY_SEC + 100) * 1000);
    mockTransactions.push({
      id: 'stale',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 50,
      extraInputs: { provider: 'agglayer', phase: 'ready', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();

    mockTransactions.push({
      id: 'fresh',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 8 * DAY_SEC,
      extraInputs: { provider: 'agglayer', phase: 'ready', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'fresh' });
  });
});

describe('takeUsdcxBridgeInInfo', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(() => nowSpy.mockRestore());

  const DEPOSIT_HASH = `0x${'5'.repeat(64)}`;
  const tracker = (overrides: Record<string, unknown> = {}, extraInputs: Record<string, unknown> = {}) => ({
    id: 'row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    amount: 5_000_000n,
    initiatedAt: 1,
    ...overrides,
    extraInputs: {
      provider: 'usdcx',
      phase: 'ready',
      sourceAmount: '5',
      sourceSymbol: 'USDC',
      evmTxHash: DEPOSIT_HASH,
      ...extraInputs
    }
  });
  // The mint: the USDCx faucet sends a note of its own asset. The consume reads both ids in bech32.
  const mint = { accountId: 'miden-account', senderAccountId: 'usdcx-faucet-bech32', faucetId: 'usdcx-faucet-bech32' };

  it('matches the faucet, the account and the amount and selects the oldest attested deposit', async () => {
    mockTransactions.push(
      tracker({ id: 'newer', accountId: 'miden-account_tag', initiatedAt: 2 }),
      tracker({ id: 'older' }, { phase: 'ready' })
    );

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toEqual({
      provider: 'usdcx',
      sourceAmount: '5',
      sourceSymbol: 'USDC',
      evmTxHash: DEPOSIT_HASH,
      bridgeReceiveTxId: 'older'
    });
  });

  // The mint follows the deposit's attestation: an older deposit still waiting on its own leg (a burn the
  // user never executed on Arc) must not take the note of the deposit Circle attested after it.
  it('prefers a deposit Circle attested over an older one still delivering', async () => {
    mockTransactions.push(
      tracker({ id: 'older-unexecuted' }, { phase: 'delivering' }),
      tracker({ id: 'attested', initiatedAt: 2 }, { phase: 'ready' })
    );

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
      bridgeReceiveTxId: 'attested'
    });
  });

  it('falls back to a delivering deposit when none is attested yet', async () => {
    mockTransactions.push(tracker({ id: 'delivering' }, { phase: 'delivering' }));

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
      bridgeReceiveTxId: 'delivering'
    });
  });

  it('leaves an ordinary faucet request alone when no deposit of that amount is open', async () => {
    mockTransactions.push(tracker());

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 100_000_000n })).resolves.toBeUndefined();
  });

  it('never waits for the native asset id when no USDCx deposit is open', async () => {
    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();

    expect(mockGetNativeAssetId).not.toHaveBeenCalled();
  });

  it.each([
    ['another sender', { senderAccountId: 'some-wallet' }],
    ['another asset', { faucetId: 'other-faucet' }],
    ['another account', { accountId: 'other-account' }]
  ])('does not match a note from %s', async (_label, overrides) => {
    mockTransactions.push(tracker());

    await expect(takeUsdcxBridgeInInfo({ ...mint, ...overrides, amount: 5_000_000n })).resolves.toBeUndefined();
  });

  // A row is live for as long as the reconciler tracks it, which can be well past its deposit's first week.
  const EXECUTE_HASH = `0x${'7'.repeat(64)}`;
  it.each<[string, Record<string, unknown>]>([
    ['became ready this week', { phase: 'ready', readyAt: 9 }],
    [
      'saved its Arc execute this week',
      {
        phase: 'delivering',
        sourceChainId: 84532,
        cctp: { sourceDomain: 6, executeTxHash: EXECUTE_HASH, executeSavedAt: 9 }
      }
    ],
    [
      'holds a message to execute',
      { phase: 'delivering', sourceChainId: 84532, cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' } }
    ],
    [
      'had its Arc execute revert this week',
      {
        phase: 'delivering',
        sourceChainId: 84532,
        cctp: { sourceDomain: 6, forwarded: false, revertedExecuteTxHash: EXECUTE_HASH, revertedAt: 9 }
      }
    ]
  ])('takes the mint of an old deposit that %s', async (_label, extraInputs) => {
    mockTransactions.push(tracker({ id: 'old', initiatedAt: -10 * 24 * 60 * 60 }, extraInputs));

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
      bridgeReceiveTxId: 'old'
    });
  });

  // A mint that arrives after its ready row timed out still lands it, after any live deposit of the same amount.
  describe('a deposit that timed out after Circle attested it', () => {
    const timedOut = (overrides: Record<string, unknown> = {}, extraInputs: Record<string, unknown> = {}) =>
      tracker(
        { initiatedAt: -9 * 24 * 60 * 60, ...overrides },
        { phase: 'failed', readyAt: -8 * 24 * 60 * 60, error: 'Bridge delivery timed out.', ...extraInputs }
      );

    it('takes the late mint, past the delivery window', async () => {
      mockTransactions.push(timedOut({ id: 'timed-out' }));

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
        bridgeReceiveTxId: 'timed-out'
      });
    });

    it('yields to a live deposit of the same amount, even one still delivering', async () => {
      mockTransactions.push(
        timedOut({ id: 'timed-out' }),
        tracker({ id: 'live', initiatedAt: 5 }, { phase: 'delivering' })
      );

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toMatchObject({
        bridgeReceiveTxId: 'live'
      });
    });

    it.each([
      ['timed out before Circle attested it', timedOut({}, { readyAt: undefined })],
      ['failed for another reason', timedOut({}, { error: 'Circle attested this deposit to a different amount.' })],
      ['was restored from a backup', timedOut({ restoredFromBackup: true })]
    ])('leaves a failed deposit that %s', async (_label, row) => {
      mockTransactions.push(row);

      await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();
    });
  });

  it.each([
    ['was never broadcast', tracker({}, { evmTxHash: undefined, phase: 'submitting' })],
    ['already received its note', tracker({}, { phase: 'received' })],
    ['failed', tracker({}, { phase: 'failed' })],
    ['was restored from a backup', tracker({ restoredFromBackup: true })],
    ['is past the delivery window', tracker({ initiatedAt: -8 * 24 * 60 * 60 })],
    ['is for another route', tracker({}, { provider: 'agglayer' })]
  ])('does not match a deposit that %s', async (_label, row) => {
    mockTransactions.push(row);

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();
  });
});

describe('applyBridgeInInfoForNotes', () => {
  it('returns the parked info with the resolved note id and bridge-receive link', async () => {
    const info: IBridgeInInfo = {
      provider: 'epoch',
      sourceSymbol: 'USDC',
      sourceAmount: '10',
      intentNonce: 'NONCE1',
      bridgeReceiveTxId: 'TX1'
    };
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', info);
    // Simulate the delivery poll having already learned the note id.
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['note-abc'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1', midenNoteId: 'note-abc', sourceSymbol: 'USDC' });
    // Matched intent leaves the registry.
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  it('matches despite 0x-prefix / casing drift between allocator and SDK note ids', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', bridgeReceiveTxId: 'TX1' });
    // Allocator reports an uppercase, 0x-prefixed id...
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = '0xABCDEF';

    // ...while the consumed note id from the SDK is bare lowercase hex.
    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['abcdef'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1' });
  });

  it('returns undefined when no consumed note matches a pending intent', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch' });
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    expect(await applyBridgeInInfoForNotes(['note-other'], async () => {})).toBe(false);
  });

  describe('while the document names another allocator than the intent saved', () => {
    const SAVED_ALLOCATOR = 'https://allocator.saved';
    beforeEach(() => {
      mockGetEpochReadOnlySdk.mockImplementation(async (_address, saved) => ({
        allocatorUrl: saved ?? 'https://allocator.document'
      }));
      mockReadIntentStatus.mockImplementation(async sdk =>
        sdk.allocatorUrl === SAVED_ALLOCATOR ? [{ midenNoteId: 'note-abc' }] : []
      );
    });
    afterEach(() => {
      mockGetEpochReadOnlySdk.mockImplementation(async () => ({ allocatorUrl: '' }));
      mockReadIntentStatus.mockImplementation(async () => []);
    });

    it.each<[string, IBridgeInInfo]>([
      ['a bridge deposit', { provider: 'epoch', bridgeReceiveTxId: 'TX1', epochAllocatorUrl: SAVED_ALLOCATOR }],
      [
        'an Earn withdrawal',
        { provider: 'epoch', earnWithdrawTxId: 'W1', earnWithdrawAttemptId: 'A1', epochAllocatorUrl: SAVED_ALLOCATOR }
      ]
    ])('polls %s through the allocator it saved', async (_kind, info) => {
      await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', info);

      let result: IBridgeInInfo | undefined;
      const applied = await applyBridgeInInfoForNotes(['note-abc'], async matched => {
        result = matched;
      });

      expect(mockGetEpochReadOnlySdk).toHaveBeenCalledWith(EVM_OWNER, SAVED_ALLOCATOR);
      expect(applied).toBe(true);
      expect(result).toMatchObject({ midenNoteId: 'note-abc', epochAllocatorUrl: SAVED_ALLOCATOR });
    });

    it('gives an intent registered without an allocator the one its tracking row saved, and keeps a saved one', async () => {
      await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', bridgeReceiveTxId: 'TX1' });
      await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', {
        provider: 'epoch',
        bridgeReceiveTxId: 'TX1',
        epochAllocatorUrl: SAVED_ALLOCATOR
      });
      await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', {
        provider: 'epoch',
        bridgeReceiveTxId: 'TX1',
        epochAllocatorUrl: 'https://allocator.other'
      });

      let result: IBridgeInInfo | undefined;
      await applyBridgeInInfoForNotes(['note-abc'], async matched => {
        result = matched;
      });

      expect(mockGetEpochReadOnlySdk).toHaveBeenCalledWith(EVM_OWNER, SAVED_ALLOCATOR);
      expect(result).toMatchObject({ midenNoteId: 'note-abc', epochAllocatorUrl: SAVED_ALLOCATOR });
    });
  });
});

describe('findPendingBridgeInByEarnWithdrawTxId', () => {
  it('returns the NEWEST matching intent when a resubmit left a stale entry for the same row', async () => {
    // Registry after a fail+retry on the same earn-withdraw row: the dead N1 (older,
    // first in the array as it was appended first) and the live N2 (newer). The lookup
    // must return N2 — returning the first match (N1) would re-strand the row on a dead
    // nonce, which is exactly the bug this ordering guards against.
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 2000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      },
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N2',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toEqual({
      intentNonce: 'N2',
      userAddress: EVM_OWNER
    });
  });

  it('returns undefined when no pending intent references the row', async () => {
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'OTHER' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toBeUndefined();
  });
});

describe('suppressedLinkedConsumeIds', () => {
  it('suppresses existing linked primaries but NOT a terminal-failed earn-withdraw row', async () => {
    // A live withdraw row is the single trace (suppress its consume). A FAILED withdraw
    // row is not — its delivered note must fall through to a visible receive — so it is
    // excluded even though it exists. Non-earn-withdraw primaries suppress on existence.
    // 'MISSING' has no row (the query returns only existing rows) so it is absent.
    mockAnyOfToArray.mockResolvedValue([
      { id: 'LIVE', type: 'earn-withdraw', extraInputs: { phase: 'delivering', evmOwner: EVM_OWNER } },
      { id: 'FAILED', type: 'earn-withdraw', extraInputs: { phase: 'failed' } },
      { id: 'SWAP', type: 'swap', extraInputs: {} }
    ]);

    const consumes: ITransaction[] = ['LIVE', 'FAILED', 'SWAP', 'MISSING'].map(id => ({
      id: `consume-${id}`,
      type: 'consume',
      accountId: 'account',
      status: 2,
      displayIcon: 'RECEIVE',
      initiatedAt: 1,
      extraInputs: id === 'SWAP' ? { swapOrderTxId: id } : { bridgeIn: { provider: 'epoch', earnWithdrawTxId: id } }
    }));
    const result = await suppressedLinkedConsumeIds(consumes);

    expect(result).toEqual(new Set(['consume-LIVE', 'consume-SWAP']));
  });

  it('short-circuits on an empty id list', async () => {
    const result = await suppressedLinkedConsumeIds([]);
    expect(result).toEqual(new Set());
    expect(mockAnyOfToArray).not.toHaveBeenCalled();
  });
});

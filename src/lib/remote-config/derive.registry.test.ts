import { NotDeployedError, readBridgeRegistry } from './derive';

type U64s = readonly bigint[];
interface FakeEntry {
  key: U64s;
  value: U64s;
}

const mockGetAccountProof = jest.fn();
const mockSyncStorageMaps = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (id: string) => ({ id }) },
  AccountStorageRequirements: { fromSlotAndKeysArray: (slots: unknown[]) => ({ slots }) },
  Endpoint: jest.fn(),
  RpcClient: jest.fn(() => ({ getAccountProof: mockGetAccountProof, syncStorageMaps: mockSyncStorageMaps })),
  SlotAndKeys: class {
    constructor(
      readonly slot: string,
      readonly keys: unknown[]
    ) {}
  }
}));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn() }));

const RPC = 'https://rpc.testnet.miden.io';
const BRIDGE = '0x3b66e20b5088f25133b69216484652';
const REGISTRY = 'agglayer::bridge::faucet_registry_map';
const METADATA = 'agglayer::bridge::faucet_metadata_map';

// The live testnet bridge at block 693275 on 2026-10-03: getAccountProof with both maps requested
// whole, each key and value as Word.toU64s(). Native ETH has no metadata sub-key 0 entry: its address
// limbs are all zero, so the map holds nothing there.
const TESTNET_NETWORK_ID: U64s = [0x56n, 0x0n, 0x0n, 0x0n];
const TESTNET_REGISTRY: FakeEntry[] = [
  { key: [0x0n, 0x0n, 0x216d995bf29b9100n, 0xb372f2735e33e91n], value: [0x1n, 0x0n, 0x0n, 0x0n] },
  { key: [0x0n, 0x0n, 0x2f35bf507c61e00n, 0x36bb3163d7ef0ad1n], value: [0x1n, 0x0n, 0x0n, 0x0n] },
  { key: [0x0n, 0x0n, 0x826e9cf7d8bc000n, 0x699b06a0fb524c11n], value: [0x1n, 0x0n, 0x0n, 0x0n] },
  { key: [0x0n, 0x0n, 0x4510d371c65a5800n, 0xaef9b3cd67458ad1n], value: [0x1n, 0x0n, 0x0n, 0x0n] }
];
const TESTNET_METADATA: FakeEntry[] = [
  { key: [0x1n, 0x0n, 0x216d995bf29b9100n, 0xb372f2735e33e91n], value: [0x0n, 0x0n, 0xan, 0x0n] },
  {
    key: [0x2n, 0x0n, 0x216d995bf29b9100n, 0xb372f2735e33e91n],
    value: [0x146d2c5n, 0x3c23f786n, 0xb27d7e92n, 0xc003c7dcn]
  },
  {
    key: [0x3n, 0x0n, 0x216d995bf29b9100n, 0xb372f2735e33e91n],
    value: [0x53b600e5n, 0x3b2782can, 0x4d8fa7bn, 0x70a4855dn]
  },
  {
    key: [0x0n, 0x0n, 0x2f35bf507c61e00n, 0x36bb3163d7ef0ad1n],
    value: [0xd7ffb42bn, 0x32d4c6e2n, 0x4e5597b6n, 0x13fa77fdn]
  },
  { key: [0x1n, 0x0n, 0x2f35bf507c61e00n, 0x36bb3163d7ef0ad1n], value: [0x69fdbebdn, 0x0n, 0xan, 0x0n] },
  {
    key: [0x2n, 0x0n, 0x2f35bf507c61e00n, 0x36bb3163d7ef0ad1n],
    value: [0x1f84aa5fn, 0x70118326n, 0x71f5209en, 0x5ae7be82n]
  },
  {
    key: [0x3n, 0x0n, 0x2f35bf507c61e00n, 0x36bb3163d7ef0ad1n],
    value: [0x57cca39bn, 0x6641a85cn, 0xac8f221cn, 0x71665aban]
  },
  {
    key: [0x0n, 0x0n, 0x826e9cf7d8bc000n, 0x699b06a0fb524c11n],
    value: [0x54a7860cn, 0xc41497a2n, 0x136f9cfen, 0x9970fa59n]
  },
  { key: [0x1n, 0x0n, 0x826e9cf7d8bc000n, 0x699b06a0fb524c11n], value: [0xb4c17edn, 0x0n, 0xan, 0x0n] },
  {
    key: [0x2n, 0x0n, 0x826e9cf7d8bc000n, 0x699b06a0fb524c11n],
    value: [0x29367226n, 0x55eb90f8n, 0x330a467dn, 0x5b15a940n]
  },
  {
    key: [0x3n, 0x0n, 0x826e9cf7d8bc000n, 0x699b06a0fb524c11n],
    value: [0x25017b18n, 0x39473b00n, 0xe3bb2aben, 0xb984af3n]
  },
  {
    key: [0x0n, 0x0n, 0x4510d371c65a5800n, 0xaef9b3cd67458ad1n],
    value: [0x194b7d1cn, 0xb0c7b06cn, 0xbc3f741dn, 0x2a91661n]
  },
  { key: [0x1n, 0x0n, 0x4510d371c65a5800n, 0xaef9b3cd67458ad1n], value: [0x38729c37n, 0x0n, 0x0n, 0x0n] },
  {
    key: [0x2n, 0x0n, 0x4510d371c65a5800n, 0xaef9b3cd67458ad1n],
    value: [0x627430dbn, 0x2924d438n, 0x96da5cdn, 0x6ae922ban]
  },
  {
    key: [0x3n, 0x0n, 0x4510d371c65a5800n, 0xaef9b3cd67458ad1n],
    value: [0xaf7b47e5n, 0x1f2d1677n, 0xdc43c520n, 0x146c1fabn]
  }
];

const ETH = {
  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
  originToken: '0x0000000000000000000000000000000000000000',
  originNetwork: 0,
  scale: 10
};
const USDC = {
  midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e',
  originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  originNetwork: 0,
  scale: 10
};
const TRNSK = {
  midenFaucetId: '0x699b06a0fb524c110826e9cf7d8bc0',
  originToken: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
  originNetwork: 0,
  scale: 10
};
const CIRCLE_USDC = {
  midenFaucetId: '0xaef9b3cd67458ad14510d371c65a58',
  originToken: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  originNetwork: 0,
  scale: 0
};

const word = (u64s: U64s) => ({ toU64s: () => BigUint64Array.from(u64s) });
const entry = ({ key, value }: FakeEntry) => ({ key: () => word(key), value: () => word(value) });

function proof({
  networkId = TESTNET_NETWORK_ID,
  maps = { [REGISTRY]: TESTNET_REGISTRY, [METADATA]: TESTNET_METADATA },
  tooMany = []
}: { networkId?: U64s | null; maps?: Record<string, FakeEntry[]>; tooMany?: string[] } = {}) {
  return {
    getStorageSlotValue: (slot: string) =>
      slot === 'agglayer::bridge::network_id' && networkId ? word(networkId) : undefined,
    getStorageMapEntries: (slot: string) => (tooMany.includes(slot) ? [] : maps[slot]?.map(entry)),
    hasStorageMapTooManyEntries: (slot: string) => (slot in maps ? tooMany.includes(slot) : undefined)
  };
}

const requested = (call: number): { slots: unknown[] } | undefined => mockGetAccountProof.mock.calls[call]?.[1];
const notFound = (id: string) =>
  new Error(
    `failed to get account proof: grpc request failed for get_account: invalid request parameters: code: ` +
      `'Client specified an invalid argument', message: "account ${id} not found at block 693233"`
  );

beforeEach(() => {
  mockGetAccountProof.mockReset().mockResolvedValue(proof());
  mockSyncStorageMaps.mockReset();
});

describe('readBridgeRegistry', () => {
  it('decodes the live testnet registry', async () => {
    await expect(readBridgeRegistry(BRIDGE, RPC)).resolves.toEqual({
      rollupId: 86,
      tokens: [ETH, USDC, TRNSK, CIRCLE_USDC]
    });
  });

  it('asks for the two registry maps whole and nothing else', async () => {
    await readBridgeRegistry(BRIDGE, RPC);
    expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
    expect(mockGetAccountProof.mock.calls[0]?.[0]).toEqual({ id: BRIDGE });
    expect(requested(0)?.slots).toEqual([
      { slot: REGISTRY, keys: [] },
      { slot: METADATA, keys: [] }
    ]);
  });

  it('retries a failed read with fresh SDK arguments', async () => {
    mockGetAccountProof.mockRejectedValueOnce(new Error('timeout'));
    await expect(readBridgeRegistry(BRIDGE, RPC)).resolves.toMatchObject({ rollupId: 86 });
    expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
    expect(requested(1)).not.toBe(requested(0));
  });

  it('reads the maps through syncStorageMaps when the proof cannot carry them', async () => {
    mockGetAccountProof.mockResolvedValue(proof({ tooMany: [REGISTRY] }));
    const update = (slot: string, { key, value }: FakeEntry) => ({
      slotName: () => slot,
      key: () => word(key),
      value: () => word(value)
    });
    const deregistered: FakeEntry = { key: [0n, 0n, 0x1100n, 0x22n], value: [0n, 0n, 0n, 0n] };
    mockSyncStorageMaps.mockResolvedValue({
      updates: () => [
        update('agglayer::bridge::ger_map', { key: [1n, 2n, 3n, 4n], value: [1n, 0n, 0n, 0n] }),
        ...TESTNET_REGISTRY.map(item => update(REGISTRY, item)),
        update(REGISTRY, deregistered),
        ...TESTNET_METADATA.map(item => update(METADATA, item))
      ]
    });
    await expect(readBridgeRegistry(BRIDGE, RPC)).resolves.toEqual({
      rollupId: 86,
      tokens: [ETH, USDC, TRNSK, CIRCLE_USDC]
    });
    expect(mockSyncStorageMaps).toHaveBeenCalledWith(0, undefined, { id: BRIDGE });
  });

  it('skips a faucet whose metadata does not fit its types', async () => {
    const [usdcLo, ...rest] = TESTNET_METADATA.filter(item => item.key[3] === 0x36bb3163d7ef0ad1n);
    const others = TESTNET_METADATA.filter(item => item.key[3] !== 0x36bb3163d7ef0ad1n);
    const oversized: FakeEntry = { key: usdcLo!.key, value: [0x1_0000_0000n, 0n, 0n, 0n] };
    mockGetAccountProof.mockResolvedValue(
      proof({ maps: { [REGISTRY]: TESTNET_REGISTRY, [METADATA]: [...others, oversized, ...rest] } })
    );
    await expect(readBridgeRegistry(BRIDGE, RPC)).resolves.toEqual({ rollupId: 86, tokens: [ETH, TRNSK, CIRCLE_USDC] });
  });

  it('rejects a network id that is not a u32', async () => {
    mockGetAccountProof.mockResolvedValue(proof({ networkId: [0x1_0000_0000n, 0n, 0n, 0n] }));
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.toThrow('not a u32');
  });

  it('reports a bridge account the node does not have as not deployed', async () => {
    mockGetAccountProof.mockRejectedValue(notFound(BRIDGE));
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.toBeInstanceOf(NotDeployedError);
  });

  it('reports an account without the bridge slots as not deployed', async () => {
    mockGetAccountProof.mockResolvedValue(proof({ networkId: null }));
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.toBeInstanceOf(NotDeployedError);
    mockGetAccountProof.mockResolvedValue(proof({ maps: { [METADATA]: TESTNET_METADATA } }));
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.toBeInstanceOf(NotDeployedError);
  });

  it('passes any other failure through, a not-found for another account included', async () => {
    mockGetAccountProof.mockRejectedValue(notFound('0x537c15a622174e91188aa894456c53'));
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.not.toBeInstanceOf(NotDeployedError);
    mockGetAccountProof.mockRejectedValue('transport closed');
    await expect(readBridgeRegistry(BRIDGE, RPC)).rejects.toBe('transport closed');
  });
});

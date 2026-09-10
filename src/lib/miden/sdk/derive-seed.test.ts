/**
 * Fixed vectors for Miden coin type 5063758 and the BIP-39 test mnemonic,
 * independently calculated with Python hashlib/hmac. Any derivation change
 * changes the keys a phrase recovers.
 *
 * `bip39` is mocked as a pass-through so the memoization in
 * `makeColdSeedDeriver` can be asserted; every value it returns is the real
 * one.
 */
import { mnemonicToSeedSync } from 'bip39';

import { WalletType } from 'screens/onboarding/types';

import { deriveClientSeed, getMainDerivationPath, makeColdSeedDeriver, walletTypeIndex } from './derive-seed';

jest.mock('bip39', () => {
  const actual = jest.requireActual<typeof import('bip39')>('bip39');
  return { ...actual, mnemonicToSeedSync: jest.fn(actual.mnemonicToSeedSync) };
});

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Golden vectors: `deriveClientSeed(type, MNEMONIC, index)` as hex, indices 0..2. */
const GOLDEN: [WalletType, string[]][] = [
  [
    WalletType.OnChain,
    [
      'f7da87e8f31b13cdcf9f33ea5cdbb30c98fe3dfa3264b5b30414a0a706f21b69',
      'ae14c27a3b4048e99f5d64afbbf223a55beb131538410370ea65a905fcefa990',
      'ef4d45ca9a518c359be1fb8821323bc9a0749c0dda06808f7a9cc4fb5168a9af'
    ]
  ],
  [
    WalletType.OffChain,
    [
      '5b7fe8239812224089db81abf34d8f51202c7bb7568ed7055839362b9710a01e',
      'bb8ac79584f4a9e181e8defbe775359bee49898edeb5d6b00e4817f29ff656ea',
      'd6e2114c59cd783dfb5121f1f280c894f3ff74159d934e9d8713b525b4bde4c9'
    ]
  ],
  [
    WalletType.Guardian,
    [
      '20b91b26e522c31416d41a0c77ea21cd91f9ed7c96faca6ad6cce9d600a7d5a0',
      '7f38a42409d09858965d823bb256c4bdcdff426e23f25cd268adec62b8ffb50d',
      '51f0f61940f75938f1cdf5b6cff5e333233ae3a1c23dce5c5a86090ff4cac442'
    ]
  ]
];

const goldenFor = (walletType: WalletType): string[] => GOLDEN.find(([type]) => type === walletType)![1];

/**
 * Launder a raw string into the `WalletType` position without a type
 * assertion, so the "unknown wallet type" guard stays reachable from a test
 * even though the typed API can never produce that value.
 */
const asRuntimeWalletType = (raw: string): WalletType => JSON.parse(JSON.stringify(raw));

beforeEach(() => {
  jest.mocked(mnemonicToSeedSync).mockClear();
});

describe('walletTypeIndex', () => {
  it('namespaces each wallet type to its own BIP-44 account branch', () => {
    expect(walletTypeIndex(WalletType.OnChain)).toBe(0);
    expect(walletTypeIndex(WalletType.OffChain)).toBe(1);
    expect(walletTypeIndex(WalletType.Guardian)).toBe(2);
  });

  it('throws on an unknown wallet type rather than silently deriving branch 0', () => {
    expect(() => walletTypeIndex(asRuntimeWalletType('not-a-wallet-type'))).toThrow('Invalid wallet type');
  });
});

describe('getMainDerivationPath', () => {
  it('builds a hardened path using the Miden coin type and wallet namespace', () => {
    expect(getMainDerivationPath(WalletType.Guardian, 0)).toBe("m/44'/5063758'/2'/0'");
    expect(getMainDerivationPath(WalletType.OnChain, 5)).toBe("m/44'/5063758'/0'/5'");
  });
});

describe('deriveClientSeed', () => {
  it.each(GOLDEN)('matches the Miden coin type golden vectors for %s', (walletType, expectedPerIndex) => {
    expectedPerIndex.forEach((expected, hdIndex) => {
      expect(toHex(deriveClientSeed(walletType, MNEMONIC, hdIndex))).toBe(expected);
    });
  });

  it('returns 32 bytes', () => {
    expect(deriveClientSeed(WalletType.Guardian, MNEMONIC, 0)).toHaveLength(32);
  });
});

describe('makeColdSeedDeriver', () => {
  it('is byte-identical to deriveClientSeed across indices', () => {
    const derive = makeColdSeedDeriver(MNEMONIC);
    for (let hdIndex = 0; hdIndex < 3; hdIndex++) {
      expect(toHex(derive(hdIndex))).toBe(toHex(deriveClientSeed(WalletType.Guardian, MNEMONIC, hdIndex)));
    }
  });

  it('defaults to the Guardian branch and honours an explicit wallet type', () => {
    expect(toHex(makeColdSeedDeriver(MNEMONIC)(0))).toBe(goldenFor(WalletType.Guardian)[0]);
    expect(toHex(makeColdSeedDeriver(MNEMONIC, WalletType.OnChain)(0))).toBe(goldenFor(WalletType.OnChain)[0]);
  });

  it('pays the PBKDF2 cost once, not once per index', () => {
    const derive = makeColdSeedDeriver(MNEMONIC);
    // Lazy: nothing is derived until the first call.
    expect(jest.mocked(mnemonicToSeedSync)).not.toHaveBeenCalled();

    derive(0);
    derive(1);
    derive(2);

    expect(jest.mocked(mnemonicToSeedSync)).toHaveBeenCalledTimes(1);
  });
});

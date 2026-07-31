/**
 * Regression gate for the HD derivation lifted out of `lib/miden/back/vault.ts`
 * so the guardian auto-detect probe can reuse it (issue #418).
 *
 * These vectors are the load-bearing part: the derivation decides which keys —
 * and therefore which accounts — a seed phrase recovers. Changing any byte here
 * silently orphans every existing wallet, so the expectations are pinned to the
 * literal output of the pre-refactor implementation for the BIP-39 test
 * mnemonic, not recomputed from the code under test.
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
      '7303bce3fd710072aec3c0b0564f061d3771c3c10a2e023cacdedcf5d2ce6b72',
      '7932bbdd42852773ef2642e5cc65e0e19e577e433be7e9247b8ee881dfb24190',
      '48be5f28eb6461028a215f96bf880a82d8b3caa89a9c9c94197e392795f782e7'
    ]
  ],
  [
    WalletType.OffChain,
    [
      '835fe3da130bac3825f5d0c9526ac400c54f9a5df8f7e9c38219b02cefc1a162',
      'd8f603ff4fdaedc4ab26fb9ce5b9012a232d7a546f90ab7d956ba3ba5d3c20eb',
      '0a4bbcdce48cd0191f21426989ba2ebba133527d859f24ba24c5b5a8fb6bfb34'
    ]
  ],
  [
    WalletType.Guardian,
    [
      '355dc73d10996cfff18a140266c04b4768b27b14483b876b81c7087b4317df72',
      'ed319149e2f07ad5fd1543a8620ab3e99aa2e8a2d5cfe668ed16d6d5fc232f2d',
      '145d6c1cfc1674a9b7a841fc20eaeb621b4e6b7fbbe676c9292deccc981d166c'
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
  it('builds a hardened BIP-44 path namespaced by wallet type', () => {
    expect(getMainDerivationPath(WalletType.Guardian, 0)).toBe("m/44'/0'/2'/0'");
    expect(getMainDerivationPath(WalletType.OnChain, 5)).toBe("m/44'/0'/0'/5'");
  });
});

describe('deriveClientSeed', () => {
  it.each(GOLDEN)('matches the pre-refactor golden vectors for %s', (walletType, expectedPerIndex) => {
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

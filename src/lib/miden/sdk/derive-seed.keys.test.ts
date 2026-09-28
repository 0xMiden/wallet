/**
 * @jest-environment node
 */

/**
 * Pins the keys the SDK makes from the golden seeds.
 *
 * `derive-seed.test.ts` freezes the 32-byte seed that each scheme derives. A
 * seed is not a key. The wallet gives it to `AuthSecretKey.ecdsaWithRNG` or
 * `AuthSecretKey.rpoFalconWithRNG`, and the SDK makes the key from it. This
 * test freezes that second step. For each golden seed it pins the public key
 * commitment, and for ECDSA also the serialized `AuthSecretKey`. The
 * commitment is the value the wallet compares with the signer on chain. A
 * change to it orphans the account. Do not recompute these literals from the
 * code under test.
 *
 * The `legacy` seed has no auth-scheme level, so one legacy seed gives both an
 * ECDSA key and a Falcon key. Both are pinned. The ECDSA key is the one the
 * seed-phrase restore probes. The Falcon key is the one the oldest accounts
 * used, and only an encrypted-file backup restores it.
 *
 * The unit-test module map replaces `@miden-sdk/miden-sdk` with a mock, and
 * the WASM bundle does not run under Jest. The SDK's Node build is a native
 * addon made from the same Rust code, so this test loads that addon directly.
 * The addon takes plain number arrays, not `Uint8Array`. The addon packages
 * are optional dependencies of the SDK, one per platform. CI runs on Linux
 * x64, where the package is installed, and a CI runner without a package is
 * an error. On a developer platform with no package the suite is skipped.
 */
import type { KeyDerivation } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { deriveClientSeed } from './derive-seed';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

interface NativeWord {
  toHex(): string;
}

interface NativeAuthSecretKey {
  serialize(): Uint8Array;
  getPublicKeyAsWord(): NativeWord;
}

interface NativeSdk {
  AuthSecretKey: {
    ecdsaWithRNG(seed: number[]): NativeAuthSecretKey;
    rpoFalconWithRNG(seed: number[]): NativeAuthSecretKey;
  };
}

/** The SDK's per-platform native addon packages, as `js/node/loader.js` in the SDK names them. */
const NATIVE_SDK_PACKAGES: Partial<Record<string, string>> = {
  'darwin-arm64': '@miden-sdk/node-darwin-arm64',
  'darwin-x64': '@miden-sdk/node-darwin-x64',
  'linux-x64': '@miden-sdk/node-linux-x64-gnu'
};

const platformKey = `${process.platform}-${process.arch}`;
const nativeSdkPackage = NATIVE_SDK_PACKAGES[platformKey];

if (nativeSdkPackage === undefined && process.env.CI === 'true') {
  throw new Error(`The SDK has no native addon for ${platformKey}, so the key vectors cannot run on this CI runner.`);
}

const requireNativeSdk = (): NativeSdk => {
  if (nativeSdkPackage === undefined) {
    throw new Error(`The SDK has no native addon for ${platformKey}.`);
  }
  return jest.requireActual<NativeSdk>(nativeSdkPackage);
};

const describeWithNativeSdk = nativeSdkPackage === undefined ? describe.skip : describe;

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

interface EcdsaKeyVector {
  keyDerivation: KeyDerivation;
  walletType: WalletType;
  hdIndex: number;
  /** `AuthSecretKey.serialize()` as hex: the `0x01` scheme tag and the 32-byte scalar. */
  secretKey: string;
  /** `AuthSecretKey.getPublicKeyAsWord().toHex()`: the signer commitment. */
  commitment: string;
}

interface FalconKeyVector {
  keyDerivation: KeyDerivation;
  walletType: WalletType;
  hdIndex: number;
  /** `AuthSecretKey.getPublicKeyAsWord().toHex()`: the signer commitment. */
  commitment: string;
}

/** ECDSA keys: every legacy seed, and every `v1` seed on the ecdsa path level. */
const ECDSA_KEY_VECTORS: EcdsaKeyVector[] = [
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 0,
    secretKey: '01ed4acae9b89998c7a4ed71a7da44d572d299ecb3807eec917fdc5c7e5423553a',
    commitment: '0xfb4313b9e352788bc04ff4f28d7c3ff0877f448338f5e07138a6bd10dd9e4377'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 1,
    secretKey: '01865e2f35a0877d0c15702ad34b3034be61ace9f608f9178da07852289d3c61ca',
    commitment: '0xb2aae1fbdbe9ced9dd37ff54064fc6cd17cb269a4721b02400a43cf4d763e01d'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 2,
    secretKey: '01618abe227ef2b2548ac4bb77eadd5ec06a60e7abb1c1b6f26b7059a047af365a',
    commitment: '0x800f370b30a4e4dd26345b9af448cdbde93a2ce27148fac67c0bb02daf8a2470'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 0,
    secretKey: '018e2e0b23660074368b025b74fe673e73524d85731439a856da7fe314c1b157df',
    commitment: '0xc6b98d1b421373eee0e915899c21a3d819693e6eb9eea8ecd4bf928207494061'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 1,
    secretKey: '0149d972f9dfd89b87003e1267c5087cfc2736ae93c87b9678205a4c4683c6351b',
    commitment: '0x38b338dab1aa46acb03b8a409d4b9c2a569d7cd65ab1948af883846dc3734ef7'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 2,
    secretKey: '01a9feee164eab554c383b9935771036e858302b44c3b79ebe7c9f75b228e03956',
    commitment: '0xeb776c9f68547ae79bcd09055549a42bf2fc49bf42c4d6265398fcec43e36803'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 0,
    secretKey: '019850db3b39a4364bdd60476a94e30f7c00520edc02ccfcdd3fc447413435a780',
    commitment: '0x03331bcf85ee6218b7b92796e1b9a42154d639eff98fd8c1752bc64453d1cfdf'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 1,
    secretKey: '0121c843bc426014fa26be5467a5bfcbeafe1efdacd8083a5af0842d51e0111c3c',
    commitment: '0xc55ca50a5f6ceed2e12c4551527864fdd12d10b74b2ee387cb6bc523111a8360'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 2,
    secretKey: '017e7626be3da8a306d21ce7299ad191481f32cb7bcea7820e259a6b29b650b5fd',
    commitment: '0xe0691c9994ab8f6ad175e3c3a957e9a4066a8e58594ad86cc85e89ac700c844e'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 0,
    secretKey: '016dcb2ceed601ed4b25dc5956504c254e36b901246e6497e2aacbbc5b19b64b35',
    commitment: '0xf396ab0438b6384dbc586806756e5f8330ab56e18ee09f861c4527bf8f61e357'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 1,
    secretKey: '01d51f93285f0dcf52e9f712ea8dd8c85f5e101421e07420ed663f98ee2d027158',
    commitment: '0xba6c4f0938ca8b4486ea4c12da19b0b888070577803a8dfa5582679ffde19b8d'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 2,
    secretKey: '0108df7b6ea321e364cecef5d323cd68b6fde557ef3aa4f44efd88a7f5ef342bef',
    commitment: '0xcad16f9206780f80646d2f77377b5fc2d2427143ddf4c72ad8ab904c2ed5d95d'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 0,
    secretKey: '019b35949e68654f22a82e80c670383836eceade48158b8bdaf88d1b4066b1f970',
    commitment: '0xec709ca91c86e7ac3595a32003b5af438a5f57524ddf6cab1ea56d679de28530'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 1,
    secretKey: '0164bbb8ca33250b41c995508f05bf57ea06eafa41766ba9fba348407fa90b2707',
    commitment: '0x36191e5acff18a1ca8a2d85621427b8b38bb96d174443df77b84f9afe50e4638'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 2,
    secretKey: '01354c883b80b2e1ad61ab5d9b11fa7b2ba6820782d359abc03bdfe67e677df58c',
    commitment: '0x35da62ee176f1ed282bfaf009b7e3e23934918721c24e4c5766da1ae6f92145d'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 0,
    secretKey: '0148b9c116bcabaa324310c2850870a190def85dfb5dd66e0171266ac99ae725f5',
    commitment: '0xc697df76f2ce096a26ad4347b5ca65ea2b124f327baf8d3f0ff032aa9c1961a9'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 1,
    secretKey: '01482f879f243c09744aa31ed53745bbc41b68ed432a8e93e75a4ec64242495078',
    commitment: '0x9d6ba019b864e8a7ad4f562e79b267693fa3ab1aad1616d462e3bba223b51d5b'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 2,
    secretKey: '0195f4958fe39f17e1a229b5c677b57eaf2e1343fe0f33faab77d0e2a5df7baa70',
    commitment: '0x72acc6602da93095be976775d73b54363fa71fb837c5c9b83f64792b18fe760c'
  }
];

/** Falcon keys: every legacy seed, and every `v1` seed on the falcon path level. */
const FALCON_KEY_VECTORS: FalconKeyVector[] = [
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 0,
    commitment: '0x03c11dc89dd51cd8442d2d26cff54f3514fb1e54df5a4d5be37f6b2f947cebbb'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 1,
    commitment: '0x77cf0ce04b85da4aca71ef9e8ddac361bf8722c255eb19c2df1a1f5787fac63a'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OnChain,
    hdIndex: 2,
    commitment: '0x976f1305b84cc9dc61caf9757938c5f00091bc455cf2baa810872a9bbd267e11'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 0,
    commitment: '0xf981a0f25e1624110bfc9d9fba017905e7cf5edb9528e9daa19a5d56832bdc15'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 1,
    commitment: '0x70abc853aa1d19c1d44f15bc1f72195ab25868c7e846ad0202dda7e428517091'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.OffChain,
    hdIndex: 2,
    commitment: '0x6488a9b23a09bd4b947ac7f072e7361dfab9a59cc1046fa1ff0e7f952a4f1b53'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 0,
    commitment: '0x2585eea303c3934da6f9c8e6ae12b2bb0d8564f06d1a59a91b34b25ccaf0994c'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 1,
    commitment: '0x2cfcd4bbb8fdeff590ab696b9819f98980e678d0644346516ccff35b4774653c'
  },
  {
    keyDerivation: 'legacy',
    walletType: WalletType.Guardian,
    hdIndex: 2,
    commitment: '0xf05bb85ca59fdafea71ac35cc5312463a04bce52dd4e9ed810b5fe9909b6d375'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 0,
    commitment: '0xbb880a0996ddb03b4f2aa81b4946a9aa6e0a66f436dc01f13caec2e24a48a597'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 1,
    commitment: '0x0e91fdb4a6e326c6a123ac2b60fb0c78324eb76952250f63a481e2f89bb1b515'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OnChain,
    hdIndex: 2,
    commitment: '0xa1e98e5d305f2398966e79b9ee7c090b1877c6d779536fc880d537de9e085455'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 0,
    commitment: '0x0b6b47a9aaa19b6d68f081d070f8fc3507e57057b498150cfe4b82646384f922'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 1,
    commitment: '0xa1d7185a48f1272c8721f5c15610e4e39a30e69a07f513afdcd18d0a8ae5fe7d'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.OffChain,
    hdIndex: 2,
    commitment: '0x2822104ee2804e06c947c4852733a8da44e28984c1cd38d721635a98e3c55096'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 0,
    commitment: '0xc5e23b1eae04c938769ba4fb8496466e9e0858bb7b2b1177718f2b2ddfb53743'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 1,
    commitment: '0x2a1513ce60a761eaad13b2b1bda06ceae3ae27c40c246cd96356d4577cfe048a'
  },
  {
    keyDerivation: 'v1',
    walletType: WalletType.Guardian,
    hdIndex: 2,
    commitment: '0x4339896090968d7b2bafbc04a4f2433d8b21c6beafac821e25790de138c385af'
  }
];

/** `AuthSecretKey.ecdsaWithRNG` on the all-zero seed. A reduction of zero bytes would be no key. */
const ZERO_SEED_ECDSA_SECRET_KEY = '019bf49a6a0755f953811fce125f2683d50429c3bb49e074147e0089a52eae155f';

describeWithNativeSdk('SDK keys from the golden seeds', () => {
  let sdk: NativeSdk;

  beforeAll(() => {
    sdk = requireNativeSdk();
  });

  it.each(ECDSA_KEY_VECTORS)(
    'makes the pinned ECDSA key from the $keyDerivation $walletType seed at index $hdIndex',
    ({ keyDerivation, walletType, hdIndex, secretKey, commitment }) => {
      const seed = deriveClientSeed(MNEMONIC, { keyDerivation, walletType, authScheme: 'ecdsa', hdIndex });
      const key = sdk.AuthSecretKey.ecdsaWithRNG(Array.from(seed));

      expect(toHex(key.serialize())).toBe(secretKey);
      expect(key.getPublicKeyAsWord().toHex()).toBe(commitment);
    }
  );

  it.each(FALCON_KEY_VECTORS)(
    'makes the pinned Falcon key from the $keyDerivation $walletType seed at index $hdIndex',
    ({ keyDerivation, walletType, hdIndex, commitment }) => {
      const seed = deriveClientSeed(MNEMONIC, { keyDerivation, walletType, authScheme: 'falcon', hdIndex });
      const key = sdk.AuthSecretKey.rpoFalconWithRNG(Array.from(seed));

      expect(key.getPublicKeyAsWord().toHex()).toBe(commitment);
    }
  );

  it('uses the seed to start an RNG and does not use the seed bytes as the scalar', () => {
    const seed = deriveClientSeed(MNEMONIC, {
      keyDerivation: 'legacy',
      walletType: WalletType.OnChain,
      authScheme: 'ecdsa',
      hdIndex: 0
    });
    const key = sdk.AuthSecretKey.ecdsaWithRNG(Array.from(seed));
    const scalar = toHex(key.serialize()).slice(2);

    expect(scalar).toHaveLength(64);
    expect(scalar).not.toBe(toHex(seed));
    expect(toHex(sdk.AuthSecretKey.ecdsaWithRNG(new Array<number>(32).fill(0)).serialize())).toBe(
      ZERO_SEED_ECDSA_SECRET_KEY
    );
  });
});

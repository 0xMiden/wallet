/**
 * Login key tests for `lib/miden/back/vault.ts`: which root key `loginKeyCommitment` and `signWithLoginKey` resolve
 * for each kind of account and device, when they refuse, and that a call frees every key handle and zeroes the root
 * and the scalar.
 *
 * The SDK is a stand-in on noble's secp256k1: its keys and its `[0x01, r, s, v]` signatures over keccak256 of the
 * word they sign are real ECDSA, while the commitment and Poseidon2 are stand-in hashes. Most tests start from a
 * Guardian wallet spawned from the Hardhat/Anvil test mnemonic, whose account 0 EVM key is m/44'/60'/2'/0/0.
 */

import { AuthSecretKey, PublicKey, Word } from '@miden-sdk/miden-sdk/lazy';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes } from '@noble/hashes/utils';
import { mnemonicToAccount } from 'viem/accounts';

import { deserializeHotSecretKey } from 'lib/miden/guardian/hot-key-import';
import { deriveLoginKeyScalar, type LoginKeySource } from 'lib/miden/login-key/derive';
import * as Passworder from 'lib/miden/passworder';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { encryptAndSaveMany, fetchAndDecryptOne, removeMany } from './safe-storage';
import { Vault } from './vault';

// A Guardian spawn, a restore and a key-QR import each run the production PBKDF2 key derivation (~10.3M SHA-256
// iterations), which under full-suite CPU contention on CI takes several seconds.
jest.setTimeout(60_000);

const memoryStore: Record<string, any> = {};
// The storage keys every read asked for, wrapped as safe-storage stores them.
const mockStorageReads: string[] = [];
const mockStorageRead = jest.fn(async (keys: string[]) => {
  mockStorageReads.push(...keys);
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in memoryStore) out[k] = memoryStore[k];
  return out;
});
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: jest.fn(() => ({
    get: mockStorageRead,
    set: async (items: Record<string, any>) => {
      Object.assign(memoryStore, items);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete memoryStore[k];
    }
  })),
  StorageProvider: class {}
}));

// Every handle the stand-in SDK has handed out and not yet freed.
const mockLiveHandles = new Set<object>();
// Every Poseidon2 hash the stand-in SDK computed: the elements it was given, in order, and the digest it returned.
const mockHashes: { elements: bigint[]; digest: Uint8Array }[] = [];
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  const { secp256k1: curve } = jest.requireActual<typeof import('@noble/curves/secp256k1')>('@noble/curves/secp256k1');
  const { sha256: hash } = jest.requireActual<typeof import('@noble/hashes/sha2')>('@noble/hashes/sha2');
  const { keccak_256: keccak } = jest.requireActual<typeof import('@noble/hashes/sha3')>('@noble/hashes/sha3');
  const ECDSA = 0x01;
  // Miden's field modulus: a serialized word is four little-endian felts, each below it.
  const FELT_MODULUS = 0xffffffff00000001n;
  const handle = <T extends object>(value: T) => {
    mockLiveHandles.add(value);
    return Object.assign(value, {
      free: () => {
        mockLiveHandles.delete(value);
      }
    });
  };
  const felt = (value: bigint) => {
    if (value < 0n || value >= FELT_MODULUS) throw new Error('not a field element');
    return handle({ asInt: () => value });
  };
  const word = (bytes: Uint8Array) =>
    handle({
      serialize: () => Uint8Array.from(bytes),
      toFelts: () => {
        const limbs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return [0, 8, 16, 24].map(at => felt(limbs.getBigUint64(at, true)));
      }
    });
  const publicKey = (point: Uint8Array) =>
    handle({
      serialize: () => Uint8Array.from([ECDSA, ...point]),
      // The SDK's commitment is a hash of the key; any fixed function of the key stands in for it.
      toCommitment: () => word(hash(Uint8Array.from([ECDSA, ...point])))
    });
  const secretKey = (scalar: Uint8Array) =>
    handle({
      publicKey: () => publicKey(curve.getPublicKey(scalar, true)),
      serialize: () => Uint8Array.from([ECDSA, ...scalar]),
      sign: (message: { serialize: () => Uint8Array }) => {
        const signature = curve.sign(keccak(message.serialize()), scalar);
        return handle({
          serialize: () => Uint8Array.from([ECDSA, ...signature.toCompactRawBytes(), signature.recovery])
        });
      },
      getEcdsaK256KeccakSecretKeyAsFelts: () => []
    });
  return {
    ...base,
    // Inputs are copied: under jsdom noble refuses a Node Buffer as bytes.
    AuthSecretKey: {
      deserialize: (bytes: Uint8Array) => {
        if (bytes.length !== 33 || bytes[0] !== ECDSA) throw new Error('not a serialized ECDSA secret key');
        return secretKey(Uint8Array.from(bytes.subarray(1)));
      },
      ecdsaWithRNG: (seed: Uint8Array) => secretKey(hash(Uint8Array.from(seed)))
    },
    PublicKey: { deserialize: (bytes: Uint8Array) => publicKey(bytes.slice(1)) },
    Word: {
      deserialize: (bytes: Uint8Array) => {
        const limbs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length !== 32 || [0, 8, 16, 24].some(at => limbs.getBigUint64(at, true) >= FELT_MODULUS)) {
          throw new Error('not a word');
        }
        return word(bytes);
      }
    },
    Felt: function Felt(value: bigint) {
      return felt(value);
    },
    // Like the browser binding, the array takes its elements, and a hash takes the array.
    FeltArray: function FeltArray(elements: { asInt: () => bigint }[]) {
      for (const element of elements) mockLiveHandles.delete(element);
      return handle({ elements });
    },
    Poseidon2: {
      hashElements: (array: { elements: { asInt: () => bigint }[] }) => {
        mockLiveHandles.delete(array);
        const elements = array.elements.map(element => element.asInt());
        const bytes = new Uint8Array(8 * elements.length);
        const limbs = new DataView(bytes.buffer);
        elements.forEach((element, i) => limbs.setBigUint64(8 * i, element, true));
        // Any fixed function of the elements stands in for Poseidon2.
        const digest = hash(bytes);
        mockHashes.push({ elements, digest });
        return word(digest);
      }
    },
    AccountBuilder: class {
      storageMode() {
        return this;
      }
      withAuthComponent() {
        return this;
      }
      withBasicWalletComponent() {
        return this;
      }
      build() {
        return { account: { id: () => 'imported-account' } };
      }
    },
    AccountComponent: { createAuthComponentFromSecretKey: () => ({}) },
    AccountStorageMode: { public: () => 'public' }
  };
});

// The realm's insert-key sink, which the vault constructor installs.
let mockRealmInsertKey: ((key: Uint8Array, secretKey: Uint8Array) => Promise<void>) | undefined;

/** The SDK's keystore insert: it hands the key to the realm's sink under the key's commitment. */
async function mockInsertKey(secretKey: AuthSecretKey): Promise<void> {
  const publicKey = secretKey.publicKey();
  const commitment = publicKey.toCommitment();
  try {
    await mockRealmInsertKey?.(commitment.serialize(), secretKey.serialize());
  } finally {
    commitment.free();
    publicKey.free();
  }
}

/** The account `createGuardianMidenWallet` makes from an HD seed: a cold key from the seed, and a hot key. */
function mockGuardianAccount(seed: Uint8Array) {
  const coldKey = AuthSecretKey.ecdsaWithRNG(seed);
  const hotKey = AuthSecretKey.ecdsaWithRNG(sha256(Uint8Array.from(seed)));
  return {
    accountId: `guardian-${bytesToHex(seed.subarray(0, 4))}`,
    coldKey,
    keys: {
      hotPublicKey: publicKeyHex(hotKey),
      coldPublicKey: publicKeyHex(coldKey),
      hotCiphertext: bytesToHex(hotKey.serialize()),
      coldSecretKeyHex: bytesToHex(coldKey.serialize())
    }
  };
}

const mockRecoverGuardianAccountByHotKey = jest.fn(
  async (_hotSecretKeyHex: string, _endpoint: string): Promise<{ accountId: string; hotPublicKey: string }[]> => []
);
// The lock hands its callback a hold, and assertWasmHoldCurrent runs the real comparison against it.
let currentWasmHold: object | null = null;
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: async () => ({
    network: 'devnet',
    syncState: async () => {},
    createGuardianMidenWallet: async (seed: Uint8Array) => {
      const { accountId, coldKey, keys } = mockGuardianAccount(seed);
      await mockInsertKey(coldKey);
      return { accountId, keys };
    },
    recoverGuardianAccountsBySeed: async (deriveColdSeed: (hdIndex: number) => Uint8Array) => {
      const { accountId, keys } = mockGuardianAccount(deriveColdSeed(0));
      return [{ accountId, hdIndex: 0, coldPublicKey: keys.coldPublicKey, coldSecretKeyHex: keys.coldSecretKeyHex }];
    },
    recoverGuardianAccountByHotKey: (hotSecretKeyHex: string, endpoint: string) =>
      mockRecoverGuardianAccountByHotKey(hotSecretKeyHex, endpoint),
    client: {
      accounts: { insert: async () => {} },
      keystore: {
        insert: (_accountId: unknown, secretKey: AuthSecretKey) => mockInsertKey(secretKey),
        remove: async () => {},
        getAccountId: async () => null
      }
    }
  }),
  installRealmKeystore: (callbacks: { insertKey?: typeof mockRealmInsertKey }) => {
    if (callbacks.insertKey) mockRealmInsertKey = callbacks.insertKey;
  },
  uninstallRealmKeystore: () => {},
  isRealmKeystoreInstalled: (callbacks: { insertKey?: unknown }) => callbacks.insertKey === mockRealmInsertKey,
  getCurrentWasmLockHold: () => currentWasmHold,
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new Error(`operation abandoned ${where}`);
  },
  withWasmClientLock: async <T>(fn: (hold: object) => Promise<T>) => {
    const hold = {};
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  },
  resetMidenClient: async () => {},
  runWhenClientIdle: () => {}
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: unknown) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));

jest.mock('../guardian/account', () => ({
  fetchGuardianCreateKey: async () => ({ guardianEndpoint: '', guardianCommitment: '', rateLimitBudgetLeftMs: 0 }),
  registerGuardianAccount: async () => {},
  resolveGuardianEndpoint: () => undefined
}));

jest.mock('lib/miden/reset', () => {
  const actual = jest.requireActual<typeof import('lib/miden/reset')>('lib/miden/reset');
  return {
    PRESERVED_STORAGE_KEYS: actual.PRESERVED_STORAGE_KEYS,
    SETUP_WIPE_KEPT_KEYS: actual.SETUP_WIPE_KEPT_KEYS,
    // Mirrors the real reset: every key but the kept list goes.
    clearStorage: jest.fn(async (_clearDb: boolean = true, keep: readonly string[] = actual.PRESERVED_STORAGE_KEYS) => {
      for (const k of Object.keys(memoryStore)) if (!keep.includes(k)) delete memoryStore[k];
    })
  };
});

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  isDesktop: jest.fn(() => false),
  isMobile: jest.fn(() => false),
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));

jest.mock('lib/i18n', () => ({
  getMessage: jest.fn((key: string, substitutions?: any) => {
    if (key === 'defaultAccountName') {
      return `Account ${substitutions?.accountNumber ?? ''}`;
    }
    return key;
  })
}));

// A pass-through, so a test can read the root and the scalar the vault derived with after it zeroed them.
jest.mock('lib/miden/login-key/derive', () => {
  const actual = jest.requireActual<typeof import('lib/miden/login-key/derive')>('lib/miden/login-key/derive');
  return { ...actual, deriveLoginKeyScalar: jest.fn(actual.deriveLoginKeyScalar) };
});

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
// The test mnemonic's OnChain account 0 address and account 1 key (m/44'/60'/0'/0/0 and m/44'/60'/0'/0/1).
const EVM_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_KEY_1 = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// A serialized ECDSA `AuthSecretKey` to import: the scheme tag, then EVM_KEY_1 as its scalar.
const IMPORTED_SECRET_KEY = `01${EVM_KEY_1}`;
const DOMAIN = 'example.org';
const LOGIN_KEY_UNAVAILABLE = /^LOGIN_KEY_UNAVAILABLE: /;
const NOT_A_WORD = /^INVALID_PARAMS: not a word to sign$/;

const VAULT_PREFIX = 'vault';
const ck = (id: string) => `${VAULT_PREFIX}_${id}`;
const keys = {
  accounts: ck('accounts'),
  mnemonic: ck('mnemonic'),
  accAuthSecretKey: (id: string) => `${ck('accauthsecretkey')}_${id}`,
  accColdSecretKey: (publicKey: string) => `${ck('accouldsecretkey')}_${publicKey}`,
  accEvmSecretKey: (address: string) => `${ck('accevmsecretkey')}_${address.toLowerCase()}`
};

/** The test mnemonic's Guardian EVM key at `hdIndex`, m/44'/60'/2'/0/{hdIndex}. */
const guardianEvmKey = (hdIndex: number) =>
  mnemonicToAccount(TEST_MNEMONIC, { accountIndex: 2, addressIndex: hdIndex }).getHdKey().privateKey!;

/** A key's public key as the `serialize().slice(1)` hex the vault keeps hot and cold keys by. */
function publicKeyHex(secretKey: AuthSecretKey): string {
  const publicKey = secretKey.publicKey();
  try {
    return bytesToHex(publicKey.serialize().slice(1));
  } finally {
    publicKey.free();
  }
}

/** base64 of `publicKey`'s commitment, the form `connect` and the vault return; frees `publicKey`. */
function commitmentB64(publicKey: PublicKey): string {
  const commitment = publicKey.toCommitment();
  try {
    return u8ToB64(commitment.serialize());
  } finally {
    commitment.free();
    publicKey.free();
  }
}

/** The commitment of the public key `publicKeyHex`, as `connect` returns it. */
const publicKeyCommitment = (publicKeyHex: string) =>
  commitmentB64(PublicKey.deserialize(hexToBytes(`01${publicKeyHex}`)));

/** The commitment of the serialized secret key `secretKeyHex`, as `connect` returns it. */
function secretKeyCommitment(secretKeyHex: string): string {
  const secretKey = AuthSecretKey.deserialize(hexToBytes(secretKeyHex));
  try {
    return commitmentB64(secretKey.publicKey());
  } finally {
    secretKey.free();
  }
}

/** The commitment of the login key `root` gives for `domain`. */
function expectedCommitment(root: Uint8Array, source: LoginKeySource, domain = DOMAIN): string {
  const secretKey = deserializeHotSecretKey(bytesToHex(deriveLoginKeyScalar(root, source, domain)));
  try {
    return commitmentB64(secretKey.publicKey());
  } finally {
    secretKey.free();
  }
}

/** `key` as safe-storage stores it: hex of its SHA-256. */
const wrapped = async (key: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(key, 'utf-8'))).toString('hex');

const clearStore = () => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
};

/** A fresh wallet holding `accounts`. Nothing here unlocks it by password, so it has no password protector. */
async function seedVault(accounts: WalletAccount[]): Promise<Vault> {
  const vaultKey = await Passworder.importVaultKey(Passworder.generateVaultKey());
  await encryptAndSaveMany([[keys.accounts, accounts]], vaultKey);
  return new Vault(vaultKey);
}

/** Forget earlier derivations, hashes and handles, so a test sees only the next vault call's. */
function forgetKeyMaterial() {
  jest.mocked(deriveLoginKeyScalar).mockClear();
  mockLiveHandles.clear();
  mockHashes.length = 0;
}

/** The vault call since `forgetKeyMaterial` derived one login key, zeroed its root and scalar and freed every handle. */
function expectCleanedUp() {
  const derive = jest.mocked(deriveLoginKeyScalar);
  expect(derive).toHaveBeenCalledTimes(1);
  expect(derive.mock.calls[0]![0]).toEqual(new Uint8Array(32));
  expect(derive.mock.results[0]!.value).toEqual(new Uint8Array(32));
  expect(mockLiveHandles.size).toBe(0);
}

// The Guardian wallet most tests start from, spawned once and restored before each test.
let baseVaultKey: CryptoKey;
let baseStore: Record<string, any>;
let vault: Vault;
let account: WalletAccount;
// The account key commitment `connect` returned for the account: its hot key's.
let connected: string;

const saveAccounts = (accounts: WalletAccount[]) => encryptAndSaveMany([[keys.accounts, accounts]], baseVaultKey);

beforeAll(async () => {
  const spawned = await Vault.spawn(WalletType.Guardian, 'pw', TEST_MNEMONIC, false);
  baseVaultKey = (spawned as any).vaultKey as CryptoKey;
  baseStore = { ...memoryStore };
});

beforeEach(async () => {
  clearStore();
  Object.assign(memoryStore, baseStore);
  jest.clearAllMocks();
  vault = new Vault(baseVaultKey);
  account = (await vault.fetchAccounts())[0]!;
  connected = publicKeyCommitment(account.hotPublicKey!);
  mockStorageReads.length = 0;
  mockStorageRead.mockClear();
});

describe('Vault login keys', () => {
  it('derives from the stored EVM key', async () => {
    expect(await fetchAndDecryptOne<string>(keys.accEvmSecretKey(account.evmAddress!), baseVaultKey)).toBe(
      `0x${bytesToHex(guardianEvmKey(0))}`
    );
    mockStorageReads.length = 0;

    expect(await vault.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(
      expectedCommitment(guardianEvmKey(0), 'evm')
    );
    // The stored key served it: the seed phrase was not read.
    expect(mockStorageReads).not.toContain(await wrapped(keys.mnemonic));
  });

  it('gives a restored wallet the same login key', async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);

    const restored = await Vault.spawn(WalletType.Guardian, 'pw', TEST_MNEMONIC, true);
    const [recovered] = await restored.fetchAccounts();
    expect(recovered).toMatchObject({ publicKey: account.publicKey, requiresHotKeyRotation: true });
    expect(await restored.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
  });

  it('gives a key-QR device the same login key', async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);
    const keyPair = await Vault.revealHotKey(account.publicKey, 'pw');
    mockRecoverGuardianAccountByHotKey.mockResolvedValueOnce([
      { accountId: account.publicKey, hotPublicKey: account.hotPublicKey! }
    ]);

    const device = await Vault.spawnFromHotKey('pw', keyPair);
    expect(await device.fetchSeedPhraseStatus()).toBe('unavailable');
    expect(await device.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
  });

  it('keeps the login key after the seed phrase is removed', async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);

    await vault.removeSeedPhrase();
    expect(await vault.fetchSeedPhraseStatus()).toBe('removed');
    expect(await vault.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
  });

  it("derives an older account's EVM key from its seed phrase without saving it", async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);
    // An account from before EVM keys were stored: no address on its record and no stored EVM key.
    await saveAccounts([{ ...account, evmAddress: undefined }]);
    await removeMany([keys.accEvmSecretKey(account.evmAddress!)]);
    const accounts = await vault.fetchAccounts();
    const stored = { ...memoryStore };

    expect(await vault.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
    expect(memoryStore).toEqual(stored);
    expect(await vault.fetchAccounts()).toEqual(accounts);
  });

  it('derives a missing EVM key from the seed phrase when the address matches in any letter case', async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);
    // The seed phrase gives the checksummed address, and the record holds it in lowercase.
    expect(account.evmAddress).not.toBe(account.evmAddress!.toLowerCase());
    await saveAccounts([{ ...account, evmAddress: account.evmAddress!.toLowerCase() }]);
    await removeMany([keys.accEvmSecretKey(account.evmAddress!)]);

    expect(await vault.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
  });

  it('refuses an account whose seed phrase gives another EVM key', async () => {
    // The OnChain account 0 address, whose key is not stored: the seed phrase gives this account another one.
    await saveAccounts([{ ...account, evmAddress: EVM_ADDR_0 }]);

    await expect(vault.loginKeyCommitment(account.publicKey, DOMAIN)).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
  });

  it.each([
    { label: 'empty', leaf: '' },
    { label: 'of odd length', leaf: `0x${'ab'.repeat(31)}a` },
    { label: 'not hex', leaf: `0x${'ab'.repeat(31)}zz` },
    { label: '31 bytes', leaf: `0x${'ab'.repeat(31)}` }
  ])('refuses a stored EVM key that is $label, deriving nothing', async ({ leaf }) => {
    await encryptAndSaveMany([[keys.accEvmSecretKey(account.evmAddress!), leaf]], baseVaultKey);

    await expect(vault.loginKeyCommitment(account.publicKey, DOMAIN)).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
    expect(deriveLoginKeyScalar).not.toHaveBeenCalled();
  });

  it('refuses without the root key', async () => {
    await saveAccounts([{ ...account, evmAddress: undefined }]);
    await removeMany([keys.accEvmSecretKey(account.evmAddress!), keys.mnemonic]);
    const coldCommitment = publicKeyCommitment(account.coldPublicKey!);
    mockStorageReads.length = 0;

    await expect(vault.loginKeyCommitment(account.publicKey, DOMAIN)).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
    // None of the account's signing keys was read, by public key or by commitment.
    expect(mockStorageReads).not.toContain(await wrapped(keys.accAuthSecretKey(account.hotPublicKey!)));
    expect(mockStorageReads).not.toContain(await wrapped(keys.accColdSecretKey(account.coldPublicKey!)));
    expect(mockStorageReads).not.toContain(await wrapped(keys.accAuthSecretKey(bytesToHex(b64ToU8(connected)))));
    expect(mockStorageReads).not.toContain(await wrapped(keys.accAuthSecretKey(bytesToHex(b64ToU8(coldCommitment)))));
  });

  it('refuses a single-key import, never reading its key as a root', async () => {
    clearStore();
    const fresh = await seedVault([]);
    const [imported] = await fresh.importAccountFromPrivateKey(IMPORTED_SECRET_KEY);
    // The commitment `connect` returned for the import names the key the wallet stores for it.
    const importedCommitment = secretKeyCommitment(IMPORTED_SECRET_KEY);
    const importedKey = await wrapped(keys.accAuthSecretKey(bytesToHex(b64ToU8(importedCommitment))));
    expect(Object.keys(memoryStore)).toContain(importedKey);
    mockStorageReads.length = 0;

    await expect(fresh.loginKeyCommitment(imported!.publicKey, DOMAIN)).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
    await expect(
      fresh.signWithLoginKey(imported!.publicKey, DOMAIN, u8ToB64(new Uint8Array(32).fill(7)))
    ).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
    expect(mockStorageReads).not.toContain(importedKey);
    expect(deriveLoginKeyScalar).not.toHaveBeenCalled();
  });

  it("never matches one of the account's signing keys", async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);

    expect(loginKey).not.toBe(connected);
    expect(loginKey).not.toBe(publicKeyCommitment(account.coldPublicKey!));
  });

  it('signs Poseidon2 of the login tag and the word, never the word itself', async () => {
    // The protocol's vector word, the bytes 0x00 to 0x1f.
    const word = Uint8Array.from({ length: 32 }, (_, i) => i);
    const loginPublicKey = secp256k1.getPublicKey(deriveLoginKeyScalar(guardianEvmKey(0), 'evm', DOMAIN), true);
    forgetKeyMaterial();

    const signature = b64ToU8(await vault.signWithLoginKey(account.publicKey, DOMAIN, u8ToB64(word)));
    expectCleanedUp();

    // One hash: `Bread login v1` as four little-endian elements, the last zero-padded, then the word's four limbs.
    expect(mockHashes.map(({ elements }) => elements)).toEqual([
      [
        0x61657242n,
        0x6f6c2064n,
        0x206e6967n,
        0x00003176n,
        0x0706050403020100n,
        0x0f0e0d0c0b0a0908n,
        0x1716151413121110n,
        0x1f1e1d1c1b1a1918n
      ]
    ]);
    expect(signature).toHaveLength(66);
    expect(signature[0]).toBe(0x01);
    // The recovery playwright/e2e/helpers/signature-recovery.ts runs, on bytes noble accepts under jsdom: the key
    // signed the hash's result, and not the word.
    const digest = keccak_256(mockHashes[0]!.digest);
    const recovered = secp256k1.Signature.fromCompact(signature.subarray(1, 65))
      .addRecoveryBit(signature[65]!)
      .recoverPublicKey(digest);
    expect(recovered.toRawBytes(true)).toEqual(loginPublicKey);
    expect(secp256k1.verify(signature.subarray(1, 65), digest, loginPublicKey)).toBe(true);
    expect(secp256k1.verify(signature.subarray(1, 65), keccak_256(word), loginPublicKey)).toBe(false);
    // The key that signed is the one whose commitment a site gets as its login key.
    expect(commitmentB64(PublicKey.deserialize(Uint8Array.from([0x01, ...loginPublicKey])))).toBe(
      await vault.loginKeyCommitment(account.publicKey, DOMAIN)
    );
  });

  it('stays the same after a hot key rotation', async () => {
    const loginKey = await vault.loginKeyCommitment(account.publicKey, DOMAIN);
    const newHotKey = AuthSecretKey.ecdsaWithRNG(new Uint8Array(32).fill(9));
    const newHotPublicKey = publicKeyHex(newHotKey);

    await vault.persistNewHotKey(newHotPublicKey, bytesToHex(newHotKey.serialize()));
    await vault.swapHotKey(account.publicKey, newHotPublicKey);
    expect((await vault.fetchAccounts())[0]!.hotPublicKey).toBe(newHotPublicKey);
    expect(await vault.loginKeyCommitment(account.publicKey, DOMAIN)).toBe(loginKey);
  });

  it('gives each domain its own key', async () => {
    const otherSite = await vault.loginKeyCommitment(account.publicKey, 'example.com');

    expect(otherSite).toBe(expectedCommitment(guardianEvmKey(0), 'evm', 'example.com'));
    expect(otherSite).not.toBe(await vault.loginKeyCommitment(account.publicKey, DOMAIN));
  });

  it('gives each account its own key', async () => {
    const accounts = await vault.createHDAccount(WalletType.Guardian);
    const second = accounts.find(acc => acc.hdIndex === 1)!;
    const secondLoginKey = await vault.loginKeyCommitment(second.publicKey, DOMAIN);

    expect(secondLoginKey).toBe(expectedCommitment(guardianEvmKey(1), 'evm'));
    expect(secondLoginKey).not.toBe(await vault.loginKeyCommitment(account.publicKey, DOMAIN));
  });

  it('refuses an account this wallet does not hold', async () => {
    await expect(vault.loginKeyCommitment('guardian-unknown', DOMAIN)).rejects.toThrow(LOGIN_KEY_UNAVAILABLE);
  });

  it('refuses a word that is not base64 of 32 bytes before reading a key', async () => {
    await expect(vault.signWithLoginKey(account.publicKey, DOMAIN, u8ToB64(new Uint8Array(31)))).rejects.toThrow(
      NOT_A_WORD
    );
    await expect(vault.signWithLoginKey(account.publicKey, DOMAIN, 'not base64!')).rejects.toThrow(NOT_A_WORD);
    // Nothing was read, so nothing was decrypted.
    expect(mockStorageReads).toEqual([]);
    expect(deriveLoginKeyScalar).not.toHaveBeenCalled();
  });

  it('refuses non-field elements before reading or decrypting a root key', async () => {
    await expect(
      vault.signWithLoginKey(account.publicKey, DOMAIN, u8ToB64(new Uint8Array(32).fill(0xff)))
    ).rejects.toThrow(NOT_A_WORD);
    expect(mockStorageRead).not.toHaveBeenCalled();
    expect(mockStorageReads).toEqual([]);
    expect(deriveLoginKeyScalar).not.toHaveBeenCalled();
  });

  it('refuses a word the SDK cannot read, still freeing the key and zeroing its buffers', async () => {
    forgetKeyMaterial();
    const deserialize = jest.spyOn(Word, 'deserialize').mockImplementationOnce(() => {
      throw new Error('not a word');
    });

    try {
      await expect(
        vault.signWithLoginKey(account.publicKey, DOMAIN, u8ToB64(new Uint8Array(32).fill(7)))
      ).rejects.toThrow(NOT_A_WORD);
    } finally {
      deserialize.mockRestore();
    }
    expectCleanedUp();
  });
});

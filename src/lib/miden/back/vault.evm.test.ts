/**
 * Wallet-derived EVM identity tests for `lib/miden/back/vault.ts`:
 *   - `Vault.spawn` stamps `evmAddress` + persists the encrypted leaf key
 *   - `createHDAccount` reuses the wallet address
 *   - `backfillEvmAddresses` migrates every account to one wallet address
 *   - `signEvm` round-trips (message / typed-data digest / transaction)
 *     recover to the stamped address
 *   - rejection branches surface as PublicError
 *
 * Derivation vectors are the standard Hardhat/Anvil test mnemonic:
 * m/44'/60'/0'/0/0 → 0xf39F…2266. EVM_ADDR_1 is retained as a legacy
 * per-account address and transaction destination test vector.
 */

import {
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverMessageAddress,
  recoverTransactionAddress,
  serializeTransaction,
  stringToHex
} from 'viem';
import type { TransactionSerializedEIP1559 } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

import * as Passworder from 'lib/miden/passworder';
import { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { PublicError } from './defaults';
import { encryptAndSaveMany, fetchAndDecryptOneWithLegacyFallBack, savePlain } from './safe-storage';
import { Vault } from './vault';

const memoryStore: Record<string, any> = {};
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: jest.fn(() => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in memoryStore) out[k] = memoryStore[k];
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign(memoryStore, items);
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete memoryStore[k];
    }
  })),
  StorageProvider: class {}
}));

const mockCreateMidenWallet = jest.fn(async (_type: any, _seed: Uint8Array) => 'acc-pub-key-1');
// vault.ts re-checks lock-hold ownership before pre-write WASM calls (#788
// follow-up), so the lock mock has to hand its callback a hold and back
// assertWasmHoldCurrent with the real comparison — a no-op would leave the
// guards untestable, and no export at all would make them a TypeError.
let currentWasmHold: object | null = null;
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(async (_options?: any) => ({
    createMidenWallet: (...args: unknown[]) => mockCreateMidenWallet(...(args as [any, Uint8Array])),
    importPublicMidenWalletFromSeed: async (_seed: Uint8Array) => 'acc-pub-key-imported',
    getAccounts: async () => [] as any[],
    getAccount: async (_id: string) => null as any,
    syncState: async () => {},
    network: 'devnet',
    client: {
      accounts: { insert: jest.fn() },
      keystore: { insert: jest.fn() }
    }
  })),
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
  runWhenClientIdle: () => {}
}));

jest.mock('../sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: any) => (typeof id === 'string' ? id : 'bech32:unknown')),
  // vault.signEvm matches the account tolerantly (bare bech32 vs composite publicKey).
  sameWalletAccountId: jest.fn((a: string, b: string) => a === b)
}));

jest.mock('lib/miden/reset', () => ({
  clearStorage: jest.fn(async () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  })
}));

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

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const base = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...base,
    AuthSecretKey: {
      deserialize: jest.fn(() => ({})),
      ecdsaWithRNG: jest.fn(() => ({ __marker: 'ecdsa-secret' }))
    },
    SigningInputs: { deserialize: jest.fn(() => ({})) },
    Word: { deserialize: jest.fn(() => ({})), fromHex: jest.fn(() => ({})) }
  };
});

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const EVM_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const VAULT_PREFIX = 'vault';
const ck = (id: string) => `${VAULT_PREFIX}_${id}`;
const keys = {
  check: ck('check'),
  mnemonic: ck('mnemonic'),
  accounts: ck('accounts'),
  accEvmSecretKey: (addr: string) => `${ck('accevmsecretkey')}_${addr.toLowerCase()}`,
  currentAccPubKey: ck('curraccpubkey'),
  ownMnemonic: ck('ownmnemonic'),
  vaultKeyPassword: 'vault_key_password'
};

async function seedVault(accounts: WalletAccount[], mnemonic: string = TEST_MNEMONIC): Promise<Vault> {
  const vaultKeyBytes = Passworder.generateVaultKey();
  const vaultKey = await Passworder.importVaultKey(vaultKeyBytes);
  const encryptedVaultKey = await Passworder.encryptVaultKeyWithPassword(vaultKeyBytes, 'pw');
  await savePlain(keys.vaultKeyPassword, encryptedVaultKey);

  await encryptAndSaveMany(
    [
      [keys.check, TEST_MNEMONIC],
      [keys.mnemonic, mnemonic],
      [keys.accounts, accounts]
    ],
    vaultKey
  );
  await savePlain(keys.currentAccPubKey, accounts[0]?.publicKey ?? 'none');
  await savePlain(keys.ownMnemonic, false);

  return new (Vault as any)(vaultKey);
}

const hdAccount = (publicKey: string, hdIndex: number, evmAddress?: string): WalletAccount => ({
  publicKey,
  name: `Account ${hdIndex + 1}`,
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex,
  authScheme: 'ecdsa',
  ...(evmAddress && { evmAddress })
});

beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  jest.clearAllMocks();
});

describe('Vault.spawn: EVM identity stamping', () => {
  it('stamps the known-vector evmAddress and persists a matching encrypted leaf key', async () => {
    const vault = await Vault.spawn(WalletType.OnChain, 'pw', TEST_MNEMONIC, false);
    const accounts = await vault.fetchAccounts();

    expect(accounts[0]!.evmAddress).toBe(EVM_ADDR_0);

    const vaultKey = (vault as any).vaultKey as CryptoKey;
    const privateKeyHex = await fetchAndDecryptOneWithLegacyFallBack<`0x${string}`>(
      keys.accEvmSecretKey(EVM_ADDR_0),
      vaultKey
    );
    expect(privateKeyToAccount(privateKeyHex).address).toBe(EVM_ADDR_0);
  });
});

describe('Vault.createHDAccount: EVM identity stamping', () => {
  it('reuses the wallet address for a new Miden account', async () => {
    const vault = await seedVault([hdAccount('acc-pub-key-1', 0, EVM_ADDR_0)]);
    mockCreateMidenWallet.mockResolvedValueOnce('acc-pub-key-2');

    const accounts = await vault.createHDAccount(WalletType.OnChain);
    const created = accounts.find(acc => acc.publicKey === 'acc-pub-key-2');
    expect(created?.hdIndex).toBe(1);
    expect(created?.evmAddress).toBe(EVM_ADDR_0);
  });
});

describe('Vault.backfillEvmAddresses', () => {
  it('normalizes missing, legacy, and imported accounts to one address and is idempotent', async () => {
    const vault = await seedVault([
      hdAccount('acc-pub-key-1', 0),
      hdAccount('acc-pub-key-2', 1, EVM_ADDR_1),
      { ...hdAccount('acc-imported', -1), hdIndex: -1 }
    ]);

    await vault.backfillEvmAddresses();
    const first = await vault.fetchAccounts();
    expect(first.map(account => account.evmAddress)).toEqual([EVM_ADDR_1, EVM_ADDR_1, EVM_ADDR_1]);

    await vault.backfillEvmAddresses();
    const second = await vault.fetchAccounts();
    expect(second).toEqual(first);
  });

  it('leaves accounts untouched when the vault has no mnemonic', async () => {
    const vault = await seedVault([hdAccount('acc-pub-key-1', 0)], '');
    await vault.backfillEvmAddresses();
    const accounts = await vault.fetchAccounts();
    expect(accounts[0]!.evmAddress).toBeUndefined();
  });

  it.each([
    { walletType: WalletType.OffChain, accountIndex: 1 },
    { walletType: WalletType.Guardian, accountIndex: 2 }
  ])('preserves the original $walletType wallet EVM owner when consolidating accounts', async testCase => {
    const ownerAddress = mnemonicToAccount(TEST_MNEMONIC, {
      accountIndex: testCase.accountIndex,
      addressIndex: 0
    }).address;
    const originalAccount: WalletAccount = {
      ...hdAccount('acc-original-1', 0, ownerAddress),
      isPublic: false,
      type: testCase.walletType
    };
    const vault = await seedVault([originalAccount, hdAccount('acc-public-1', 0, EVM_ADDR_0)]);

    await vault.backfillEvmAddresses();

    const accounts = await vault.fetchAccounts();
    expect(accounts.map(account => account.evmAddress)).toEqual([ownerAddress, ownerAddress]);
    const signature = await vault.signEvm('acc-public-1', {
      op: 'message',
      messageHex: stringToHex('preserve owner')
    });
    const recovered = await recoverMessageAddress({ message: 'preserve owner', signature });
    expect(recovered).toBe(ownerAddress);
  });
});

describe('Vault.signEvm round-trips', () => {
  let vault: Vault;

  beforeEach(async () => {
    vault = await seedVault([hdAccount('acc-pub-key-1', 0), { ...hdAccount('acc-imported', -1), hdIndex: -1 }]);
    await vault.backfillEvmAddresses();
  });

  it('message: recovers the stamped address', async () => {
    const signature = await vault.signEvm('acc-pub-key-1', { op: 'message', messageHex: stringToHex('hello miden') });
    const recovered = await recoverMessageAddress({ message: 'hello miden', signature });
    expect(recovered).toBe(EVM_ADDR_0);
  });

  it('uses the same wallet key when another Miden account authorizes signing', async () => {
    const signature = await vault.signEvm('acc-imported', {
      op: 'message',
      messageHex: stringToHex('same wallet')
    });
    const recovered = await recoverMessageAddress({ message: 'same wallet', signature });
    expect(recovered).toBe(EVM_ADDR_0);
  });

  it('typed-data digest: recovers the stamped address', async () => {
    const digest = keccak256(stringToHex('typed-data-payload'));
    const signature = await vault.signEvm('acc-pub-key-1', { op: 'typed-data', digest });
    const recovered = await recoverAddress({ hash: digest, signature });
    expect(recovered).toBe(EVM_ADDR_0);
  });

  it('transaction: preserves fields and recovers the stamped address', async () => {
    const serializedTransaction = serializeTransaction({
      chainId: 11155111,
      type: 'eip1559',
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000000n,
      to: EVM_ADDR_1,
      value: 1n
    });
    const signed = (await vault.signEvm('acc-pub-key-1', {
      op: 'transaction',
      serializedTransaction
    })) as TransactionSerializedEIP1559;

    const parsed = parseTransaction(signed);
    expect(parsed.to?.toLowerCase()).toBe(EVM_ADDR_1.toLowerCase());
    expect(parsed.value).toBe(1n);

    const recovered = await recoverTransactionAddress({ serializedTransaction: signed });
    expect(recovered).toBe(EVM_ADDR_0);
  });
});

describe('Vault.signEvm rejections', () => {
  it('rejects an unknown account', async () => {
    const vault = await seedVault([hdAccount('acc-pub-key-1', 0, EVM_ADDR_0)]);
    await expect(vault.signEvm('acc-unknown', { op: 'message', messageHex: '0x01' })).rejects.toThrow(PublicError);
  });

  it('rejects an account without an EVM address when the vault has no mnemonic', async () => {
    const vault = await seedVault([{ ...hdAccount('acc-imported', -1), hdIndex: -1 }], '');
    await expect(vault.signEvm('acc-imported', { op: 'message', messageHex: '0x01' })).rejects.toThrow(PublicError);
  });

  it('rejects when the address is stamped but the key blob is missing', async () => {
    const vault = await seedVault([hdAccount('acc-pub-key-1', 0, EVM_ADDR_0)]);
    await expect(vault.signEvm('acc-pub-key-1', { op: 'message', messageHex: '0x01' })).rejects.toThrow(PublicError);
  });
});

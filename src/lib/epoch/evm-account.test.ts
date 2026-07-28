import {
  type TransactionSerializable,
  type WalletClient,
  hashTypedData,
  parseTransaction,
  serializeTransaction,
  stringToHex,
  toHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  recoverAddress,
  recoverAuthorizationAddress,
  recoverMessageAddress,
  recoverTypedDataAddress
} from 'viem/utils';

import { SignEvmOperation } from 'lib/shared/types';

import { buildVaultEvmWalletClient } from './evm-account';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const signer = privateKeyToAccount(PRIVATE_KEY);
const mockSignEvm = jest.fn();

jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: () => ({
      signEvm: (...args: unknown[]) => mockSignEvm(...args)
    })
  }
}));

/**
 * Faithful stand-in for the vault: it performs exactly the signature the real
 * `Vault.signEvm` would produce for each op, so the tests can recover the
 * signer address from the returned signature and prove the payload that
 * crossed intercom was the correct one.
 */
function mockVaultSignEvm(_accountPublicKey: string, operation: SignEvmOperation): Promise<`0x${string}`> {
  switch (operation.op) {
    case 'typed-data':
      return signer.sign({ hash: operation.digest });
    case 'message':
      return signer.signMessage({ message: { raw: operation.messageHex } });
    case 'transaction':
      return signer.signTransaction(parseTransaction(operation.serializedTransaction));
  }
}

/**
 * The public return type of `buildVaultEvmWalletClient` widens `account` to
 * `Account | undefined`; narrow it back to the LocalAccount so the low-level
 * `sign`/`signTransaction` callbacks can be exercised directly.
 */
function getLocalAccount(client: WalletClient) {
  const account = client.account;
  if (!account || account.type !== 'local') throw new Error('expected a local account');
  return account;
}

const eip1559Transaction = {
  type: 'eip1559',
  chainId: 11155111,
  nonce: 3,
  to: '0x0000000000000000000000000000000000000abc',
  value: 1000000000000000n,
  gas: 21000n,
  maxFeePerGas: 30000000000n,
  maxPriorityFeePerGas: 1000000000n
} as const;

const typedData = {
  domain: {
    name: 'Miden',
    version: '1',
    chainId: 11155111,
    verifyingContract: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
  },
  types: {
    Mail: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'contents', type: 'string' }
    ]
  },
  primaryType: 'Mail',
  message: {
    from: signer.address,
    to: '0x0000000000000000000000000000000000000001',
    contents: 'gm'
  }
} as const;

describe('buildVaultEvmWalletClient', () => {
  beforeEach(() => {
    mockSignEvm.mockReset();
    mockSignEvm.mockImplementation(mockVaultSignEvm);
  });

  it('exposes a local signer that produces valid EIP-7702 authorizations through the vault', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const authorization = await client.signAuthorization({
      account: client.account!,
      chainId: 11155111,
      nonce: 0,
      contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
    });

    expect(client.account?.type).toBe('local');
    expect(await recoverAuthorizationAddress({ authorization })).toBe(signer.address);
    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', {
      op: 'typed-data',
      digest: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });
  });

  it('sign() sends the raw digest as a typed-data op and recovers the signer', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const account = getLocalAccount(client);
    const hash = `0x${'ab'.repeat(32)}` as const;

    const signature = await account.sign!({ hash });

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', { op: 'typed-data', digest: hash });
    expect(await recoverAddress({ hash, signature })).toBe(signer.address);
  });

  it('signMessage() hexes a string message and recovers via EIP-191', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const message = 'hello miden';

    const signature = await client.signMessage({ account: client.account!, message });

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', { op: 'message', messageHex: stringToHex(message) });
    expect(await recoverMessageAddress({ message, signature })).toBe(signer.address);
  });

  it('signMessage() toHexes raw bytes and recovers via EIP-191', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const raw = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    const signature = await client.signMessage({ account: client.account!, message: { raw } });

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', { op: 'message', messageHex: toHex(raw) });
    expect(await recoverMessageAddress({ message: { raw }, signature })).toBe(signer.address);
  });

  it('signMessage() passes a raw hex-string message through unchanged', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const raw = toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

    const signature = await client.signMessage({ account: client.account!, message: { raw } });

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', { op: 'message', messageHex: raw });
    expect(await recoverMessageAddress({ message: { raw }, signature })).toBe(signer.address);
  });

  it('signTypedData() pre-hashes the payload and recovers the signer', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);

    const signature = await client.signTypedData({ account: client.account!, ...typedData });

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', { op: 'typed-data', digest: hashTypedData(typedData) });
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(signer.address);
  });

  it('signTransaction() pre-serializes with the default serializer', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const account = getLocalAccount(client);

    const signed = await account.signTransaction!(eip1559Transaction);

    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', {
      op: 'transaction',
      serializedTransaction: serializeTransaction(eip1559Transaction)
    });
    // The client returns the vault's signed serialized transaction unchanged.
    expect(signed).toBe(await signer.signTransaction(parseTransaction(serializeTransaction(eip1559Transaction))));
  });

  it('signTransaction() honours a caller-supplied serializer', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const account = getLocalAccount(client);
    const customSerialized = `0x${'cd'.repeat(20)}` as const;
    const serializer = jest.fn<`0x${string}`, [TransactionSerializable]>(() => customSerialized);
    // customSerialized isn't a real serialized tx, so bypass the parsing vault stub.
    mockSignEvm.mockResolvedValue('0xsigned');

    await account.signTransaction!(eip1559Transaction, { serializer });

    expect(serializer).toHaveBeenCalledWith(eip1559Transaction);
    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', {
      op: 'transaction',
      serializedTransaction: customSerialized
    });
  });
});

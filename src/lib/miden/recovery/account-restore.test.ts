import { Account } from '@miden-sdk/miden-sdk/lazy';

import {
  restoreRetainedGuardianAccount,
  type RecoveryAccountMaterial,
  type RecoveryAccountClient
} from './account-restore';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Account: {
    deserialize: (bytes: Uint8Array) => {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      return {
        id: () => ({ toString: () => data.id }),
        nonce: () => ({ asInt: () => BigInt(data.nonce) }),
        to_commitment: () => ({ toHex: () => data.commitment, free: () => {} }),
        guardian: data.guardian,
        signers: data.signers,
        free: () => {}
      };
    }
  }
}));
jest.mock('../guardian/account', () => ({
  getGuardianCommitmentFromAccount: (account: object) => Reflect.get(account, 'guardian'),
  getSignerCommitmentsFromAccount: (account: object) => Reflect.get(account, 'signers')
}));
jest.mock('../sdk/helpers', () => ({ sameWalletAccountId: (left: string, right: string) => left === right }));

const state = (extra: Record<string, unknown> = {}) =>
  new Uint8Array(
    new TextEncoder().encode(
      JSON.stringify({ id: 'retained', nonce: '4', commitment: '04', guardian: 'aa', signers: ['bb', 'cc'], ...extra })
    )
  );
const material = (bytes = state()): RecoveryAccountMaterial => ({
  floor: { accountId: 'retained', nonce: '3', commitment: '03' },
  accountBytes: bytes,
  guardianCommitment: 'aa',
  signerCommitments: ['bb'],
  chainCommitment: '04'
});
let stored: Account | null;
let writes: number;
let afterRead: () => void;
let afterWrite: () => void;
const client: RecoveryAccountClient = {
  accounts: {
    get: jest.fn().mockImplementation(async () => {
      afterRead();
      return stored;
    }),
    insert: jest.fn().mockImplementation(async ({ account }: { account: Account }) => {
      writes++;
      stored = account;
      afterWrite();
    })
  }
};

beforeEach(() => {
  stored = null;
  writes = 0;
  afterRead = () => {};
  afterWrite = () => {};
});

it('reconstructs the exact retained account from current canonical Guardian state and verifies readback', async () => {
  await expect(restoreRetainedGuardianAccount(client, material(), () => {})).resolves.toBeUndefined();
  expect(stored?.id().toString()).toBe('retained');
  expect(stored?.nonce().asInt()).toBe(4n);
  expect(writes).toBe(1);
});

it.each([
  ['wrong account', state({ id: 'other' })],
  ['wrong operator', state({ guardian: 'dd' })],
  ['removed signer', state({ signers: ['cc'] })],
  ['old state', state({ nonce: '2', commitment: '02' })],
  ['equal nonce divergence', state({ nonce: '3', commitment: 'ff' })],
  ['noncanonical pending state', state({ nonce: '5', commitment: '05' })]
])('refuses %s without inserting anything', async (_label, bytes) => {
  await expect(restoreRetainedGuardianAccount(client, material(bytes), () => {})).rejects.toThrow();
  expect(stored).toBeNull();
  expect(writes).toBe(0);
});

it('keeps an optimistic retained floor unavailable while the node is still behind it', async () => {
  const input = { ...material(), floor: { accountId: 'retained', nonce: '5', commitment: '05' } };
  await expect(restoreRetainedGuardianAccount(client, input, () => {})).rejects.toThrow();
  expect(writes).toBe(0);
});

it('never rolls a surviving newer account back to a canonical older snapshot', async () => {
  stored = Account.deserialize(state({ nonce: '5', commitment: '05' }));
  await expect(restoreRetainedGuardianAccount(client, material(), () => {})).rejects.toThrow();
  expect(stored.nonce().asInt()).toBe(5n);
  expect(writes).toBe(0);
});

it('rechecks the live authorization after a delayed local read', async () => {
  let current = true;
  afterRead = () => {
    current = false;
  };
  await expect(
    restoreRetainedGuardianAccount(client, material(), () => {
      if (!current) throw new Error('retired');
    })
  ).rejects.toThrow();
  expect(writes).toBe(0);
});

it('does not acknowledge an insert after its holder was abandoned', async () => {
  let current = true;
  afterWrite = () => {
    current = false;
  };
  await expect(
    restoreRetainedGuardianAccount(client, material(), () => {
      if (!current) throw new Error('retired');
    })
  ).rejects.toThrow();
});

it('refuses an oversized state before deserialization', async () => {
  await expect(
    restoreRetainedGuardianAccount(client, material(new Uint8Array(2 * 1024 * 1024 + 1)), () => {})
  ).rejects.toThrow();
  expect(writes).toBe(0);
});

it('replays an already adopted exact account without another insert', async () => {
  stored = Account.deserialize(state());
  await expect(restoreRetainedGuardianAccount(client, material(), () => {})).resolves.toBeUndefined();
  expect(writes).toBe(0);
});

it('restores an exact nonce-zero retained account only with a verified empty node commitment', async () => {
  const input = {
    ...material(state({ nonce: '0', commitment: '01' })),
    floor: { accountId: 'retained', nonce: '0', commitment: '01' },
    chainCommitment: '0x0000'
  };
  await expect(restoreRetainedGuardianAccount(client, input, () => {})).resolves.toBeUndefined();
  expect(stored?.nonce().asInt()).toBe(0n);
});

it('does not confuse an absent node answer with a verified undeployed account', async () => {
  const input = {
    ...material(state({ nonce: '0', commitment: '01' })),
    floor: { accountId: 'retained', nonce: '0', commitment: '01' },
    chainCommitment: ''
  };
  await expect(restoreRetainedGuardianAccount(client, input, () => {})).rejects.toThrow();
  expect(writes).toBe(0);
});

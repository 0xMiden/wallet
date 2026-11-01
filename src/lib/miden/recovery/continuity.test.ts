import Dexie from 'dexie';

import { readWalletGenerationForRecovery } from './wallet-generation';
import { createSchemaFor } from '../repo';
import { checkContinuity, type ContinuityInput } from './continuity';
import type { RecoveryAccountExpectation, RecoveryJournalSnapshot } from './types';

const account: RecoveryAccountExpectation = { accountId: 'retained', nonce: '4', commitment: 'state-4' };
const previous: RecoveryJournalSnapshot = {
  version: 1,
  sequence: 1,
  scope: { network: 'testnet', walletGeneration: 'wallet-1', sdkGeneration: 'sdk-1' },
  accounts: [account],
  entries: []
};
const input = (): ContinuityInput => ({
  previous,
  accountIds: ['retained'],
  network: 'testnet',
  wallet: { id: 'generation', generation: 'wallet-1', origin: 'migrated' },
  sdkGeneration: 'sdk-1',
  readAccount: async () => account
});

it('accepts a coherent retained account and advances its observed floor', async () => {
  const next = { ...account, nonce: '5', commitment: 'state-5' };
  expect((await checkContinuity({ ...input(), readAccount: async () => next })).accounts).toEqual([next]);
});
it.each(['wallet', 'sdk', 'network', 'account', 'nonce', 'commitment'])(
  'refuses a retained %s continuity mismatch',
  async field => {
    const context = input();
    if (field === 'wallet') context.wallet = undefined;
    if (field === 'sdk') context.sdkGeneration = null;
    if (field === 'network') context.network = 'devnet';
    if (field === 'account') context.readAccount = async () => null;
    if (field === 'nonce') context.readAccount = async () => ({ ...account, nonce: '3' });
    if (field === 'commitment') context.readAccount = async () => ({ ...account, commitment: 'wrong-state' });
    await expect(checkContinuity(context)).rejects.toThrow();
  }
);
it('establishes first expectations only from a migrated store with every retained account present', async () => {
  expect((await checkContinuity({ ...input(), previous: undefined, sdkGeneration: null })).accounts).toEqual([account]);
});
it('refuses migration over an observed fresh database even when an SDK account survived', async () => {
  await expect(
    checkContinuity({
      ...input(),
      previous: undefined,
      sdkGeneration: null,
      wallet: { id: 'generation', generation: 'fresh', origin: 'fresh' }
    })
  ).rejects.toThrow();
});
it('allows explicitly authorized creation or import to establish a new scope', async () => {
  const result = await checkContinuity({
    ...input(),
    previous: undefined,
    sdkGeneration: null,
    establish: true,
    wallet: { id: 'generation', generation: 'fresh', origin: 'fresh' }
  });
  expect(result.scope.walletGeneration).toBe('fresh');
  expect(result.accounts).toEqual([account]);
});
it('does not accept a removed retained account during authorized account addition', async () => {
  await expect(checkContinuity({ ...input(), accountIds: ['new'], establish: true })).rejects.toThrow();
});
it('distinguishes a migrated existing wallet database from a freshly recreated database', async () => {
  const name = `continuity-migration-${Date.now()}`;
  const old = new Dexie(name);
  old.version(3.1).stores({ transactions: 'id', spendingLimits: 'accountId' });
  await old.open();
  old.close();
  const migrated = createSchemaFor(name);
  const fresh = createSchemaFor(`${name}-fresh`);
  try {
    await migrated.open();
    await fresh.open();
    expect(await migrated.table('metadata').get('generation')).toMatchObject({
      origin: 'migrated',
      generation: expect.any(String)
    });
    expect(await fresh.table('metadata').get('generation')).toMatchObject({
      origin: 'fresh',
      generation: expect.any(String)
    });
  } finally {
    migrated.close();
    fresh.close();
    await Dexie.delete(name);
    await Dexie.delete(`${name}-fresh`);
  }
});

it('refuses to recreate a missing journal when the SDK already retains an established generation', async () => {
  await expect(checkContinuity({ ...input(), previous: undefined })).rejects.toThrow();
});

it('does not recreate a missing wallet database during explicit recovery reads', async () => {
  const name = `missing-recovery-${Date.now()}`;
  await expect(readWalletGenerationForRecovery(name)).rejects.toThrow();
  expect(await Dexie.exists(name)).toBe(false);
});

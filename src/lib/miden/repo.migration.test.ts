/**
 * The v1.3/v1.4 upgrades walk the whole transactions table with `.modify()`. Dexie re-puts a deep
 * clone of every row whose callback returns anything but `false`, so a bare return there rewrote
 * every row — `resultBytes` blobs included — inside the `versionchange` transaction on the critical
 * path of `db.open()`. This asserts only the rows that actually change are written.
 */
import Dexie from 'dexie';

const DB_NAME = 'TridentMain';

const bigRow = (id: string, type: string) => ({
  id,
  type,
  status: 2,
  accountId: 'acc',
  initiatedAt: 1,
  completedAt: 1,
  resultBytes: new Uint8Array(1024)
});

describe('transactions upgrades', () => {
  it('writes only the rows the upgrade changes, and writes them correctly', async () => {
    await Dexie.delete(DB_NAME);

    // Seed at v1.2 — before the v1.3 bridge rename and the v1.4 consume backfill. A fixture per
    // ARM, not per row type: every `??` fallback in the upgrade has both sides represented, and
    // each declining condition has a row that takes it. A write-count assertion alone is
    // satisfied equally by a correct migration and by a deleted one.
    const legacy = new Dexie(DB_NAME);
    legacy.version(1.2).stores({ transactions: 'id, accountId, transactionId, initiatedAt, completedAt' });
    await legacy.open();
    await legacy.table('transactions').bulkPut([
      // v1.3: fallback side of every ?? (no extraInputs, no faucetId), status 2 -> 'pending'
      bigRow('bridge-bare', 'bridge'),
      // v1.3: populated side, and status != 2 -> 'not-applicable'
      {
        ...bigRow('bridge-full', 'bridge'),
        status: 1,
        faucetId: 'faucet-1',
        extraInputs: { destinationAddress: '0xdead', destinationNetwork: 7 }
      },
      // v1.4: the backfill arm
      { ...bigRow('consume-1', 'consume'), noteId: 'note-1' },
      // v1.4: declines — already has noteIds
      { ...bigRow('consume-done', 'consume'), noteId: 'note-2', noteIds: ['note-2'] },
      // v1.4: declines — consume with no noteId
      bigRow('consume-bare', 'consume'),
      // neither upgrade touches these
      bigRow('send-1', 'send'),
      bigRow('send-2', 'send')
    ]);
    legacy.close();

    let repo: typeof import('./repo');
    jest.isolateModules(() => {
      repo = require('./repo');
    });

    const written: string[] = [];
    repo!.transactions.hook('updating', (_mods, primKey) => {
      written.push(String(primKey));
    });

    await repo!.db.open();
    const rows = await repo!.transactions.toArray();
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));

    // WHICH rows were written...
    expect(written.sort()).toEqual(['bridge-bare', 'bridge-full', 'consume-1']);

    // ...and WHAT they became. Without these, deleting either upgrade body still passes.
    expect(byId['bridge-bare'].type).toBe('bridged-send');
    expect(byId['bridge-bare'].extraInputs).toMatchObject({
      provider: 'agglayer',
      destinationAddress: '',
      destinationNetwork: 0,
      sourceFaucetId: '',
      claimStatus: 'pending'
    });
    // The populated side. `destinationAddress` is read as a PAIR with `claimStatus` by the L1
    // claim prompt, so losing the `prev.` here would silently strand every migrated legacy claim.
    expect(byId['bridge-full'].extraInputs).toMatchObject({
      provider: 'agglayer',
      destinationAddress: '0xdead',
      destinationNetwork: 7,
      sourceFaucetId: 'faucet-1',
      claimStatus: 'not-applicable'
    });
    expect(byId['consume-1'].noteIds).toEqual(['note-1']);
    expect(byId['consume-done'].noteIds).toEqual(['note-2']);
    expect(byId['consume-bare'].noteIds).toBeUndefined();
    // The blobs the whole PR is about must survive a migration untouched.
    expect(byId['send-1'].resultBytes).toBeDefined();

    repo!.db.close();
    await Dexie.delete(DB_NAME);
  });
});

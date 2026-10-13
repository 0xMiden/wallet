/**
 * The v1.3/v1.4 upgrades walk the whole transactions table with `.modify()`. Dexie re-puts a deep
 * clone of every row whose callback returns anything but `false`, so a bare return there rewrote
 * every row - `resultBytes` blobs included - inside the `versionchange` transaction on the critical
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

    // Seed at v1.2 - before the v1.3 bridge rename and the v1.4 consume backfill. A fixture per
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
      // v1.4: declines - already has noteIds
      { ...bigRow('consume-done', 'consume'), noteId: 'note-2', noteIds: ['note-2'] },
      // v1.4: declines - consume with no noteId
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
    const get = (id: string) => {
      const r = byId[id];
      if (!r) throw new Error(`row ${id} missing after upgrade`);
      return r;
    };

    // WHICH rows were written...
    expect(written.sort()).toEqual(['bridge-bare', 'bridge-full', 'consume-1']);

    // ...and WHAT they became. Without these, deleting either upgrade body still passes.
    expect(get('bridge-bare').type).toBe('bridged-send');
    expect(get('bridge-bare').extraInputs).toMatchObject({
      provider: 'agglayer',
      destinationAddress: '',
      destinationNetwork: 0,
      sourceFaucetId: '',
      claimStatus: 'pending'
    });
    // The populated side. `destinationAddress` is read as a PAIR with `claimStatus` by the L1
    // claim prompt, so losing the `prev.` here would silently strand every migrated legacy claim.
    expect(get('bridge-full').extraInputs).toMatchObject({
      provider: 'agglayer',
      destinationAddress: '0xdead',
      destinationNetwork: 7,
      sourceFaucetId: 'faucet-1',
      claimStatus: 'not-applicable'
    });
    expect(get('consume-1').noteIds).toEqual(['note-1']);
    expect(get('consume-done').noteIds).toEqual(['note-2']);
    expect(get('consume-bare').noteIds).toBeUndefined();
    // The blobs the whole PR is about must survive a migration untouched.
    expect(get('send-1').resultBytes).toBeDefined();

    repo!.db.close();
    await Dexie.delete(DB_NAME);
  });

  it('indexes the rows stored before v1.7 by type', async () => {
    await Dexie.delete(DB_NAME);

    const legacy = new Dexie(DB_NAME);
    legacy.version(1.6).stores({
      transactions:
        'id, accountId, transactionId, initiatedAt, completedAt, noteId, *noteIds, noteDelivery, extraInputs.destinationAddress, extraInputs.swapOrderTxId'
    });
    await legacy.open();
    await legacy
      .table('transactions')
      .bulkPut([
        bigRow('send-1', 'send'),
        bigRow('receive-1', 'bridged-receive'),
        bigRow('bridge-out-1', 'bridged-send'),
        bigRow('bridge-out-2', 'bridged-send')
      ]);
    legacy.close();

    let repo: typeof import('./repo');
    jest.isolateModules(() => {
      repo = require('./repo');
    });
    await repo!.db.open();

    expect((await repo!.transactions.where('type').equals('bridged-send').primaryKeys()).sort()).toEqual([
      'bridge-out-1',
      'bridge-out-2'
    ]);
    expect(await repo!.transactions.where('type').equals('bridged-receive').primaryKeys()).toEqual(['receive-1']);

    repo!.db.close();
    await Dexie.delete(DB_NAME);
  });

  // The SDK stopped re-sending a failed private note, so the sweep's retries are the only ones. A row
  // that spent the old four-attempt budget inside the new 72-hour window gets the new schedule once.
  it('re-arms the delivery schedule of a recent row that spent the old budget, and no other', async () => {
    await Dexie.delete(DB_NAME);
    const now = Math.floor(Date.now() / 1000);
    const owed = (id: string, ageSeconds: number, fields: Record<string, unknown>) => ({
      ...bigRow(id, 'send'),
      initiatedAt: now - ageSeconds,
      completedAt: now - ageSeconds,
      outputNoteIds: [`0x${id}`],
      ...fields
    });

    const legacy = new Dexie(DB_NAME);
    legacy.version(2).stores({
      transactions:
        'id,accountId,transactionId,initiatedAt,completedAt,noteId,*noteIds,noteDelivery,extraInputs.destinationAddress,extraInputs.swapOrderTxId,spendingLimitAuthorizationId,type',
      spendingLimits: 'accountId,revision'
    });
    await legacy.open();
    await legacy.table('transactions').bulkPut([
      owed('pending-spent', 2 * 3600, { noteDelivery: 'pending', relayAttempts: 4, nextRelayAt: now + 1800 }),
      owed('undelivered-old', 80 * 3600, { noteDelivery: 'undelivered', relayAttempts: 4, nextRelayAt: now - 60 }),
      owed('relayed-spent', 2 * 3600, { noteDelivery: 'relayed', relayAttempts: 4, nextRelayAt: now + 1800 }),
      owed('restored-spent', 2 * 3600, {
        noteDelivery: 'undelivered',
        relayAttempts: 4,
        nextRelayAt: now + 1800,
        restoredFromBackup: true
      }),
      owed('undelivered-unspent', 2 * 3600, { noteDelivery: 'undelivered', relayAttempts: 2, nextRelayAt: now + 1800 })
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
    const byId = Object.fromEntries((await repo!.transactions.toArray()).map(row => [row.id, row]));

    expect(written).toEqual(['pending-spent']);
    expect(byId['pending-spent']).toMatchObject({ relayAttempts: 1, noteDelivery: 'pending' });
    expect(byId['pending-spent']!.nextRelayAt).toBeUndefined();
    expect(byId['pending-spent']!.resultBytes).toBeDefined();
    expect(byId['undelivered-old']).toMatchObject({ relayAttempts: 4, nextRelayAt: now - 60 });
    expect(byId['relayed-spent']).toMatchObject({ relayAttempts: 4, nextRelayAt: now + 1800 });
    expect(byId['restored-spent']).toMatchObject({ relayAttempts: 4, nextRelayAt: now + 1800 });
    expect(byId['undelivered-unspent']).toMatchObject({ relayAttempts: 2, nextRelayAt: now + 1800 });
    expect(repo!.db.verno).toBe(3);

    repo!.db.close();
    await Dexie.delete(DB_NAME);
  });
});

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
  it('writes only the rows the upgrade actually changes', async () => {
    await Dexie.delete(DB_NAME);

    // Seed at v1.2 — before the v1.3 bridge rename and the v1.4 consume backfill.
    const legacy = new Dexie(DB_NAME);
    legacy.version(1.2).stores({ transactions: 'id, accountId, transactionId, initiatedAt, completedAt' });
    await legacy.open();
    await legacy.table('transactions').bulkPut([
      bigRow('bridge-1', 'bridge'), // v1.3 rewrites this one
      bigRow('send-1', 'send'),
      bigRow('send-2', 'send'),
      bigRow('send-3', 'send')
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
    await repo!.transactions.toArray();

    // Only the bridge row is modified by v1.3; v1.4 matches no row here.
    expect(written.sort()).toEqual(['bridge-1']);

    repo!.db.close();
    await Dexie.delete(DB_NAME);
  });
});

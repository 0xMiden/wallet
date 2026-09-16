/**
 * `resolveUnconfirmedSwitch` is the point of no return for a pending rotation: demoting the row
 * drops it out of `listUnconfirmedSwitchRows`, so no later pass can re-derive the repair. It had
 * no direct coverage at all - every other suite mocks it - and the text it records is rendered
 * verbatim on the failure card.
 */
import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { listUnconfirmedSwitchRows, resolveUnconfirmedSwitch } from './complete';

const switchRow = (): ITransaction =>
  ({
    id: 'switch-1',
    type: 'switch-guardian',
    accountId: 'acc',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    completedAt: 1,
    displayMessage: 'Guardian switched',
    extraInputs: { newGuardianEndpoint: 'https://new.example', commitUnconfirmed: true }
  }) as unknown as ITransaction;

describe('resolveUnconfirmedSwitch', () => {
  beforeEach(async () => {
    await Repo.transactions.clear();
  });

  it('records only what it established: that the node discarded THIS switch', async () => {
    await Repo.transactions.put(switchRow());

    await resolveUnconfirmedSwitch('switch-1', false);

    const row = await Repo.transactions.get('switch-1');
    expect(row?.status).toBe(ITransactionStatus.Failed);
    expect(row?.displayMessage).toBe('Guardian switch discarded');
    expect(row?.error).toBe('The node discarded this guardian switch after submission.');
    // The claim this case exists to forbid. This function reads nothing about the account's
    // current binding, and with two rotations unconfirmed at once (A to B discarded while
    // B to C commits) the previous guardian is NOT the active one.
    expect(row?.error).not.toMatch(/previous guardian/i);
    expect(row?.extraInputs?.commitUnconfirmed).toBe(false);
  });

  it('upgrades a landed rotation instead of demoting it', async () => {
    await Repo.transactions.put(switchRow());

    await resolveUnconfirmedSwitch('switch-1', true);

    const row = await Repo.transactions.get('switch-1');
    expect(row?.status).toBe(ITransactionStatus.Completed);
    expect(row?.displayMessage).toBe('Guardian switched');
    expect(row?.extraInputs?.commitUnconfirmed).toBe(false);
    expect(row?.error).toBeUndefined();
  });
});

/**
 * The read this list feeds runs on a 3 s loop, and its entry point moved from the
 * `accountId` index to the `type` one - so the account match moved out of the index and
 * into the cursor predicate. What a timing measurement cannot show is whether everything
 * the old query excluded is still excluded, which is what this pins.
 */
describe('listUnconfirmedSwitchRows', () => {
  const rowWith = (over: Record<string, unknown>): ITransaction =>
    ({ ...switchRow(), ...over }) as unknown as ITransaction;

  beforeEach(async () => {
    await Repo.transactions.clear();
  });

  it("returns this account's unconfirmed switch rows and nothing else", async () => {
    await Repo.transactions.bulkPut([
      rowWith({ id: 'mine', accountId: 'acc' }),
      rowWith({ id: 'another-account', accountId: 'acc-2' }),
      rowWith({ id: 'not-a-switch', accountId: 'acc', type: 'send' }),
      rowWith({
        id: 'already-settled',
        accountId: 'acc',
        extraInputs: { newGuardianEndpoint: 'https://new.example', commitUnconfirmed: false }
      })
    ]);

    const rows = await listUnconfirmedSwitchRows('acc');

    expect(rows.map(row => row.id)).toEqual(['mine']);
  });

  it('answers empty rather than throwing when the account has no history at all', async () => {
    expect(await listUnconfirmedSwitchRows('acc')).toEqual([]);
  });
});

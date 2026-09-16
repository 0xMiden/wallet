/**
 * `resolveUnconfirmedSwitch` is the point of no return for a pending rotation: demoting the row
 * drops it out of `listUnconfirmedSwitchRows`, so no later pass can re-derive the repair. It had
 * no direct coverage at all - every other suite mocks it - and the text it records is rendered
 * verbatim on the failure card.
 */
import { ITransactionStatus } from 'lib/miden/db/types';
import type { ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { resolveUnconfirmedSwitch } from './complete';

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

import type { ITransaction } from 'lib/miden/db/types';

import { selectRecentRecipients } from './useRecentRecipients';

// `selectRecentRecipients` is the whole of the recents feature: account
// scoping, self-exclusion, dedupe, ordering and the bridged-send recipient
// shape all live here. `SendManager` mocks the hook wholesale, so without
// these the logic never actually runs under test.

const ACCOUNT = 'mtst1apfjwvs5f8mey5f6a6s5llnhp533fe5p';
const SEPOLIA_CHAIN_ID = 11155111;

const sendRow = (over: Partial<ITransaction> = {}): ITransaction =>
  ({
    type: 'send',
    accountId: ACCOUNT,
    secondaryAccountId: 'mtst1ap2autzy2mgkuqt6hx3qscrkd5hsxefv',
    initiatedAt: 1_000,
    completedAt: 1_000,
    ...over
  }) as unknown as ITransaction;

const bridgedRow = (
  over: Partial<ITransaction> = {},
  destinationAddress = '0x1111111111111111111111111111111111111111'
) =>
  ({
    type: 'bridged-send',
    accountId: ACCOUNT,
    secondaryAccountId: 'mtst1apbridgeallocator000000000000000',
    initiatedAt: 1_000,
    completedAt: 1_000,
    extraInputs: { destinationAddress, destinationNetwork: SEPOLIA_CHAIN_ID },
    ...over
  }) as unknown as ITransaction;

describe('selectRecentRecipients', () => {
  // A dump's rows must never become a trust signal. This is a fund-loss path:
  // the list is offered at the moment the user picks a destination, and the
  // wallet presenting an address as "recent" is the wallet vouching for it.
  it('excludes rows restored from a backup', () => {
    const attacker = sendRow({
      secondaryAccountId: 'mtst1apattacker0000000000000000000000',
      completedAt: 9_999,
      restoredFromBackup: true
    });
    const genuine = sendRow({ secondaryAccountId: 'mtst1apgenuine00000000000000000000000', completedAt: 10 });

    const recents = selectRecentRecipients([attacker, genuine], ACCOUNT);

    expect(recents.map(r => r.address)).toEqual(['mtst1apgenuine00000000000000000000000']);
  });

  it('excludes a restored bridged send even though it is the newest row', () => {
    const attacker = bridgedRow(
      { completedAt: 9_999, restoredFromBackup: true },
      '0x2222222222222222222222222222222222222222'
    );

    expect(selectRecentRecipients([attacker], ACCOUNT)).toEqual([]);
  });

  it('returns distinct recipients newest first', () => {
    const older = sendRow({ secondaryAccountId: 'mtst1apolder', completedAt: 10 });
    const newer = sendRow({ secondaryAccountId: 'mtst1apnewer', completedAt: 20 });

    expect(selectRecentRecipients([older, newer], ACCOUNT).map(r => r.address)).toEqual([
      'mtst1apnewer',
      'mtst1apolder'
    ]);
  });

  it('keeps only the most recent send per address', () => {
    const rows = [
      sendRow({ secondaryAccountId: 'mtst1aprepeat', completedAt: 10 }),
      sendRow({ secondaryAccountId: 'mtst1aprepeat', completedAt: 30 }),
      sendRow({ secondaryAccountId: 'mtst1apother', completedAt: 20 })
    ];

    expect(selectRecentRecipients(rows, ACCOUNT).map(r => r.address)).toEqual(['mtst1aprepeat', 'mtst1apother']);
  });

  it('caps the list at five recipients', () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      sendRow({ secondaryAccountId: `mtst1apaddr${i}`, completedAt: i })
    );

    expect(selectRecentRecipients(rows, ACCOUNT)).toHaveLength(5);
  });

  it('ignores sends made from a different account', () => {
    const mine = sendRow({ secondaryAccountId: 'mtst1apmine' });
    const theirs = sendRow({ accountId: 'mtst1apsomeoneelse', secondaryAccountId: 'mtst1aptheirs' });

    expect(selectRecentRecipients([mine, theirs], ACCOUNT).map(r => r.address)).toEqual(['mtst1apmine']);
  });

  // Stored ids may carry a note-tag suffix, which is why the hook scopes with
  // `compareAccountIds` rather than an equality check on the raw id.
  it('matches the account through a note-tag suffix on the stored id', () => {
    const row = sendRow({ accountId: `${ACCOUNT}_tag42`, secondaryAccountId: 'mtst1apsuffixed' });

    expect(selectRecentRecipients([row], ACCOUNT).map(r => r.address)).toEqual(['mtst1apsuffixed']);
  });

  it('never suggests the account back to itself', () => {
    const rows = [sendRow({ secondaryAccountId: ACCOUNT }), sendRow({ secondaryAccountId: `${ACCOUNT}_tag7` })];

    expect(selectRecentRecipients(rows, ACCOUNT)).toEqual([]);
  });

  it('takes a bridged send from its destination address and names the network', () => {
    expect(selectRecentRecipients([bridgedRow()], ACCOUNT)).toEqual([
      {
        address: '0x1111111111111111111111111111111111111111',
        chain: 'ethereum',
        networkName: 'Sepolia'
      }
    ]);
  });

  it('leaves the network unnamed for an unrecognised chain id', () => {
    const row = bridgedRow({ extraInputs: { destinationAddress: '0xabc', destinationNetwork: 999 } });

    expect(selectRecentRecipients([row], ACCOUNT)[0]?.networkName).toBeUndefined();
  });

  it('skips rows carrying no usable recipient', () => {
    const rows = [
      sendRow({ secondaryAccountId: undefined }),
      sendRow({ secondaryAccountId: '   ' }),
      bridgedRow({ extraInputs: {} })
    ];

    expect(selectRecentRecipients(rows, ACCOUNT)).toEqual([]);
  });

  // A queued row has no `completedAt` yet, so it must still sort.
  it('orders a not-yet-completed send by when it was initiated', () => {
    const completed = sendRow({ secondaryAccountId: 'mtst1apdone', completedAt: 10, initiatedAt: 10 });
    const queued = sendRow({ secondaryAccountId: 'mtst1apqueued', completedAt: undefined, initiatedAt: 50 });

    expect(selectRecentRecipients([completed, queued], ACCOUNT).map(r => r.address)).toEqual([
      'mtst1apqueued',
      'mtst1apdone'
    ]);
  });
});

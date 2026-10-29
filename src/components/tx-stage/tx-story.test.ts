import { storyFromMessages, storyFromNoteFlow, sumAssets } from './tx-story';

describe('transaction story', () => {
  it('reads a send as you paying the recipient, then the fee to the network', () => {
    const hops = storyFromMessages(
      [
        'Transfer note from faucet:',
        'mtst1faucet',
        'From, mtst1me',
        'Amount, 7.25 MIDEN',
        'Recipient, mtst1them',
        'Note Type, Private',
        'Fee, 0.21 MIDEN'
      ],
      { skip: 2 }
    );
    expect(hops[0]).toMatchObject({
      from: { role: 'you', name: 'mtst1me' },
      to: { role: 'recipient', name: 'mtst1them' },
      amount: '7.25 MIDEN',
      via: 'Private'
    });
    expect(hops[1]).toMatchObject({ from: { role: 'you' }, to: { role: 'network' }, amount: '0.21 MIDEN' });
  });

  it('reads a consume as a note paying you', () => {
    const hops = storyFromMessages(['Consuming a note', 'Amount, 20 USDC', 'Note Type, Private'], {
      skip: 1,
      incoming: true
    });
    expect(hops[0]).toMatchObject({
      from: { role: 'sender' },
      to: { role: 'you' },
      amount: '20 USDC',
      via: 'Private'
    });
  });

  it('ignores an address that is not a labeled amount', () => {
    expect(storyFromMessages(['mtst1apsnkg6x57', 'NoComma'])).toEqual([]);
  });

  it('turns decoded notes into consumed hops and created hops', () => {
    const hops = storyFromNoteFlow(
      {
        inputs: [
          { sender: 'mtst1alice', visibility: 'private', kind: 'P2ID', assets: [{ faucetId: 'fA', amount: 10n }] }
        ],
        outputs: [
          { visibility: 'public', kind: 'P2ID' },
          { visibility: 'public', kind: 'fee' }
        ]
      },
      'mtst1me'
    );
    expect(hops.map(hop => [hop.from.role, hop.to.role, hop.via])).toEqual([
      ['sender', 'you', 'private'],
      ['you', 'recipient', 'public'],
      ['you', 'network', 'public']
    ]);
    expect(hops[0]?.assets).toEqual([{ faucetId: 'fA', amount: 10n }]);
    expect(
      sumAssets([
        { faucetId: 'fA', amount: 10n },
        { faucetId: 'fA', amount: 4n }
      ])
    ).toEqual([{ faucetId: 'fA', amount: 14n }]);
  });
});

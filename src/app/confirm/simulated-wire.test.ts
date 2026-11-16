import type { TxAssetView } from './decode';
import type { NoteFlow } from './note-flow';
import { fromSimulatedEffectsWire, toSimulatedEffectsWire, type SimulatedEffectsWire } from './simulated-wire';

const view: TxAssetView = {
  account: 'mtst1account',
  outgoing: [{ faucetId: 'fA', amount: 2n ** 64n + 1n }],
  incoming: [{ faucetId: 'fB', amount: 1n }],
  outgoingNfts: [{ faucetId: 'fC', assetId: '0xab..cd', key: 'fC:0xabcd' }],
  incomingNfts: [],
  unlistedAssets: 1,
  inputNotesConsumed: 1,
  outputNotesCreated: 1,
  fee: { faucetId: 'fN', amount: 3n },
  storageChanged: true
};

const flow: NoteFlow = {
  inputCount: 1,
  inputs: [
    {
      id: '0xinput',
      kind: 'P2ID',
      visibility: 'public',
      sender: 'mtst1sender',
      assets: [{ faucetId: 'fB', amount: 1n }],
      nfts: [{ faucetId: 'fC', assetId: '0xab..cd' }],
      scriptRoot: '0xroot'
    }
  ],
  outputs: [{ kind: 'fee', visibility: 'public', assets: [{ faucetId: 'fN', amount: 3n }] }],
  storageChanges: [{ slotName: 'slot', kind: 'map', operation: 'update', entryCount: 2 }]
};

describe('simulated effects wire', () => {
  it('round-trips a view and note flow through JSON with every amount exact', () => {
    const wire: SimulatedEffectsWire = JSON.parse(JSON.stringify(toSimulatedEffectsWire(view, flow)));

    expect(fromSimulatedEffectsWire(wire)).toEqual({ view, noteFlow: flow });
  });

  it('round-trips a view with no fee and no note flow', () => {
    const feeless: TxAssetView = { ...view };
    delete feeless.fee;
    const wire: SimulatedEffectsWire = JSON.parse(JSON.stringify(toSimulatedEffectsWire(feeless)));

    const decoded = fromSimulatedEffectsWire(wire);

    expect(decoded).toEqual({ view: feeless });
    expect(decoded.view).not.toHaveProperty('fee');
    expect(decoded).not.toHaveProperty('noteFlow');
  });

  it('sends a holdings view without its note lists and with its held note count', () => {
    const holdings: TxAssetView = {
      ...view,
      viewConsumedNotes: [{ id: '0xheld', amounts: [{ faucetId: 'fA', amount: 1000n }], nfts: [] }],
      createdNotes: [{ id: '0xsent', amounts: [{ faucetId: 'fA', amount: 1050n }], nfts: [], opaque: true }],
      heldNotesSpent: 1
    };
    const wire: SimulatedEffectsWire = JSON.parse(JSON.stringify(toSimulatedEffectsWire(holdings)));

    expect(wire.view).not.toHaveProperty('viewConsumedNotes');
    expect(wire.view).not.toHaveProperty('createdNotes');
    expect(wire.view.heldNotesSpent).toBe(1);
    const { viewConsumedNotes: _consumed, createdNotes: _created, ...shown } = holdings;
    expect(fromSimulatedEffectsWire(wire)).toEqual({ view: shown });
  });

  it('refuses an amount that is not a non-negative integer', () => {
    const good = toSimulatedEffectsWire(view, flow);
    const placements: Array<(amount: string) => SimulatedEffectsWire> = [
      amount => ({ ...good, view: { ...good.view, outgoing: [{ faucetId: 'fA', amount }] } }),
      amount => ({ ...good, view: { ...good.view, incoming: [{ faucetId: 'fB', amount }] } }),
      amount => ({ ...good, view: { ...good.view, fee: { faucetId: 'fN', amount } } }),
      amount => ({
        ...good,
        noteFlow: {
          inputCount: 1,
          inputs: [{ kind: 'P2ID', visibility: 'public', assets: [{ faucetId: 'fB', amount }] }],
          outputs: []
        }
      }),
      amount => ({
        ...good,
        noteFlow: {
          inputCount: 0,
          inputs: [],
          outputs: [{ kind: 'fee', visibility: 'public', assets: [{ faucetId: 'fN', amount }] }]
        }
      })
    ];

    for (const amount of ['-1', '1.5', '0x10', '', ' 1']) {
      for (const place of placements) {
        expect(() => fromSimulatedEffectsWire(place(amount))).toThrow('malformed simulated effects');
      }
    }
    for (const place of placements) {
      expect(() => fromSimulatedEffectsWire(place('7'))).not.toThrow();
    }
  });
});

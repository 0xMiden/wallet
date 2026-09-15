/**
 * The E2E swap hooks share the realm's one WASM client with every production
 * read and write, so each of their calls runs under the client lock: one labelled
 * hold from the call through every read of what it returned, released across the
 * discovery wait, never nested (#878). An evicted hold is abandoned, not
 * cancelled (#775), so each hold asserts it is still current after every parking
 * await and before reaching into what a call returned.
 */
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { installSwapConsumeHooks } from './test-hooks';

const held = { count: 0, labels: [] as string[], nestedAt: 0, heldAtSleep: [] as boolean[], revoked: false };

const requireHeld = (what: string) => {
  if (held.count === 0) throw new Error(`${what} called with no WASM lock hold`);
};

// Every accessor is a WASM call on an object borrowed from the client, so each requires the hold.
const record = (orderId: number, id: string) => ({
  id: () => {
    requireHeld('record.id');
    return { toString: () => id };
  },
  details: () => {
    requireHeld('record.details');
    return { recipient: () => ({ serialNum: () => ({ toFelts: () => [0, { asInt: () => orderId }] }) }) };
  },
  metadata: () => {
    requireHeld('record.metadata');
    return { tag: () => ({ asU32: () => 7 }), noteType: () => 1 };
  },
  recipient: () => {
    requireHeld('record.recipient');
    return { script: () => ({ root: () => ({ toHex: () => 'root' }) }) };
  }
});

let lists: any[][] = [];
const fakeClient = {
  syncState: jest.fn(async () => requireHeld('syncState')),
  exportNote: jest.fn(async (_id: string, _type: unknown, assertLive?: (step?: string) => void) => {
    requireHeld('exportNote');
    assertLive?.('before serializing the export');
    return new Uint8Array([1, 2]);
  }),
  getAccount: jest.fn(async () => {
    requireHeld('getAccount');
    return {
      vault: () => {
        requireHeld('vault');
        return {
          getBalance: () => {
            requireHeld('vault.getBalance');
            return 5n;
          },
          fungibleAssets: () => []
        };
      }
    };
  }),
  importNoteBytes: jest.fn(async () => 'imported'),
  client: {
    notes: {
      listSent: jest.fn(async () => {
        requireHeld('listSent');
        return [record(1, 'sent-1')];
      }),
      list: jest.fn(async () => {
        requireHeld('notes.list');
        return lists.shift() ?? [];
      })
    },
    tags: { add: jest.fn(async () => requireHeld('tags.add')) },
    pswap: {
      lineage: jest.fn(async () => {
        requireHeld('lineage');
        return {
          state: () => {
            requireHeld('lineage.state');
            return 0;
          },
          remainingOffered: () => {
            requireHeld('lineage.remainingOffered');
            return 1n;
          },
          remainingRequested: () => {
            requireHeld('lineage.remainingRequested');
            return 2n;
          }
        };
      }),
      cancelByOrder: jest.fn(async () => requireHeld('cancelByOrder'))
    },
    transactions: { pswapConsume: jest.fn(async () => requireHeld('pswapConsume')) }
  }
};

const getMidenClient = jest.fn(async () => fakeClient);

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: () => getMidenClient(),
  // The production shape: the label rides on the cause, the message is the closed set.
  assertWasmHoldCurrent: (_hold: object, where: string, step?: string) => {
    if (held.revoked) {
      throw new WasmClientPoisonedError(
        'watchdog',
        new Error(`operation abandoned ${where}${step ? `, ${step}` : ''}`)
      );
    }
  },
  withWasmClientLock: async (fn: (hold: object) => Promise<unknown>, options?: { label?: string }) => {
    if (held.count > 0) held.nestedAt++;
    held.count++;
    held.labels.push(options?.label ?? '');
    try {
      return await fn({});
    } finally {
      held.count--;
    }
  }
}));
jest.mock('lib/miden/sdk/miden-client-interface', () => ({ remoteProver: () => undefined }));
jest.mock('lib/miden/sdk/helpers', () => ({ accountIdStringToSdk: (s: string) => ({ toString: () => s }) }));
jest.mock('./tokens', () => ({ _setSwapTokensForTest: jest.fn() }));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  buildSwapTag: () => ({ asU32: () => 7 }),
  NoteScript: {
    p2id: () => ({ root: () => ({ toHex: () => 'p2id' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => 'p2ide' }) })
  },
  NoteType: { Private: 0, Public: 1 }
}));

const g = globalThis as any;

beforeAll(() => installSwapConsumeHooks());
beforeEach(() => {
  held.count = 0;
  held.labels = [];
  held.nestedAt = 0;
  held.heldAtSleep = [];
  held.revoked = false;
  lists = [];
  jest.clearAllMocks();
});

describe('E2E swap hooks under the realm client lock (#878)', () => {
  it('the read hooks run their call and every read of what it returned inside one labelled hold', async () => {
    await expect(g.__TEST_PSWAP_ORDER_INFO__()).resolves.toMatchObject({ ok: true });
    await expect(g.__TEST_INSPECT_SENT_NOTE__('sent-1')).resolves.toMatchObject({ ok: true, isPublic: true });
    await expect(g.__TEST_EXPORT_NOTE__('sent-1')).resolves.toMatchObject({ ok: true, hex: '0102' });
    await expect(g.__TEST_PSWAP_LINEAGE__('1')).resolves.toMatchObject({ ok: true, remainingOffered: '1' });
    await expect(g.__TEST_TOKEN_BALANCE__({ accountId: 'acc', faucetId: 'f' })).resolves.toMatchObject({
      ok: true,
      balance: '5'
    });
    expect(held.labels).toEqual([
      'pswap-order-info',
      'pswap-inspect-sent-note',
      'pswap-export-note',
      'pswap-lineage',
      'pswap-token-balance'
    ]);
    expect(held.nestedAt).toBe(0);
    expect(held.count).toBe(0);
  });

  it('the discovery takes one hold per round, released across the wait, and never nests the fill inside it', async () => {
    // The second round's hit arrives in the SDK's wrapper form, reached through inputNoteRecord().
    lists = [[record(99, 'other')], [{ inputNoteRecord: () => record(42, 'note-42') }]];
    const sleeps = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
      held.heldAtSleep.push(held.count > 0);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never);
    try {
      await expect(
        g.__TEST_PSWAP_CONSUME__({
          accountId: 'acc',
          orderId: '42',
          offerFaucetId: 'f1',
          requestFaucetId: 'f2',
          offerAmount: '1',
          requestAmount: '1',
          fillAmount: '1',
          tagU32: '7'
        })
      ).resolves.toMatchObject({ ok: true, noteId: 'note-42' });
    } finally {
      sleeps.mockRestore();
    }
    expect(held.labels).toEqual(['pswap-discovery-tag', 'pswap-discovery', 'pswap-discovery', 'pswap-fill']);
    // The wait between rounds ran with no hold open.
    expect(held.heldAtSleep).toEqual([false]);
    expect(held.nestedAt).toBe(0);
    expect(fakeClient.client.transactions.pswapConsume).toHaveBeenCalledTimes(1);
    // The client is resolved inside every hold: the tag subscription, each round, the fill.
    expect(getMidenClient).toHaveBeenCalledTimes(4);
  });

  describe('an evicted hold fails at its next step instead of driving the replaced client (#775)', () => {
    // The named step completes, then the hold is no longer current.
    const revokeAt = (step: jest.Mock, value?: unknown) =>
      step.mockImplementationOnce(async () => {
        held.revoked = true;
        return value;
      });
    // The hook's response names the hold and the step, off the poison error's cause.
    const revokedAt = (where: string) => ({
      ok: false,
      error: expect.stringContaining(
        `WASM client poisoned (watchdog): held the WASM client lock past its watchdog ceiling (operation abandoned ${where})`
      )
    });
    const consumeArgs = {
      accountId: 'acc',
      orderId: '42',
      offerFaucetId: 'f1',
      requestFaucetId: 'f2',
      offerAmount: '1',
      requestAmount: '1',
      fillAmount: '1',
      tagU32: '7'
    };

    it.each([
      [
        '__TEST_PSWAP_ORDER_INFO__',
        () => g.__TEST_PSWAP_ORDER_INFO__(),
        () => fakeClient.client.notes.listSent,
        'pswap-order-info after sync'
      ],
      [
        '__TEST_INSPECT_SENT_NOTE__',
        () => g.__TEST_INSPECT_SENT_NOTE__('sent-1'),
        () => fakeClient.client.notes.listSent,
        'pswap-inspect-sent-note after sync'
      ],
      [
        '__TEST_EXPORT_NOTE__',
        () => g.__TEST_EXPORT_NOTE__('sent-1'),
        () => fakeClient.exportNote,
        'pswap-export-note after sync'
      ],
      [
        '__TEST_PSWAP_LINEAGE__',
        () => g.__TEST_PSWAP_LINEAGE__('1'),
        () => fakeClient.client.pswap.lineage,
        'pswap-lineage after sync'
      ],
      [
        '__TEST_TOKEN_BALANCE__',
        () => g.__TEST_TOKEN_BALANCE__({ accountId: 'acc', faucetId: 'f' }),
        () => fakeClient.getAccount,
        'pswap-token-balance after sync'
      ]
    ])('%s revoked at its sync never makes its read', async (_name, call, next, where) => {
      revokeAt(fakeClient.syncState);
      await expect(call()).resolves.toMatchObject(revokedAt(where));
      expect(next()).not.toHaveBeenCalled();
    });

    it('the deterministic handoff revoked at the import never syncs again or consumes', async () => {
      revokeAt(fakeClient.importNoteBytes, 'imported');
      await expect(g.__TEST_PSWAP_CONSUME__({ ...consumeArgs, noteFileHex: '00' })).resolves.toMatchObject(
        revokedAt('pswap-fill-handoff after the import')
      );
      expect(fakeClient.syncState).toHaveBeenCalledTimes(1);
      expect(fakeClient.client.transactions.pswapConsume).not.toHaveBeenCalled();
    });

    it('a tag subscription revoked at the client build never adds the tag', async () => {
      revokeAt(getMidenClient, fakeClient);
      await expect(g.__TEST_PSWAP_CONSUME__(consumeArgs)).resolves.toMatchObject(
        revokedAt('pswap-discovery-tag after the client build')
      );
      expect(fakeClient.client.tags.add).not.toHaveBeenCalled();
    });

    it('the fill revoked at its sync never consumes', async () => {
      lists = [[record(42, 'note-42')]];
      // The discovery round's sync passes; the fill's own sync revokes.
      fakeClient.syncState.mockImplementationOnce(async () => requireHeld('syncState'));
      revokeAt(fakeClient.syncState);
      await expect(g.__TEST_PSWAP_CONSUME__(consumeArgs)).resolves.toMatchObject(revokedAt('pswap-fill after sync'));
      expect(held.labels).toEqual(['pswap-discovery-tag', 'pswap-discovery', 'pswap-fill']);
      expect(fakeClient.client.transactions.pswapConsume).not.toHaveBeenCalled();
    });

    it('the cancel revoked at its sync never cancels', async () => {
      revokeAt(fakeClient.syncState);
      await expect(g.__TEST_PSWAP_CANCEL__({ orderId: '1' })).resolves.toMatchObject(
        revokedAt('pswap-cancel after sync')
      );
      expect(fakeClient.client.pswap.cancelByOrder).not.toHaveBeenCalled();
    });

    it('the export revoked inside the export never reduces the bytes', async () => {
      // The wrapper's seam, invoked by the fake after the hold was revoked mid-export.
      fakeClient.exportNote.mockImplementationOnce(
        async (_id: string, _type: unknown, assertLive?: (step?: string) => void) => {
          held.revoked = true;
          assertLive?.('before serializing the export');
          return new Uint8Array([1, 2]);
        }
      );
      await expect(g.__TEST_EXPORT_NOTE__('sent-1')).resolves.toMatchObject(
        revokedAt('pswap-export-note inside the export, before serializing the export')
      );
    });

    it('the lineage revoked by its own return never reaches into the record', async () => {
      const state = jest.fn(() => 0);
      revokeAt(fakeClient.client.pswap.lineage, { state, remainingOffered: () => 1n, remainingRequested: () => 2n });
      await expect(g.__TEST_PSWAP_LINEAGE__('1')).resolves.toMatchObject(
        revokedAt('pswap-lineage before the record read')
      );
      expect(state).not.toHaveBeenCalled();
    });
  });
});

import { guardianDappAxis } from './dapp-axis';
import { abortsLeg, deadlineIn, InfrastructureFault } from './dapp-cells';
import type { Journey } from './dapp-journey';
import { journeyNoteIdsSeenOver, nativeNoteTo, noteIdsSeenOver, sideOf } from './dapp-writes';
import { mintFromPublicFaucet, PublicFaucetError } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';
import type { DappHandle } from './test-dapp';

// @playwright/test does not load under Jest; dapp-writes only needs its expect (as in dapp-assertions.test.ts).
jest.mock('@playwright/test', () => ({ expect: (globalThis as typeof globalThis & { expect: typeof expect }).expect }));
jest.mock('./public-faucet', () => ({ ...jest.requireActual('./public-faucet'), mintFromPublicFaucet: jest.fn() }));
jest.mock('./public-note-commitment', () => ({ waitForPublicNoteCommitment: jest.fn() }));

const NOTE = `0x${'ab'.repeat(32)}`;
const journey = { env: { name: 'testnet', rpcUrl: 'https://rpc.testnet.miden.io' } } as unknown as Journey;

describe('nativeNoteTo', () => {
  beforeEach(() => {
    jest.mocked(mintFromPublicFaucet).mockReset().mockResolvedValue({ noteId: NOTE });
    jest.mocked(waitForPublicNoteCommitment).mockReset().mockResolvedValue(undefined);
  });

  it("returns the grant's note once that note is on chain", async () => {
    await expect(nativeNoteTo(journey, 'mtst1qsecond_qruqqypuyph')).resolves.toEqual({ noteId: NOTE });
    expect(jest.mocked(mintFromPublicFaucet).mock.calls).toEqual([
      ['https://faucet-api.testnet.miden.io', 'mtst1qsecond']
    ]);
    expect(jest.mocked(waitForPublicNoteCommitment).mock.calls).toEqual([['https://rpc.testnet.miden.io', NOTE]]);
  });

  it('reports a grant whose note never commits as the faucet stopping the leg', async () => {
    jest
      .mocked(waitForPublicNoteCommitment)
      .mockRejectedValue(new PublicFaucetError(`Public faucet note ${NOTE} did not commit within 180000ms`));
    const failure = await nativeNoteTo(journey, 'mtst1qsecond').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureFault);
    expect(abortsLeg(failure)).toBe(true);
    expect(String(failure)).toContain('did not commit');
  });

  it('reports a refused grant the same way, without waiting for a note', async () => {
    jest.mocked(mintFromPublicFaucet).mockRejectedValue(new PublicFaucetError('Public faucet mint failed (502): '));
    const failure = await nativeNoteTo(journey, 'mtst1qsecond').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InfrastructureFault);
    expect(abortsLeg(failure)).toBe(true);
    expect(jest.mocked(waitForPublicNoteCommitment)).not.toHaveBeenCalled();
  });
});

describe('noteIdsSeenOver', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // A wallet page whose published sync data changes once per forced sync: each lap's stamp, then each lap's notes, a
  // bare id being a note whose sender the wallet did not record.
  type Listed = string | { id: string; sender: string };
  const walletPublishing = (
    laps: Array<{ stamp: (since: number) => number; notes: Listed[] }>,
    senders: readonly string[] = []
  ) => {
    let lap = -1;
    let since = 0;
    const evaluate = jest.fn(async (read: () => unknown) => {
      const current = laps[Math.min(lap, laps.length - 1)];
      if (String(read).includes('syncedAt')) return current === undefined ? null : current.stamp(since);
      return (current?.notes ?? []).map(note => ({
        id: typeof note === 'string' ? note : note.id,
        amountBaseUnits: '1',
        faucetId: '0xfa',
        senderAddress: typeof note === 'string' ? '' : note.sender
      }));
    });
    const triggerSync = jest.fn(async () => {
      lap += 1;
    });
    const j = { walletA: { page: { evaluate }, triggerSync }, senders: () => senders } as unknown as Journey;
    return { j, triggerSync, start: () => (since = Date.now()) };
  };
  const ctx = () => ({ deadline: deadlineIn(60_000, 'R1-custom'), evidence: {}, softFail: jest.fn() });

  it('reads until the given number of syncs were stamped after the call, so a lap ending on an older sync is not one', async () => {
    const { j, triggerSync, start } = walletPublishing([
      { stamp: since => since - 5_000, notes: [] },
      { stamp: since => since + 1, notes: [] },
      { stamp: since => since + 2, notes: ['0xAB12'] }
    ]);
    start();
    const seen = noteIdsSeenOver(j, 2, ctx());
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await seen).toEqual(['ab12']);
    expect(triggerSync).toHaveBeenCalledTimes(3);
  });

  it('keeps every id any lap listed', async () => {
    const { j, start } = walletPublishing([
      { stamp: since => since + 1, notes: ['0xA1'] },
      { stamp: since => since + 2, notes: ['0xB2'] }
    ]);
    start();
    const seen = noteIdsSeenOver(j, 2, ctx());
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await seen).sort()).toEqual(['a1', 'b2']);
  });

  describe('journeyNoteIdsSeenOver', () => {
    // The m3 event (task 15): a public native note from an account the journey never made, auto-consumed a lap later.
    const STRANGER = 'mtst1aq03h59x5cftt5g0nrcvuvmrgsysq2g6';
    const JOURNEY = ['mtst1qprimary', 'mtst1qwalletb', 'mtst1qclifaucet', 'mtst1qpublicfaucet'];
    const readAfterLap = async (j: Journey, start: () => void) => {
      start();
      const seen = journeyNoteIdsSeenOver(j, 1, ctx());
      await jest.advanceTimersByTimeAsync(5_000);
      return (await seen).sort();
    };

    it("leaves a stranger's notes out of R11's two reads, so one consumed and one arriving between them change nothing", async () => {
      const { j, start } = walletPublishing(
        [
          {
            stamp: since => since + 1,
            notes: [
              { id: '0xA1', sender: 'mtst1qclifaucet' },
              { id: '0xD2B3', sender: STRANGER }
            ]
          },
          {
            stamp: since => since + 1,
            notes: [
              { id: '0xA1', sender: 'mtst1qclifaucet' },
              { id: '0xE4', sender: STRANGER }
            ]
          }
        ],
        JOURNEY
      );
      const before = await readAfterLap(j, start);
      expect(before).toEqual(['a1']);
      expect(await readAfterLap(j, start)).toEqual(before);
    });

    it('keeps a note a journey account sent or one with no recorded sender, so a note the import made still fails R11', async () => {
      const { j, start } = walletPublishing(
        [
          { stamp: since => since + 1, notes: [{ id: '0xA1', sender: 'mtst1qclifaucet' }] },
          {
            stamp: since => since + 1,
            notes: [
              { id: '0xA1', sender: 'mtst1qclifaucet' },
              '0xB2',
              { id: '0xC3', sender: 'mtst1qprimary_qruqqypuyph' }
            ]
          }
        ],
        JOURNEY
      );
      const before = await readAfterLap(j, start);
      expect(await readAfterLap(j, start)).toEqual([...before, 'b2', 'c3']);
    });
  });
});

describe('sideOf', () => {
  const dapp = {
    label: 'one',
    page: { evaluate: jest.fn(async () => ({ connected: { accountIdHex: '0xaccount' } })) }
  } as unknown as DappHandle;
  const guardianJourney = {
    axis: guardianDappAxis('https://guardian.openzeppelin.com'),
    walletA: {},
    nativeFaucetId: 'mtst1qfee',
    account: async (slot: string) => `mtst1q${slot}`
  } as unknown as Journey;

  it('checks a write from the third account as single-sig on the Guardian leg, and every other slot by the leg', async () => {
    const third = await sideOf(guardianJourney, dapp, 'third');
    expect({ account: third.account, axis: third.axis.label }).toEqual({ account: 'mtst1qthird', axis: 'offchain' });
    expect((await sideOf(guardianJourney, dapp, 'second')).axis.label).toBe('guardian');
    expect((await sideOf(guardianJourney, dapp)).axis.label).toBe('guardian');
  });
});

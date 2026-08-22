/**
 * The reclaim window is validated at the choke point every send funnels
 * through, not only at the dApp boundary.
 *
 * `recallBlocks` is stored on chain as a 32-bit block height and a value that
 * does not fit is TRUNCATED rather than refused, so a window just past the
 * limit wraps to zero: the note becomes reclaimable the moment it lands while
 * the screen that asked for consent says years, and a recipient who does not
 * claim in time loses the funds to the sender's reclaim. A negative window
 * wraps the other way and puts the sender's own recall out of reach.
 *
 * The wallet's own review screen reaches this by `parseInt`ing a date the user
 * picked from a calendar, so an out-of-range window is a couple of taps away
 * and needs no hostile page at all — which is why the guard cannot live only in
 * the dApp request handler.
 */
import { MAX_RECALL_BLOCKS } from '../helpers';
import { NoteTypeEnum } from '../types';
import { initiateSendTransaction } from './initiate';

const mockAdd = jest.fn(async () => undefined);
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { add: mockAdd };
  }
}));

jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: async (fn: () => unknown) => fn() }));
jest.mock('../activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/store', () => ({ getIntercom: jest.fn() }));
jest.mock('lib/platform', () => ({ isExtension: () => true }));

const send = (recallBlocks?: number) =>
  initiateSendTransaction('mtst1sender', 'mtst1recipient', 'mtst1faucet', NoteTypeEnum.Private, 1000n, recallBlocks);

beforeEach(() => jest.clearAllMocks());

describe('initiateSendTransaction — reclaim window bounds', () => {
  it.each([
    ['one past the u32 ceiling', MAX_RECALL_BLOCKS + 1],
    ['a full u32 wraparound', 2 ** 32],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY]
  ])('refuses %s, queueing nothing', async (_label, blocks) => {
    await expect(send(blocks)).rejects.toThrow(/recallBlocks/);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it.each([
    ['a week of blocks', 2016],
    ['exactly the ceiling', MAX_RECALL_BLOCKS],
    ['zero', 0],
    ['omitted — a plain P2ID with no reclaim height', undefined]
  ])('accepts %s', async (_label, blocks) => {
    await expect(send(blocks)).resolves.toEqual(expect.any(String));
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

import { abortsLeg, InfrastructureFault } from './dapp-cells';
import type { Journey } from './dapp-journey';
import { nativeNoteTo } from './dapp-writes';
import { mintFromPublicFaucet, PublicFaucetError } from './public-faucet';
import { waitForPublicNoteCommitment } from './public-note-commitment';

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

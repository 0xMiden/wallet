import type { CdpSession } from './cdp-bridge';
import { IosWalletPage } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';

describe('IosWalletPage.screenshot', () => {
  it('runs the before-capture hook before it shoots', async () => {
    const order: string[] = [];
    const sim = {
      screenshot: jest.fn(async () => {
        order.push('shot');
      })
    } as unknown as SimulatorControl;
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim,
      udid: 'udid',
      bundleId: 'bundle',
      beforeCapture: async () => {
        order.push('gate');
      }
    });

    await page.screenshot({ path: 'shot.png' });

    expect(order).toEqual(['gate', 'shot']);
  });

  it('shoots without a hook', async () => {
    const screenshot = jest.fn(async () => undefined);
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim: { screenshot } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.screenshot({ path: 'shot.png' });

    expect(screenshot).toHaveBeenCalledWith('udid', 'shot.png');
  });
});

describe('IosWalletPage.claimAllNotes', () => {
  const FAUCET_HEX = '0x1111111111111111111111111111';

  /**
   * A wallet behind a fake debugger session, on jest's clock. Claim All claims what the pending list shows at the tap:
   * the fee note from the start, the test-token note only once `tokenNoteArrivesAt` has passed. Each claim keeps its
   * progress screen active for 30 s, longer than one pass of the helper's wait loop, then credits its balance.
   */
  function fakeWallet(tokenNoteArrivesAt: number | null) {
    const state = {
      hash: '#/',
      native: 0,
      token: 0,
      claims: [] as Array<{ note: 'fee' | 'token'; at: number; settlesAt: number }>,
      navigations: [] as Array<{ hash: string; at: number }>
    };
    const credit = () => {
      for (const claim of state.claims) {
        if (Date.now() < claim.settlesAt) continue;
        if (claim.note === 'fee') state.native = 1;
        else state.token = 500;
      }
    };
    const claimed = (note: 'fee' | 'token') => state.claims.some(claim => claim.note === note);
    const answer = (js: string): unknown => {
      credit();
      const navigation = /^window\.location\.hash = ['"]([^'"]*)['"]/.exec(js);
      if (navigation) {
        state.hash = navigation[1]!;
        state.navigations.push({ hash: state.hash, at: Date.now() });
        return null;
      }
      if (js.includes('__PROVE_TIMINGS__')) return [];
      if (js.includes('setAssetsMetadata')) return { before: [], injected: [], after: [] };
      if (js.includes('btn.click()')) {
        if (!state.hash.startsWith('#/pending-notes')) return false;
        const tokenListed = tokenNoteArrivesAt !== null && Date.now() >= tokenNoteArrivesAt;
        const note = !claimed('fee') ? 'fee' : tokenListed && !claimed('token') ? 'token' : null;
        if (!note) return false;
        state.claims.push({ note, at: Date.now(), settlesAt: Date.now() + 30_000 });
        state.hash = `#/generating-transaction-full/tx-${state.claims.length}`;
        return true;
      }
      if (js.includes('data-transaction-step')) {
        const active = state.claims.some(claim => Date.now() < claim.settlesAt) ? 1 : 0;
        return { hash: state.hash, steps: state.hash.includes('generating-transaction') ? 4 : 0, active };
      }
      if (js.includes('tokenId')) return state.token;
      if (js.includes('__TEST_HEX_TO_BECH32_FAUCET__')) return true;
      if (js.includes('claimAllButton=')) return `hash=${state.hash} claimAllButton=absent`;
      if (js.includes('var want = ""')) return state.native + state.token;
      if (js.includes('var want =')) return state.token;
      if (js.includes('parseFloat')) return state.native > 0 ? state.native : state.token;
      return null;
    };
    const cdp = { eval: jest.fn(async (js: string) => answer(js)), getStats: () => ({}) } as unknown as CdpSession;
    const page = new IosWalletPage({ cdp, sim: {} as SimulatorControl, udid: 'udid', bundleId: 'bundle' });
    return { page, state };
  }

  async function outcomeOf(claim: Promise<void>): Promise<{ resolved: boolean; message?: string }> {
    let outcome: { resolved: boolean; message?: string } | undefined;
    claim.then(
      () => {
        outcome = { resolved: true };
      },
      (error: Error) => {
        outcome = { resolved: false, message: error.message };
      }
    );
    for (let tick = 0; tick < 2_000 && !outcome; tick++) await jest.advanceTimersByTimeAsync(1_000);
    if (!outcome) throw new Error('claimAllNotes never settled');
    return outcome;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('claims a test-token note that lands after the fee note before it returns', async () => {
    const { page, state } = fakeWallet(Date.now() + 60_000);

    const outcome = await outcomeOf(page.claimAllNotes(180_000, [FAUCET_HEX]));

    expect(outcome).toEqual({ resolved: true });
    expect(state.claims.map(claim => claim.note)).toEqual(['fee', 'token']);
    expect(state.token).toBe(500);
  });

  it('never navigates away from a claim whose progress screen is still active', async () => {
    const { page, state } = fakeWallet(Date.now() + 60_000);

    await outcomeOf(page.claimAllNotes(180_000, [FAUCET_HEX]));

    const leftInFlight = state.navigations.filter(navigation =>
      state.claims.some(claim => claim.at < navigation.at && navigation.at < claim.settlesAt)
    );
    expect(leftInFlight).toEqual([]);
  });

  it('fails when the requested token never lands, even though the fee note did', async () => {
    const { page, state } = fakeWallet(null);

    const outcome = await outcomeOf(page.claimAllNotes(180_000, [FAUCET_HEX]));

    expect(outcome.resolved).toBe(false);
    expect(outcome.message).toContain('IosWalletPage.claimAllNotes');
    expect(state.native).toBe(1);
  });

  it('still returns on any claimed balance when no faucet is named', async () => {
    const { page, state } = fakeWallet(null);

    const outcome = await outcomeOf(page.claimAllNotes(180_000));

    expect(outcome).toEqual({ resolved: true });
    expect(state.claims.map(claim => claim.note)).toEqual(['fee']);
  });
});

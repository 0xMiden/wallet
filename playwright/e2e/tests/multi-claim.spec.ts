import { test } from '../fixtures/two-wallets';
import { offChainAxis, runMultiNoteClaimJourney } from '../helpers/money-path';

// Three mints, then ONE claim pass. Asserting the sum matters: a per-note
// `> 0` check goes green as soon as any one of them lands, which is exactly
// the multi-note bug this spec exists to catch.
//
// This spec previously stopped at the pending total and never claimed, despite
// its name — so the batching path it advertised had no coverage at all. The
// journey now lives in helpers/money-path.ts and is shared with the guardian
// leg, so a fix lands once instead of once per copy.
const MINTS = [50_000_000_000n, 30_000_000_000n, 20_000_000_000n] as const;

test.describe('Multi-Note Claiming', () => {
  test.describe.configure({ mode: 'serial' });

  test('mint multiple notes and claim all', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    await runMultiNoteClaimJourney({ walletA, walletB, midenCli, steps, timeline, axis: offChainAxis }, MINTS);
  });
});

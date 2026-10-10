import { expect, test } from '../../fixtures/two-wallets';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { canonicalAddress } from '../../helpers/dapp-gates';
import { runJourneyCells, startJourney, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { answerPrompt, callDapp, unwrap } from '../../helpers/test-dapp';

function sessionCells(j: Journey): Record<string, DappCellImpl> {
  const { dapp } = j;
  return {
    S1: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        expect(await callDapp(dapp, 'detect', { timeoutMs: 10_000 }, ctx.deadline)).toEqual({
          readyState: 'Installed',
          isAvailable: true
        });
      }
    },
    S2: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const connected = unwrap(result, 'connect', ctx);
        expect(canonicalAddress(connected.address)).toBe(canonicalAddress(await j.account('primary')));
        expect(connected.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
        expect(connected.builder).toBe(j.axis.expected.builder);
        expect(await j.axis.connectKeyMembership(j.walletA, await j.account('primary'), connected.publicKeyHex)).toBe(
          j.axis.expected.connectKeyMembership
        );
      }
    }
  };
}

function defineSessionJourney(axis: DappAxis): void {
  test(journeyTitle('S', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.S);
    const j = await startJourney({ journey: 'S', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    await runJourneyCells(j, sessionCells(j));
  });
}

for (const axis of dappAxes()) defineSessionJourney(axis);

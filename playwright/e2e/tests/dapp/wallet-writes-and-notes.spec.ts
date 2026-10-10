import { test } from '../../fixtures/two-wallets';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { runJourneyCells, startJourney, tst, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { dappSendToTheEnd } from '../../helpers/dapp-writes';

function writeCells(j: Journey): Record<string, DappCellImpl> {
  const { dapp } = j;
  return {
    W1: {
      budget: 'write',
      run: async ctx => {
        await dappSendToTheEnd(j, dapp, { amount: tst(5), noteType: 'public', via: 'requestSend' }, ctx);
      }
    }
  };
}

function defineWritesJourney(axis: DappAxis): void {
  test(journeyTitle('W', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.W);
    const j = await startJourney({ journey: 'W', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    await runJourneyCells(j, writeCells(j));
  });
}

for (const axis of dappAxes()) defineWritesJourney(axis);

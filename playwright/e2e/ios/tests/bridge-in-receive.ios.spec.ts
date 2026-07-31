import { expect, test } from '../fixtures/two-simulators';

/**
 * Bridge-IN foundation smoke (AggLayer path, REAL Miden receipt).
 *
 * De-risks the hardest half of the bridge-in harness on iOS with NO EVM leg: a
 * real note is delivered to the wallet's account (the miden-client CLI acting as
 * the AggLayer "solver"), the wallet's REAL sync + consume runs, and the REAL
 * reconciliation (`takeAgglayerBridgeInInfo`) tags the consume row "Bridged from
 * EVM" and flips the `bridged-receive` tracking row to `received`.
 *
 * The full harness (later) drives the real UI + real WalletConnect deposit that
 * CREATES this row; here we create it via the E2E hook to isolate the Miden path.
 */
test.describe('Bridge-IN receive (AggLayer, real Miden receipt)', () => {
  test.describe.configure({ mode: 'serial' });

  // Base units delivered by the solver == the tracking row's amount (the
  // AggLayer matcher pairs on exact amount + sender + recipient).
  const AMOUNT = 50_000_000_000;

  test('a delivered note is reconciled and the bridged-receive row reaches received', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    let addressA: string;
    let faucetHex: string;
    let bridgeReceiveTxId: string;

    await steps.step('create_wallet', async () => {
      const a = await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
      addressA = a.address;
    });

    await steps.step('deploy_solver_faucet_and_point_matcher', async () => {
      await midenCli.init();
      faucetHex = await midenCli.createFaucet();
      // The faucet is the AggLayer "solver" sender for this test — point the
      // reconciliation sender-match at it (bech32, matching the note's sender).
      const faucetBech32 = await walletA.hexToBech32Faucet(faucetHex);
      await walletA.setAgglayerSender(faucetBech32);
    });

    await steps.step('create_tracking_row', async () => {
      bridgeReceiveTxId = await walletA.createBridgeReceive({
        accountId: addressA!,
        amount: String(AMOUNT),
        faucetId: '',
        provider: 'agglayer',
        sourceAddress: '0x000000000000000000000000000000000000dEaD',
        sourceAmount: '0.1',
        sourceSymbol: 'ETH'
      });
      expect(bridgeReceiveTxId, 'bridged-receive txId').toBeTruthy();
    });

    await steps.step('solver_delivers_note', async () => {
      await midenCli.mint(faucetHex!, addressA!, AMOUNT, 'public');
      await midenCli.sync();
    });

    await steps.step('wallet_consumes_note', async () => {
      // Custom-faucet note ⇒ not auto-consumed; drive the real Claim-All.
      await walletA.claimAllNotes(420_000, [faucetHex!]);
    });

    await steps.step('assert_received', async () => {
      await expect
        .poll(async () => (await walletA.getBridgeReceiveState(bridgeReceiveTxId!)).phase, {
          timeout: 120_000,
          intervals: [3000]
        })
        .toBe('received');
      const state = await walletA.getBridgeReceiveState(bridgeReceiveTxId!);
      expect(state.displayMessage, 'tagged as bridge-in').toBe('Bridged from EVM');
    });
  });
});

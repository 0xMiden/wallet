import { TxStatus } from '../../helpers/history';
import { expect, test } from '../fixtures/two-simulators';

const AWAY_MS = 80_000;
const AMOUNT = '500';

/**
 * A Guardian send whose app leaves the foreground while the attempt runs, for longer than a mainnet proof's window
 * (#2060): the real app, the real Guardian and the real node, with one attempt ending in exactly one transaction.
 *
 * What a simulator can prove: the app really left the foreground (its document went hidden), its process and WebView
 * came back, and a send interrupted that way ends settled, once, with the balance moved once.
 *
 * What it cannot: that the WebView's JS was suspended, or for how long. Suspension here is whatever the simulator does,
 * with the Web Inspector attached, on a host with no memory pressure, so a pass says nothing about a device freezing a
 * prove or a submit mid-flight, or about iOS ending the background time. Nor does devnet carry mainnet's fee policy, so
 * the proof usually outlives the 80 s here. Those are the Jest matrix's job
 * (src/lib/miden/transaction/transactions.background-matrix.test.ts), which freezes each stage on a modelled chain.
 */
test.describe('Guardian account - app switch during a send', () => {
  test.describe.configure({ mode: 'serial' });

  test('the send lands once and the row settles', async ({ walletA, walletB, midenCli, steps }) => {
    let addressB = '';
    let faucetId = '';
    let tokenId = '';
    let funded = 0n;

    await steps.step('create_and_fund_wallets', async () => {
      const a = await walletA.createGuardianWallet();
      addressB = (await walletB.createNewWallet()).address;
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      expect(faucetId).toBeTruthy();
      tokenId = await walletA.hexToBech32Faucet(faucetId);
      await midenCli.mint(faucetId, a.address, 100_000_000_000, 'public');
      await midenCli.sync();
      await walletA.claimAllNotes(180_000, [faucetId]);
      funded = await walletA.homeVaultBaseUnits(tokenId, units => units > 0n, 180_000, 'the minted amount');
    });

    await steps.step(
      'send_and_leave_during_the_attempt',
      async () => {
        await walletA.prepareSendReview({
          recipientAddress: addressB,
          amount: AMOUNT,
          tokenSymbol: 'TST',
          isPrivate: false
        });
        await walletA.click('[data-testid="send-review-submit"]');
        await expect
          .poll(async () => (await walletA.readTransactionRows({ type: 'send' })).map(row => row.status), {
            message: 'the send never started its attempt',
            timeout: 60_000,
            intervals: [500]
          })
          .toEqual([TxStatus.GeneratingTransaction]);

        await walletA.leaveForeground();
        const returnAt = Date.now() + AWAY_MS;
        await expect.poll(() => Date.now() >= returnAt, { timeout: AWAY_MS + 10_000, intervals: [1_000] }).toBe(true);
        expect(await walletA.returnToForeground(), 'the app never went to the background').toBe(true);
      },
      { captureStateFrom: [{ target: walletA, label: 'A' }] }
    );

    await steps.step(
      'one_transaction_one_balance_move',
      async () => {
        await expect
          .poll(async () => (await walletA.readTransactionRows({ type: 'send' })).map(row => row.status), {
            message: 'Activity should settle on exactly one completed send',
            timeout: 300_000,
            intervals: [3_000]
          })
          .toEqual([TxStatus.Completed]);

        const [row] = await walletA.readTransactionRows({ type: 'send' });
        expect(row?.transactionId, 'the settled row names no transaction').toBeTruthy();
        expect(row?.amount ?? '0', 'the settled row moved nothing').not.toBe('0');
        const expected = funded - BigInt(row?.amount ?? '0');
        const balance = await walletA.homeVaultBaseUnits(
          tokenId,
          units => units === expected,
          180_000,
          `one send out of ${funded}`
        );
        expect(balance).toBe(expected);
      },
      { captureStateFrom: [{ target: walletA, label: 'A' }] }
    );
  });
});

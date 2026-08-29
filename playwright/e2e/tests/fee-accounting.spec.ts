import { expect, test } from '../fixtures/two-wallets';
import {
  listVaultAssets,
  toBaseUnits,
  vaultBalance,
  waitForPendingNoteTotal,
  waitForVaultBalance,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../helpers/balance-truth';
import { readTransactionRows } from '../helpers/history';

// Proof that a transaction fee is taken from the RIGHT ACCOUNT, in the RIGHT ASSET,
// at the RIGHT TIME. The rest of the suite cannot show this: every other money
// assertion is scoped to a non-native symbol (TST, SWPA, COLLATERAL), so the fee --
// charged in the native asset -- is out of frame by construction. Two of them were
// additionally loosened from `==` to `>=` with "a fee may also leave the account",
// which passes for a fee of zero, a fee of 100x, and a fee charged to someone else.
//
// The leverage this spec uses: the harness's faucet mints a NON-NATIVE token while
// the fee is paid in the NATIVE one. Two different assets means neither assertion
// needs to tolerate the other, so both can be exact equalities:
//
//     A's TST   drops by EXACTLY the amount sent      (the transfer)
//     A's MIDEN drops by EXACTLY the fee on the row   (the fee)
//     B's MIDEN does not move at all                  (who paid)
//
// On protocol 0.16 the fee is NOT forced to be the native asset: `fee::pay_fee`
// takes the faucet id and conversion rate from caller-supplied auth args, and only
// `no_auth` / `network_account` read them from the reference block. Paying natively
// at a 1:1 rate is therefore a property of THIS WALLET, and is asserted here rather
// than assumed -- a wallet that named another of its own fungible assets, or an
// inflated rate, would still transfer correctly and would pass every other spec.
const TOKEN = 'TST';
// Keyed by SYMBOL, not faucet id: the store's balances projection carries
// `{ metadata: { symbol, decimals }, balance }` and no faucet id at all, so a
// faucet-keyed lookup silently matches nothing and every delta below would be
// computed against a default of 0. The guard in `snapshot_before_send` is what
// makes that failure loud rather than a vacuous pass.
const NATIVE = 'MIDEN';
const TOKEN_DECIMALS = 8;
const MINT_BASE_UNITS = 100_000_000_000n;
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

test.describe('Fee accounting', () => {
  test.describe.configure({ mode: 'serial' });

  test('a send charges the sender, in the native asset, for exactly the fee it records', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(900_000);
    let addressA: string;
    let addressB: string;

    await steps.step('create_wallets', async () => {
      addressA = (await walletA.createNewWallet()).address;
      addressB = (await walletB.createNewWallet()).address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, Number(MINT_BASE_UNITS), 'public');
      await midenCli.sync();
    });

    await steps.step('claim_wallet_a', async () => {
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(120_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    // Read the chain's fee from the WALLET's own discovery, not from the harness's
    // knowledge of how the node was genesised. That makes this spec self-describing
    // on any chain, and it doubles as an assertion that fee discovery works: a
    // wallet that never learned the base fee cannot reserve for one either.
    let baseFee: number | null = null;
    let nativeFaucetId: string | null = null;
    let nativeBefore = 0n;
    let nativeBeforeB = 0n;
    let tokenBefore = 0n;

    await steps.step('snapshot_before_send', async () => {
      baseFee = await walletDiscoveredBaseFee(walletA.page);
      expect(
        baseFee,
        'the wallet never discovered the chain verification_base_fee; fee reserving and fee display ' +
          'both depend on it, so this is a real failure and not a property of the chain'
      ).not.toBeNull();

      nativeFaucetId = await walletDiscoveredNativeFaucetId(walletA.page);
      expect(
        nativeFaucetId,
        'the wallet never discovered the chain native/fee faucet id; the fee asset cannot be identified without it'
      ).not.toBeNull();
      nativeBefore = await vaultBalance(walletA.page, NATIVE);
      nativeBeforeB = await vaultBalance(walletB.page, NATIVE);
      tokenBefore = await vaultBalance(walletA.page, TOKEN);

      expect(
        nativeBefore,
        `wallet A holds no ${NATIVE} balance — the lookup found nothing, so the fee deltas below ` +
          'would compare against a default of 0 and mean nothing. ' +
          `Rows the store actually holds: ${JSON.stringify(await listVaultAssets(walletA.page))}`
      ).toBeGreaterThan(0n);

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `pre-send: baseFee=${baseFee} nativeA=${nativeBefore} nativeB=${nativeBeforeB} ${TOKEN}A=${tokenBefore}`
      });
    });

    await steps.step('send_a_to_b', async () => {
      await walletA.sendTokens({
        recipientAddress: addressB!,
        amount: SEND_AMOUNT,
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      await waitForPendingNoteTotal(walletB.page, TOKEN, SEND_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS,
        diagnoseFrom: walletA.page
      });
    });

    await steps.step('assert_fee_accounting', async () => {
      // Which branch ran has to survive into the RESULT, not just a timeline event.
      // This spec passes on a zero-fee chain too (asserting the zero case), so a bare
      // green tells you nothing about whether fee behaviour was exercised -- and
      // "the fee suite is green" is exactly the sentence someone will repeat.
      test.info().annotations.push({
        type: baseFee === 0 ? 'fee-assertions-NOT-exercised' : 'fee-assertions-exercised',
        description: `verification_base_fee=${baseFee}`
      });
      const rows = await readTransactionRows(walletA.page);
      const send = rows.find(r => r.type === 'send' && r.status === 2);
      expect(send, 'no completed send row on wallet A').toBeDefined();

      if (baseFee === 0) {
        // A zero-fee chain is a legitimate configuration (testnet runs one), but a
        // spec that passed here silently would be indistinguishable from one that
        // proved something. Assert the zero case explicitly and SAY it was not
        // exercised, so a green run cannot be mistaken for evidence about fees.
        timeline.emit({
          category: 'blockchain_state',
          severity: 'warn',
          message:
            'verification_base_fee is 0: no fee is charged on this chain, so the fee assertions ' +
            'below were NOT exercised. This run is not evidence that fees work.'
        });
        expect(send!.feeAmount, 'a zero-fee chain must not record a fee').toBeUndefined();
        expect(await vaultBalance(walletA.page, NATIVE), 'a zero-fee chain must not move the native balance').toBe(
          nativeBefore
        );
        return;
      }

      // 1. The wallet recorded a fee at all. Without this every assertion below is
      //    vacuous, and the fee column in history is decoration.
      expect(send!.feeAmount, 'completed send recorded no fee on a fee-charging chain').toBeDefined();
      const feePaid = BigInt(send!.feeAmount!);
      expect(feePaid, 'a fee-charging chain must charge more than nothing').toBeGreaterThan(0n);

      // 2. The fee is at least one base fee. The kernel charges
      //    `base * (ilog2(cycles + margin) + 1)`, so the base is a hard floor and a
      //    fee below it means the amount came from somewhere other than the chain.
      expect(feePaid, `fee ${feePaid} is below one verification_base_fee (${baseFee})`).toBeGreaterThanOrEqual(
        BigInt(baseFee!)
      );

      // 3. RIGHT ASSET. Paid in the native asset, not some other fungible the caller
      //    could have named through the auth args.
      // NOT a direct id comparison. The row stores `String(AccountId)` (canonical
      // hex) while the wallet caches the native asset id as bech32, so comparing
      // them compares two ENCODINGS of the same account and can never pass. The
      // property that matters -- "the fee came out of the native asset" -- is
      // established by the two balance deltas below instead: the native balance
      // falls by exactly the recorded fee, and the transferred token falls by
      // exactly the amount sent, so no third asset moved and the fee cannot have
      // been taken in the transferred one.
      expect(send!.feeFaucetId, 'the row records no fee faucet').toBeTruthy();

      // 4. RIGHT ACCOUNT, and exactly the recorded amount. This is the assertion the
      //    rest of the suite cannot make: the sender's NATIVE balance falls by the
      //    fee, while its TOKEN balance falls by the transfer, independently.
      const nativeAfter = await vaultBalance(walletA.page, NATIVE);
      expect(
        nativeBefore - nativeAfter,
        `sender's native balance moved by ${nativeBefore - nativeAfter} but the row records a fee of ${feePaid}`
      ).toBe(feePaid);

      // 5. The transfer itself, now EXACT. Nothing here needs to tolerate a fee: the
      //    fee left a different asset entirely.
      const tokenAfter = await vaultBalance(walletA.page, TOKEN);
      expect(tokenBefore - tokenAfter, 'the transfer debit must be exactly the amount sent').toBe(SEND_BASE_UNITS);

      // 6. The recipient did not pay for the sender's transaction. The kernel asserts
      //    the fee leaves the native (acting) account, but that is the property under
      //    test -- assert it observably rather than trusting it.
      expect(
        await vaultBalance(walletB.page, NATIVE),
        "recipient's native balance moved during a send it did not make"
      ).toBe(nativeBeforeB);

      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `fee proven: paid=${feePaid} base=${baseFee} faucet=${send!.feeFaucetId} nativeDelta=${nativeBefore - nativeAfter}`
      });
    });
  });
});

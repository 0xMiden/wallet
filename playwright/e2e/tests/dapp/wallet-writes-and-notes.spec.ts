import { expect, test } from '../../fixtures/two-wallets';
import { vaultAssetsOfCurrentAccount } from '../../helpers/balance-truth';
import { captureBaseline, expectWritesToTheEnd, pollUntil } from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { assetMap, normalizeHex } from '../../helpers/dapp-gates';
import { runJourneyCells, startJourney, tst, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import {
  dappSendToTheEnd,
  nativeNoteTo,
  pendingNote,
  setDelegatedProving,
  sideOf,
  turnAutoConsumeOff
} from '../../helpers/dapp-writes';
import { readTransactionRow } from '../../helpers/history';
import { answerPrompt, callDapp, popupBlock, unwrap } from '../../helpers/test-dapp';

const HELD_NOTE_AMOUNT = tst(7.25);
const DECLARED_AMOUNT = tst(1).toString();

function writeCells(j: Journey, heldNoteId: string): Record<string, DappCellImpl> {
  const { dapp } = j;
  const assetsMatchVault: DappCellImpl = {
    budget: 'read',
    run: async ctx => {
      const { result } = await answerPrompt(
        dapp,
        () => callDapp(dapp, 'assets', {}, ctx.deadline),
        { kind: 'assets', decision: 'approve', origin: dapp.origin },
        ctx
      );
      expect(assetMap(unwrap(result, 'requestAssets', ctx))).toEqual(await vaultAssetsOfCurrentAccount(j.walletA.page));
    }
  };
  return {
    'N1-before-writes': assetsMatchVault,
    N2: {
      budget: 'read',
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'consumableNotes', {}, ctx.deadline),
          { kind: 'consumableNotes', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const notes = unwrap(result, 'requestConsumableNotes', ctx);
        const held = notes.find(note => normalizeHex(note.noteId) === normalizeHex(heldNoteId));
        expect(held, `consumable notes: ${JSON.stringify(notes)}`).toBeDefined();
        expect(held?.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
        expect(held?.assets).toEqual([{ faucetId: j.tokenFaucetId, amount: HELD_NOTE_AMOUNT.toString() }]);
        j.memo.set('N2.nullifier', held?.nullifier ?? '');
      }
    },
    W1: {
      budget: 'write',
      run: async ctx => {
        await dappSendToTheEnd(j, dapp, { amount: tst(5), noteType: 'public', via: 'requestSend' }, ctx);
      }
    },
    W2: {
      budget: 'write',
      run: async ctx => {
        await dappSendToTheEnd(j, dapp, { amount: tst(4), noteType: 'private', via: 'requestSend' }, ctx);
      }
    },
    W3: {
      budget: 'write',
      run: async ctx => {
        const written = await dappSendToTheEnd(
          j,
          dapp,
          { amount: tst(3), noteType: 'public', via: 'requestTransaction', recallBlocks: 500 },
          ctx
        );
        j.memo.set('W3.txId', written.txId);
        j.memo.set('W3.noteIds', written.outputNotes.map(note => note.noteId).join(','));
      }
    },
    'W3-wire': {
      budget: 'write',
      run: async ctx => {
        // The same recallable send through the wallet's own requestTransaction routing (spec W3, dapp.ts:1761-1775).
        await dappSendToTheEnd(j, dapp, { amount: tst(2.5), noteType: 'public', via: 'wire', recallBlocks: 500 }, ctx);
      }
    },
    N6: {
      budget: 'read',
      needs: ['W3'],
      run: async ctx => {
        const txId = j.memo.get('W3.txId') ?? '';
        const again = unwrap(
          await callDapp(dapp, 'waitForTransaction', { txId }, ctx.deadline),
          'waitForTransaction again',
          ctx
        );
        const row = await readTransactionRow(j.walletA.page, txId);
        expect(again.txHash).toBe(row?.transactionId);
        expect(again.outputNotes.map(note => note.noteId).join(',')).toBe(j.memo.get('W3.noteIds'));
        expect(again.outputNotes.every(note => note.isSameSdkNote)).toBe(true);
        // The chain charges a fee, so the executed transaction emitted a fee note too; the dApp must not get it.
        expect(BigInt(row?.feeAmount ?? '0')).not.toBe(0n);
        expect(again.outputNotes).toHaveLength(1);
      }
    },
    W4: {
      budget: 'write',
      needs: ['N2'],
      run: async ctx => {
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'consume',
              {
                noteId: heldNoteId,
                faucetId: j.tokenFaucetId,
                amount: DECLARED_AMOUNT,
                noteType: 'public',
                via: 'requestConsume'
              },
              ctx.deadline
            ),
          {
            kind: 'consume',
            decision: 'approve',
            origin: dapp.origin,
            whileOpen: async popup => {
              // The popup shows the resolved note, not the declared 1 TST (dapp.ts:2655-2668).
              await expect(popup.getByTestId('confirm-tx-value-amount')).toContainText('7.25');
              await popupBlock(dapp, ctx);
            }
          },
          ctx
        );
        const { txId } = unwrap(result, 'requestConsume', ctx);
        await expectWritesToTheEnd(
          side,
          baseline,
          [{ txId, outputNotes: [], consumedNullifiers: [j.memo.get('N2.nullifier') ?? ''] }],
          { [j.tokenFaucetId]: HELD_NOTE_AMOUNT },
          ctx
        );
      }
    },
    W8: {
      budget: 'write',
      run: async ctx => {
        // Carried to the service worker by confirmReq.delegate (ConfirmPage.tsx:509, 527-529). An aborting prover fault
        // is hit only by a delegated prove, which falls back to local and still lands (R9 asserts the hits), so the
        // row's flag and zero hits are what prove the toggle held.
        await setDelegatedProving(j, false);
        j.touch('faults');
        await j.walletA.armNetworkFault({ target: 'prover', mode: 'abort' });
        const written = await dappSendToTheEnd(
          j,
          dapp,
          { amount: tst(2), noteType: 'public', via: 'requestSend' },
          ctx
        );
        expect(written.row.delegateTransaction).toBe(false);
        expect(await j.walletA.networkFaultHits()).toBe(0);
      }
    },
    W4f: {
      // The grant waits out the faucet's 429s and its commit inside the cell, which a write budget cannot hold.
      budget: 'long',
      state: { account: 'second' },
      run: async ctx => {
        // Review Focus 2: with auto-consume on, the service worker would consume this native note first.
        await turnAutoConsumeOff(j);
        const second = await j.account('second');
        const side = await sideOf(j, dapp, 'second');
        expect((await callDapp(dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline)).found).toBe(
          false
        );
        const { noteId } = await nativeNoteTo(j, second);
        const note = await pollUntil(
          () => pendingNote(j.walletA.page, noteId),
          found => found !== null,
          'native note discovered',
          ctx
        );
        const onChain = await pollUntil(
          () => callDapp(dapp, 'chainNote', { noteId }, ctx.deadline),
          found => found.found,
          'native note on chain',
          ctx,
          { bounded: true }
        );
        const nullifier = onChain.nullifierHex ?? '';
        expect(
          (await callDapp(dapp, 'chainNullifier', { nullifierHex: nullifier }, ctx.deadline)).committedAt
        ).toBeNull();
        const baseline = await captureBaseline(side, [j.nativeFaucetId], ctx);
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'consume',
              {
                noteId,
                faucetId: j.nativeFaucetId,
                amount: note?.amountBaseUnits ?? '0',
                noteType: 'public',
                via: 'requestConsume'
              },
              ctx.deadline
            ),
          { kind: 'consume', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const { txId } = unwrap(result, 'first-transaction consume', ctx);
        await expectWritesToTheEnd(
          side,
          baseline,
          [{ txId, outputNotes: [], consumedNullifiers: [nullifier] }],
          { [j.nativeFaucetId]: BigInt(note?.amountBaseUnits ?? '0') },
          ctx
        );
      }
    },
    'N1-after-writes': assetsMatchVault
  };
}

function defineWritesJourney(axis: DappAxis): void {
  test(journeyTitle('W', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.W);
    const j = await startJourney({ journey: 'W', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    let heldNoteId = '';
    await steps.step('mint_wallet_held_note', async () => {
      // A public TST note A holds but has not claimed (auto-consume only takes the native asset).
      heldNoteId = (await midenCli.mint(j.cliFaucetId, await j.account('primary'), HELD_NOTE_AMOUNT, 'public')).noteId;
      await midenCli.sync();
      await expect.poll(() => pendingNote(walletA.page, heldNoteId), { timeout: 180_000 }).not.toBeNull();
    });
    await runJourneyCells(j, writeCells(j, heldNoteId));
  });
}

for (const axis of dappAxes()) defineWritesJourney(axis);

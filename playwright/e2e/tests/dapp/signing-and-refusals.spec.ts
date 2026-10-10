import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/two-wallets';
import type { ConfirmKind } from '../../helpers/confirm-actions';
import {
  captureBaseline,
  expectCancelledWhileQueued,
  expectFailedAfterEnqueue,
  expectNoNewRows,
  expectReceivedByRecipient,
  pollUntil,
  refusal
} from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { HarnessFault, type CellContext } from '../../helpers/dapp-cells';
import { normalizeHex } from '../../helpers/dapp-gates';
import {
  FUND_A,
  runJourneyCells,
  setupContext,
  startJourney,
  tst,
  type DappCellImpl,
  type Journey
} from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import pinned from '../../helpers/dapp-pinned.json';
import {
  customWriteToTheEnd,
  dappSendToTheEnd,
  noteIdsSeenOver,
  pendingImportQueue,
  pendingNote,
  produceNotesFromB,
  setDelegatedProving,
  sideOf,
  type ProducedNote
} from '../../helpers/dapp-writes';
import {
  openHistoryDetails,
  plantQueueBlocker,
  readTransactionRow,
  releaseQueueBlocker,
  TxStatus
} from '../../helpers/history';
import { TOKEN } from '../../helpers/money-path';
import { ECDSA_SCHEME_TAG, recoverEcdsaPublicKey } from '../../helpers/signature-recovery';
import {
  advanceChain,
  answerPrompt,
  bytesArg,
  callDapp,
  expectNoPrompt,
  pendingNoteIds,
  popupBlock,
  unwrap
} from '../../helpers/test-dapp';
import type { ConnectedView, RawArg } from '../../test-dapp/protocol';

const WORD = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const SUMMARY_AMOUNT = tst(0.5);
// en.json:1084, rendered by OpaqueSignatureWarning (ConfirmPage.tsx:116-120) for Arbitrary and Blind inputs.
const OPAQUE_WARNING = 'Opaque signature request';

async function connectedView(j: Journey, ctx: CellContext): Promise<ConnectedView> {
  const view = await callDapp(j.dapp, 'session', {}, ctx.deadline);
  if (view.connected === null) throw new HarnessFault('the dApp is not connected');
  return view.connected;
}

function signingCells(j: Journey): Record<string, DappCellImpl> {
  const { dapp } = j;
  const signingInputsCell = (
    variant: 'arbitrary' | 'summary' | 'blind',
    popupShows: (popup: Page) => Promise<void>
  ): DappCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const me = await connectedView(j, ctx);
      const { result } = await answerPrompt(
        dapp,
        () =>
          callDapp(
            dapp,
            'signSigningInputs',
            {
              variant,
              felts: ['1', '2', '3'],
              wordHex: WORD,
              faucetId: j.tokenFaucetId,
              amount: SUMMARY_AMOUNT.toString()
            },
            ctx.deadline
          ),
        { kind: 'sign', decision: 'approve', origin: dapp.origin, whileOpen: popupShows },
        ctx
      );
      // Q2: a Guardian account signs with its hot key, so both kinds expect the same verifiable signature (K8 today).
      const signed = unwrap(result, `signBytes(signingInputs, ${variant})`, ctx);
      expect(
        await callDapp(
          dapp,
          'verifySignature',
          {
            kind: 'signingInputs',
            payloadB64: signed.payloadB64,
            signatureB64: signed.signatureB64,
            publicKeyB64: recoverEcdsaPublicKey(signed.signatureB64, signed.messageB64)
          },
          ctx.deadline
        )
      ).toEqual({ verifies: true, commitmentHex: me.publicKeyHex });
    }
  });
  const opaque = async (popup: Page) => {
    await expect(popup.getByText(OPAQUE_WARNING)).toBeVisible();
  };
  return {
    G1: {
      budget: 'read',
      run: async ctx => {
        const me = await connectedView(j, ctx);
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'signWord', { wordHex: WORD }, ctx.deadline),
          { kind: 'sign', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const signed = unwrap(result, 'signBytes(word)', ctx);
        expect(signed.schemeTag).toBe(ECDSA_SCHEME_TAG);
        // Rk3: on Guardian the key behind the signature must be the one connect handed the dApp.
        expect(
          await callDapp(
            dapp,
            'verifySignature',
            {
              kind: 'word',
              payloadB64: signed.payloadB64,
              signatureB64: signed.signatureB64,
              publicKeyB64: recoverEcdsaPublicKey(signed.signatureB64, signed.messageB64)
            },
            ctx.deadline
          )
        ).toEqual({ verifies: true, commitmentHex: me.publicKeyHex });
      }
    },
    G2a: signingInputsCell('arbitrary', opaque),
    // The twin's summary receives SUMMARY_AMOUNT and its fee headroom (guardian-request-builder.ts previewTwinSummary),
    // so the verified view (ConfirmPage.tsx:342-348) lists a 0.5 TST row beside the native one (spike row 8).
    G2b: signingInputsCell('summary', async popup => {
      const verified = popup.locator('[data-testid="tx-asset-view"][data-mode="verified"]');
      await expect(verified).toBeVisible();
      await expect(verified.locator('[data-verified="true"]').filter({ hasText: /^0\.5 TST$/ })).toHaveCount(1);
    }),
    G2c: signingInputsCell('blind', opaque),
    G3: {
      budget: 'read',
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'signWord', { wordHex: WORD }, ctx.deadline),
          { kind: 'sign', decision: 'decline', origin: dapp.origin },
          ctx
        );
        expect(result).toEqual(refusal('WalletTransactionError', 'NOT_GRANTED', 'NotGrantedMidenWalletError'));
      }
    },
    G4: {
      budget: 'read',
      run: async ctx => {
        const word = Buffer.from(WORD.slice(2), 'hex').toString('base64');
        // Through the provider with another key: the adapter always signs with the connect key.
        const result = await expectNoPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'raw',
              { call: 'signBytes', args: [bytesArg(word), 'word'], asPublicKeyHex: OTHER_KEY },
              ctx.deadline
            ),
          ctx,
          { refusal: true }
        );
        expect(result).toEqual(
          refusal('NotGrantedMidenWalletError', "NOT_GRANTED: signing key is not the connected account's key")
        );
      }
    }
  };
}

type RawRequest = { call: 'requestSend' | 'requestTransaction' | 'requestConsume' | 'connect'; args: RawArg[] };

interface RefusalFixtures {
  heldNoteId: string;
  heldBytesB64: string;
  heldNullifierHex: string;
  newA1: ProducedNote;
  newA2: ProducedNote;
  /**
   * The notes as files with their inclusion proofs, which commit the moment they are imported (N3a): a note that shows
   * despite a decline, or once an approval released it, is listed at the next sync, where bare bytes can wait on a tag
   * scan past both laps (miden-client-interface.ts:368).
   */
  proofB64: { newA1: string; newA2: string; carry: string };
  carry: ProducedNote;
}

const NOT_GRANTED_WRAPPED = refusal('WalletTransactionError', 'NOT_GRANTED', 'NotGrantedMidenWalletError');
const NOT_GRANTED_RAW = refusal('NotGrantedMidenWalletError', 'NOT_GRANTED');

function refusalCells(j: Journey, fx: RefusalFixtures): Record<string, DappCellImpl> {
  const { dapp } = j;
  const output = {
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: tst(1).toString(),
    noteType: 'public' as const
  };
  const sendInput = { ...output, via: 'requestSend' as const };
  const declined = (
    kind: ConfirmKind,
    start: (ctx: CellContext) => Promise<unknown>,
    expected: unknown,
    after: (ctx: CellContext) => Promise<void> = async () => undefined
  ): DappCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const side = await sideOf(j, dapp);
      const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
      const { result } = await answerPrompt(
        dapp,
        () => start(ctx),
        { kind, decision: 'decline', origin: dapp.origin },
        ctx
      );
      expect(result).toEqual(expected);
      await expectNoNewRows(side, baseline);
      await after(ctx);
    }
  });
  const refusedBeforePrompt = (
    build: (me: ConnectedView, ctx: CellContext) => RawRequest | Promise<RawRequest>,
    expected: unknown
  ): DappCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const me = await connectedView(j, ctx);
      const side = await sideOf(j, dapp);
      const baseline = await captureBaseline(side, [], ctx);
      const request = await build(me, ctx);
      const result = await expectNoPrompt(dapp, () => callDapp(dapp, 'raw', request, ctx.deadline), ctx, {
        refusal: true
      });
      expect(result).toEqual(expected);
      await expectNoNewRows(side, baseline);
    }
  });
  const rawSend = (me: ConnectedView, fields: Record<string, RawArg>): RawArg => ({
    senderAddress: me.addressCanonical,
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: Number(tst(1)),
    ...fields
  });

  return {
    'R1-send': declined('transaction', ctx => callDapp(dapp, 'send', sendInput, ctx.deadline), NOT_GRANTED_WRAPPED),
    'R1-consume': declined(
      'consume',
      ctx =>
        callDapp(
          dapp,
          'consume',
          {
            noteId: fx.heldNoteId,
            faucetId: j.tokenFaucetId,
            amount: tst(2.5).toString(),
            noteType: 'public',
            via: 'requestConsume'
          },
          ctx.deadline
        ),
      NOT_GRANTED_WRAPPED,
      async () => {
        expect(await pendingNote(j.walletA.page, fx.heldNoteId)).not.toBeNull();
      }
    ),
    'R1-custom': {
      budget: 'write',
      run: async ctx => {
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const built = await callDapp(
          dapp,
          'buildCustom',
          // The new note first: the dry run imports carried notes in order and stops at the one A already holds, whose
          // re-import fails with "import produced no note commitment" (simulate-custom-tx.ts:221-226).
          { shape: 'p2id', outputs: [output], carryNoteBytesB64: [fx.proofB64.newA1, fx.heldBytesB64] },
          ctx.deadline
        );
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'submitCustom',
              { requestId: built.requestId, recipientAddress: j.addressB, importNotes: true },
              ctx.deadline
            ),
          { kind: 'transaction', decision: 'decline', origin: dapp.origin },
          ctx
        );
        expect(result).toEqual(NOT_GRANTED_WRAPPED);
        await expectNoNewRows(side, baseline);
        // Only the approve branch releases the dry run's quarantine (dapp.ts:1956-1961): the new note never shows...
        expect(await noteIdsSeenOver(j, 2, ctx)).not.toContain(normalizeHex(fx.newA1.noteId));
        // ...while the note A already held was never quarantined and stays claimable (simulate-custom-tx.ts:197-205).
        expect((await pendingNoteIds(j.walletA.page)).map(normalizeHex)).toContain(normalizeHex(fx.heldNoteId));
        for (const nullifierHex of [fx.newA1.nullifierHex, fx.heldNullifierHex]) {
          expect((await callDapp(dapp, 'chainNullifier', { nullifierHex }, ctx.deadline)).committedAt).toBeNull();
        }
      }
    },
    'R1-assets': declined('assets', ctx => callDapp(dapp, 'assets', {}, ctx.deadline), NOT_GRANTED_WRAPPED),
    // The adapter does not wrap these two (adapter.js:214-239), so the provider's own class reaches the dApp.
    'R1-consumableNotes': declined(
      'consumableNotes',
      ctx => callDapp(dapp, 'consumableNotes', {}, ctx.deadline),
      NOT_GRANTED_RAW
    ),
    'R1-privateNotes': declined(
      'privateNotes',
      ctx => callDapp(dapp, 'privateNotes', { filter: 'All' }, ctx.deadline),
      NOT_GRANTED_WRAPPED
    ),
    'R1-importPrivateNote': declined(
      'importPrivateNote',
      ctx => callDapp(dapp, 'importNote', { noteBytesB64: fx.proofB64.newA2 }, ctx.deadline),
      NOT_GRANTED_RAW,
      async ctx => {
        expect(await noteIdsSeenOver(j, 2, ctx)).not.toContain(normalizeHex(fx.newA2.noteId));
      }
    ),
    R2: {
      budget: 'read',
      run: async ctx => {
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        // Closing the window is a decline (dapp.ts:2512-2516, onRemoved).
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'send', sendInput, ctx.deadline),
          { kind: 'transaction', decision: 'close', origin: dapp.origin },
          ctx
        );
        expect(result).toEqual(NOT_GRANTED_WRAPPED);
        await expectNoNewRows(side, baseline);
      }
    },
    'R3-noteType': refusedBeforePrompt(
      me => ({ call: 'requestSend', args: [rawSend(me, {})] }),
      refusal('InvalidParamsMidenWalletError', 'INVALID_PARAMS: Error: noteType is required')
    ),
    'R3-recallBlocks': refusedBeforePrompt(
      me => ({ call: 'requestSend', args: [rawSend(me, { noteType: 'public', recallBlocks: -1 })] }),
      refusal(
        'InvalidParamsMidenWalletError',
        /^INVALID_PARAMS: Error: recallBlocks must be a whole number between 0 and \d+, got -1$/
      )
    ),
    'R3-sender': refusedBeforePrompt(
      me => ({ call: 'requestSend', args: [rawSend(me, { noteType: 'public', senderAddress: j.addressB })] }),
      NOT_GRANTED_RAW
    ),
    'R3-customAddress': refusedBeforePrompt(
      async (_me, ctx) => {
        // A valid request whose only flaw is the account it names.
        const built = await callDapp(dapp, 'buildCustom', { shape: 'p2id', outputs: [output] }, ctx.deadline);
        return {
          call: 'requestTransaction',
          args: [
            {
              type: 'custom',
              payload: { address: j.addressB, recipientAddress: '', transactionRequest: built.requestB64 }
            }
          ]
        };
      },
      refusal('NotGrantedMidenWalletError', 'NOT_GRANTED: executing account is not the connected account')
    ),
    'R3-customPayload': refusedBeforePrompt(
      me => ({
        call: 'requestTransaction',
        args: [{ type: 'custom', payload: { address: me.addressCanonical, recipientAddress: '' } }]
      }),
      refusal(
        'InvalidParamsMidenWalletError',
        'INVALID_PARAMS: Error: INVALID_PARAMS: Invalid CustomTransaction payload'
      )
    ),
    // K11: the wallet prompts with its could-not-decode sheet instead (dapp.ts:2867-2879).
    'R3-customUndecodable': refusedBeforePrompt(
      me => ({
        call: 'requestTransaction',
        args: [
          {
            type: 'custom',
            payload: { address: me.addressCanonical, recipientAddress: '', transactionRequest: 'AAAA' }
          }
        ]
      }),
      refusal('InvalidParamsMidenWalletError', /^INVALID_PARAMS: /)
    ),
    'R3-consumeBytes': refusedBeforePrompt(
      () => ({
        call: 'requestConsume',
        args: [
          {
            faucetId: j.tokenFaucetId,
            noteId: fx.heldNoteId,
            noteType: 'public',
            amount: 1,
            noteBytes: fx.newA1.bytesB64
          }
        ]
      }),
      refusal(
        'InvalidParamsMidenWalletError',
        /^INVALID_PARAMS: Error: noteBytes describe a different note than noteId/
      )
    ),
    'R3-consumeUnresolved': refusedBeforePrompt(
      () => ({
        call: 'requestConsume',
        args: [{ faucetId: j.tokenFaucetId, noteId: `0x${'ab'.repeat(32)}`, noteType: 'public', amount: 1 }]
      }),
      refusal('InvalidParamsMidenWalletError', /^INVALID_PARAMS: Error: Note 0x(ab){32} could not be resolved/)
    ),
    'R3-network': refusedBeforePrompt(
      () => ({ call: 'connect', args: ['UPON_REQUEST', 'mainnet'] }),
      // createError maps any message containing NOT_GRANTED to this class (client.ts:293-298).
      refusal('NotGrantedMidenWalletError', 'NETWORK_NOT_GRANTED')
    ),
    R6: {
      budget: 'read',
      run: async ctx => {
        expect(await callDapp(dapp, 'waitForTransaction', { txId: 'no-such-row' }, ctx.deadline)).toEqual(
          refusal('WalletTransactionError', 'Transaction not found')
        );
      }
    },
    R11: {
      budget: 'read',
      run: async ctx => {
        const malformed = Buffer.from([0, 1, 2, 3, 4]).toString('base64');
        const before = (await noteIdsSeenOver(j, 1, ctx)).sort();
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'importNote', { noteBytesB64: malformed }, ctx.deadline),
          { kind: 'importPrivateNote', decision: 'approve', origin: dapp.origin },
          ctx
        );
        expect(result).toEqual(refusal('InvalidParamsMidenWalletError', /^INVALID_PARAMS: /));
        // Only a network failure or a pipeline kill queues bytes for a retry (dapp.ts:1410-1414).
        expect(await pendingImportQueue(j.walletA.page)).not.toContain(malformed);
        expect((await noteIdsSeenOver(j, 1, ctx)).sort()).toEqual(before);
      }
    }
  };
}

function failureCells(j: Journey, fx: RefusalFixtures): Record<string, DappCellImpl> {
  const { dapp } = j;
  const toB = (amount: bigint) => ({
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: amount.toString(),
    noteType: 'public' as const
  });
  return {
    R4: {
      budget: 'write',
      run: async ctx => {
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        // The queue blocker holds the loop, so the cancel provably lands while the row is Queued (history.ts:337-376).
        const blocker = await plantQueueBlocker(j.walletA.page);
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'send', { ...toB(tst(1)), via: 'requestSend' }, ctx.deadline),
          { kind: 'transaction', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const { txId } = unwrap(result, 'requestSend behind the queue blocker', ctx);
        expect((await readTransactionRow(j.walletA.page, txId))?.status).toBe(TxStatus.Queued);
        await openHistoryDetails(j.walletA, txId);
        await j.walletA.page.getByTestId('history-cancel-button').click({ timeout: 30_000 });
        // The click only asks for the cancel; a release before it is written would let the loop build the send.
        await pollUntil(
          () => readTransactionRow(j.walletA.page, txId),
          row => row?.status === TxStatus.Failed,
          `row ${txId} cancelled`,
          ctx
        );
        await releaseQueueBlocker(j.walletA.page, blocker);
        await expectCancelledWhileQueued(side, baseline, txId, ctx);
      }
    },
    R5: {
      budget: 'write',
      run: async ctx => {
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const built = await callDapp(
          dapp,
          'buildCustom',
          { shape: 'p2id', outputs: [toB(FUND_A * 10n)], carryNoteBytesB64: [fx.proofB64.carry] },
          ctx.deadline
        );
        await advanceChain(j.walletA, dapp, built.boundBlockNum + 3, ctx);
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'submitCustom',
              { requestId: built.requestId, recipientAddress: j.addressB, importNotes: true },
              ctx.deadline
            ),
          {
            kind: 'transaction',
            decision: 'approve',
            origin: dapp.origin,
            whileOpen: async popup => {
              await expect(popup.getByTestId('tx-simulation-failed')).toBeVisible({ timeout: 60_000 });
              await popupBlock(dapp, ctx);
            }
          },
          ctx
        );
        const { txId } = unwrap(result, 'an overspending custom request is still queued', ctx);
        await expectFailedAfterEnqueue(side, baseline, txId, pinned.texts.R5[j.axis.label], ctx);
        // The approval released the dry run's quarantine (dapp.ts:1956-1961), so the failure leaves the note claimable.
        await pollUntil(
          () => pendingNote(j.walletA.page, fx.carry.noteId),
          note => note !== null,
          'carried note claimable',
          ctx
        );
      }
    },
    R8: {
      budget: 'write',
      run: async ctx => {
        j.touch('spendingLimit');
        // The E2E build prices TST at $1 (src/lib/prices/usd.ts isE2eFixtureSymbol), so 500 USD covers 5 TST.
        await j.walletA.configureSpendingLimitForTest({
          tokenSymbol: TOKEN,
          dailyLimitUsdMicro: (500n * 1_000_000n).toString()
        });
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'p2id', outputs: [toB(tst(5))] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: 3,
            vaultDelta: { [j.tokenFaucetId]: -tst(5) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^5 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    R9: {
      budget: 'write',
      run: async ctx => {
        j.touch('faults');
        await setDelegatedProving(j, true);
        await j.walletA.armNetworkFault({ target: 'prover', mode: 'abort' });
        // The wallet re-proves locally when the delegated prover fails (miden-client-interface.ts:2313).
        await dappSendToTheEnd(j, dapp, { amount: tst(1), noteType: 'public', via: 'requestSend' }, ctx);
        // Arming is best effort; a fault that never landed would make this a plain send.
        expect(await j.walletA.networkFaultHits()).not.toBe(0);
      }
    },
    R10: {
      budget: 'write',
      run: async ctx => {
        // Made here, not in setup: B's wallet lists its own note to itself, so the first quiesce would claim it.
        const [toBNote] = await produceNotesFromB(
          j,
          [{ recipientAddress: j.addressB, faucetId: j.tokenFaucetId, amount: tst(2).toString(), noteType: 'private' }],
          ctx
        );
        if (toBNote === undefined) throw new HarnessFault("B's producer returned no note");
        // With its proof, the import returns the note id; bare bytes return the details commitment (K10).
        const file = await callDapp(
          dapp,
          'makeNoteFile',
          { noteBytesB64: toBNote.bytesB64, format: 'withProof' },
          ctx.deadline
        );
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const imported = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'importNote', { noteBytesB64: file.bytesB64 }, ctx.deadline),
          { kind: 'importPrivateNote', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const { noteId } = unwrap(imported.result, 'import of a note addressed to B', ctx);
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'consume',
              {
                noteId,
                faucetId: j.tokenFaucetId,
                amount: toBNote.amount.toString(),
                noteType: 'private',
                via: 'requestConsume'
              },
              ctx.deadline
            ),
          { kind: 'consume', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const { txId } = unwrap(result, 'requestConsume of a note addressed to B', ctx);
        await expectFailedAfterEnqueue(side, baseline, txId, pinned.texts.R10[j.axis.label], ctx);
        // The failed consume spent nothing: B claims exactly that note, which also leaves B nothing pending.
        await expectReceivedByRecipient(
          j.walletB,
          [{ noteId: toBNote.noteId, faucetId: toBNote.faucetId, amount: toBNote.amount }],
          ctx
        );
      }
    }
  };
}

function defineRefusalsJourney(axis: DappAxis): void {
  test(journeyTitle('R', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.R);
    const j = await startJourney({ journey: 'R', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    let fixtures: RefusalFixtures | undefined;
    await steps
      .step('refusal_fixtures', async () => {
        const primary = await j.account('primary');
        const heldNoteId = (await midenCli.mint(j.cliFaucetId, primary, tst(2.5), 'public')).noteId;
        await midenCli.sync();
        await expect.poll(() => pendingNote(walletA.page, heldNoteId), { timeout: 180_000 }).not.toBeNull();
        const read = setupContext(2 * 60_000, 'held note on chain');
        const held = await pollUntil(
          () => callDapp(j.dapp, 'chainNote', { noteId: heldNoteId }, read.deadline),
          note => note.found,
          'held note on chain',
          read,
          { bounded: true }
        );
        const [newA1, newA2, carry] = await produceNotesFromB(
          j,
          [
            { recipientAddress: primary, faucetId: j.tokenFaucetId, amount: tst(1.5).toString(), noteType: 'private' },
            { recipientAddress: primary, faucetId: j.tokenFaucetId, amount: tst(1.25).toString(), noteType: 'private' },
            { recipientAddress: primary, faucetId: j.tokenFaucetId, amount: tst(1.75).toString(), noteType: 'private' }
          ],
          setupContext(6 * 60_000, 'produce notes for the refusal journey')
        );
        if (
          newA1 === undefined ||
          newA2 === undefined ||
          carry === undefined ||
          held.noteBytesB64 === undefined ||
          held.nullifierHex === undefined
        ) {
          throw new Error('refusal fixtures are incomplete');
        }
        const files = setupContext(2 * 60_000, 'proof files for the declines');
        const proofOf = async (note: ProducedNote) =>
          (await callDapp(j.dapp, 'makeNoteFile', { noteBytesB64: note.bytesB64, format: 'withProof' }, files.deadline))
            .bytesB64;
        fixtures = {
          heldNoteId,
          heldBytesB64: held.noteBytesB64,
          heldNullifierHex: held.nullifierHex,
          newA1,
          newA2,
          proofB64: {
            newA1: await proofOf(newA1),
            newA2: await proofOf(newA2),
            carry: await proofOf(carry)
          },
          carry
        };
      })
      .catch((error: unknown) => {
        // Journey setup, so a node that fails B's dApp records the cells blocked (infrastructure), not not-run.
        j.runner.setupFailed(error);
        throw error;
      });
    if (fixtures === undefined) throw new Error('no refusal fixtures');
    await runJourneyCells(j, { ...signingCells(j), ...refusalCells(j, fixtures), ...failureCells(j, fixtures) });
  });
}

for (const axis of dappAxes()) defineRefusalsJourney(axis);

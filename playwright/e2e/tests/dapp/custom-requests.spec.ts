import { expect, test } from '../../fixtures/two-wallets';
import { pollUntil } from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { normalizeHex } from '../../helpers/dapp-gates';
import {
  runJourneyCells,
  setupContext,
  startJourney,
  tst,
  type DappCellImpl,
  type Journey
} from '../../helpers/dapp-journey';
import { cellIdsFor, JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import {
  customWriteToTheEnd,
  pendingNote,
  produceNotesFromB,
  sideOf,
  type ProducedNote
} from '../../helpers/dapp-writes';
import { readTransactionRows } from '../../helpers/history';
import { callDapp } from '../../helpers/test-dapp';

const ATTACHMENT = ['1', '2', '3', '4', '5', '6', '7', '8'];
const EXPLICIT_SCHEME = 42;
const B3 = 3;

interface CustomFixtures {
  supplied: ProducedNote;
  nativeForSecond: ProducedNote;
  heldNoteId: string;
}

function customCells(j: Journey, fx: CustomFixtures): Record<string, DappCellImpl> {
  const { dapp } = j;
  const toB = (amount: bigint, noteType: 'public' | 'private' = 'public') => ({
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: amount.toString(),
    noteType
  });
  return {
    X1: {
      budget: 'write',
      run: async ctx => {
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'p2id', outputs: [toB(tst(5))] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(5) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^5 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X2: {
      budget: 'write',
      run: async ctx => {
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: {
              shape: 'p2ide',
              outputs: [toB(tst(2))],
              attachment: { felts: ATTACHMENT },
              reclaimAfterBlocks: 1_000
            },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(2) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^2 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X3: {
      budget: 'write',
      run: async ctx => {
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: {
              shape: 'p2ide',
              outputs: [toB(tst(2))],
              attachment: { felts: ATTACHMENT, scheme: EXPLICIT_SCHEME },
              reclaimAfterBlocks: 1_000
            },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(2) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^2 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X4: {
      budget: 'write',
      run: async ctx => {
        // A private output with recipientAddress B: the wallet relays it (complete.ts:105-140).
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'p2id', outputs: [toB(tst(4), 'private')] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(4) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^4 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X5: {
      budget: 'write',
      run: async ctx => {
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'consume-and-pay', outputs: [toB(tst(1.5))], inputNoteBytesB64: [fx.supplied.bytesB64] },
            submit: { recipientAddress: j.addressB, importNotes: true },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: fx.supplied.amount - tst(1.5) },
            toB: [true],
            consumedNullifiers: [fx.supplied.nullifierHex],
            // Gross on single-sig (1.5 out, 4 in); net on Guardian (+2.5), whose summary nets each faucet.
            preview: { amount: /^1\.5 TST$/, netAmount: /^2\.5 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X5f: {
      budget: 'write',
      state: { account: 'second' },
      run: async ctx => {
        const side = await sideOf(j, dapp, 'second');
        expect((await callDapp(dapp, 'chainAccount', { accountId: side.accountIdHex }, ctx.deadline)).found).toBe(
          false
        );
        const rowsBefore = (await readTransactionRows(j.walletA.page)).map(row => row.id);
        await customWriteToTheEnd(
          j,
          dapp,
          {
            slot: 'second',
            build: {
              shape: 'consume-and-pay',
              outputs: [toB(tst(1))],
              inputNoteBytesB64: [fx.nativeForSecond.bytesB64]
            },
            submit: { recipientAddress: j.addressB, importNotes: true },
            advance: B3,
            vaultDelta: { [j.nativeFaucetId]: fx.nativeForSecond.amount, [j.tokenFaucetId]: tst(2) - tst(1) },
            toB: [true],
            consumedNullifiers: [fx.nativeForSecond.nullifierHex],
            preview: { amount: /^1 TST$/, outputNotes: 1 }
          },
          ctx
        );
        // Review Focus 2: auto-consume stays on here, and an execute row does not protect its input notes from it
        // (sync-manager.ts:618-622), so a second, failing consume of the carried native note would show up as a row.
        for (let lap = 0; lap < 2; lap += 1) {
          await ctx.deadline.race(j.walletA.triggerSync(true), `sync lap ${lap + 1} after the first transaction`);
        }
        const extra = (await readTransactionRows(j.walletA.page)).filter(
          row =>
            !rowsBefore.includes(row.id) &&
            row.type === 'consume' &&
            [row.noteId, ...(row.noteIds ?? [])].some(
              id => id !== undefined && normalizeHex(id) === normalizeHex(fx.nativeForSecond.noteId)
            )
        );
        expect(extra.map(row => `${row.id} status=${row.status} ${row.error ?? ''}`)).toEqual([]);
      }
    },
    X7: {
      budget: 'long',
      run: async ctx => {
        for (const feeSalt of [false, true]) {
          const { built, written } = await customWriteToTheEnd(
            j,
            dapp,
            {
              build: { shape: 'p2id', outputs: [toB(tst(1))], authArgs: 'none', feeSalt },
              submit: { recipientAddress: j.addressB, importNotes: false },
              advance: B3,
              vaultDelta: { [j.tokenFaucetId]: -tst(1) },
              toB: [true],
              consumedNullifiers: [],
              preview: { amount: /^1 TST$/, outputNotes: 1 }
            },
            ctx
          );
          expect(written.outputNotes.map(note => note.bytesB64)).toEqual(built.outputNoteBytesB64);
          const chainBytes = await Promise.all(
            built.outputNoteIds.map(
              async noteId => (await callDapp(dapp, 'chainNote', { noteId }, ctx.deadline)).noteBytesB64
            )
          );
          expect(chainBytes).toEqual(built.outputNoteBytesB64);
        }
      }
    },
    X11: {
      budget: 'write',
      run: async ctx => {
        // A note the wallet already holds, consumed through withInputNotes and inputNoteIds, with no importNotes.
        const held = await pollUntil(
          () => callDapp(dapp, 'chainNote', { noteId: fx.heldNoteId }, ctx.deadline),
          note => note.found,
          'held note on chain',
          ctx,
          { bounded: true }
        );
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'consume-and-pay', outputs: [toB(tst(1))], inputNoteBytesB64: [held.noteBytesB64 ?? ''] },
            submit: { recipientAddress: j.addressB, importNotes: false, inputNoteIds: [fx.heldNoteId] },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: tst(3) - tst(1) },
            toB: [true],
            consumedNullifiers: [held.nullifierHex ?? ''],
            preview: { amount: /^1 TST$/, netAmount: /^2 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    X8a: {
      budget: 'write',
      run: async ctx => {
        // The dApp's own script pays B through the basic wallet's create_note and move_asset_to_note.
        const { written } = await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { kind: 'pay', outputs: [toB(tst(2))] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(2) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^2 TST$/, outputNotes: 1, storageChanged: false }
          },
          ctx
        );
        expect(
          written.outputNotes.map(note => note.script),
          'output note script'
        ).toEqual(['p2id']);
      }
    },
    X8b: {
      budget: 'write',
      run: async ctx => {
        // Landing proves the script argument and the advice words reached execution unchanged.
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { kind: 'pay-checked', outputs: [toB(tst(3), 'private')] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: B3,
            vaultDelta: { [j.tokenFaucetId]: -tst(3) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^3 TST$/, outputNotes: 1, storageChanged: false }
          },
          ctx
        );
      }
    },
    X8c: {
      budget: 'write',
      run: async ctx => {
        const { written } = await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { kind: 'fee-only', outputs: [] },
            submit: { recipientAddress: '', importNotes: false },
            advance: B3,
            vaultDelta: {},
            toB: [],
            consumedNullifiers: [],
            preview: { amount: null, outputNotes: 0, storageChanged: false }
          },
          ctx
        );
        // The native drop is exactly the row's fee (expectWritesToTheEnd step 5); a zero fee would make that vacuous.
        expect(written.feeAmount !== 0n, 'the row recorded the fee it paid').toBe(j.env.chargesFees === true);
      }
    }
  };
}

function lateCells(j: Journey): Record<string, DappCellImpl> {
  return {
    X6: {
      budget: 'long',
      run: async ctx => {
        // Past the node's 50 blocks of account history (KB miden-node-keeps-50-blocks-of-account-history).
        await customWriteToTheEnd(
          j,
          j.dapp,
          {
            build: {
              shape: 'p2id',
              outputs: [
                {
                  recipientAddress: j.addressB,
                  faucetId: j.tokenFaucetId,
                  amount: tst(2).toString(),
                  noteType: 'public'
                }
              ]
            },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: 55,
            vaultDelta: { [j.tokenFaucetId]: -tst(2) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^2 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    }
  };
}

function defineCustomJourneys(axis: DappAxis): void {
  test(journeyTitle('X', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.X);
    const j = await startJourney({ journey: 'X', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    let fixtures: CustomFixtures | undefined;
    await steps
      .step('custom_request_fixtures', async () => {
        const primary = await j.account('primary');
        // X11's note: public TST that A holds unclaimed (auto-consume takes only the native asset).
        const heldNoteId = (await midenCli.mint(j.cliFaucetId, primary, tst(3), 'public')).noteId;
        await midenCli.sync();
        await expect.poll(() => pendingNote(walletA.page, heldNoteId), { timeout: 180_000 }).not.toBeNull();
        // The second account exists only on a leg that runs X5f, so the Guardian leg makes no extra account.
        const second = cellIdsFor('X', axis.label).includes('X5f') ? await j.account('second') : primary;
        const [supplied, nativeForSecond] = await produceNotesFromB(
          j,
          [
            { recipientAddress: primary, faucetId: j.tokenFaucetId, amount: tst(4).toString(), noteType: 'private' },
            // X5f's note: the second account's first transaction pays its fee from this note's native asset.
            {
              recipientAddress: second,
              faucetId: j.nativeFaucetId,
              amount: '5000000',
              noteType: 'private',
              extraAssets: [{ faucetId: j.tokenFaucetId, amount: tst(2).toString() }]
            }
          ],
          setupContext(6 * 60_000, 'produce notes for the custom journey')
        );
        if (supplied === undefined || nativeForSecond === undefined) {
          throw new Error('the producer returned fewer than 2 notes');
        }
        fixtures = { supplied, nativeForSecond, heldNoteId };
      })
      .catch((error: unknown) => {
        // Journey setup, so a node that fails B's dApp records the cells blocked (infrastructure), not not-run.
        j.runner.setupFailed(error);
        throw error;
      });
    if (fixtures === undefined) throw new Error('no custom-request fixtures');
    await runJourneyCells(j, customCells(j, fixtures));
  });

  test(journeyTitle('XL', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.XL);
    const j = await startJourney({ journey: 'XL', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    await runJourneyCells(j, lateCells(j));
  });
}

for (const axis of dappAxes()) defineCustomJourneys(axis);

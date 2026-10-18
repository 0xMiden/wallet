import { expect } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';

import { fromBaseUnits } from './balance-truth';
import { pollUntil } from './dapp-assertions';
import { CellDeadlineExceeded, HarnessFault, type CellContext } from './dapp-cells';
import { ChainUnavailable } from './dapp-channel';
import { assetMap, canonicalAddress, normalizeHex } from './dapp-gates';
import { FUND_A, tst } from './dapp-journey';
import { REFUSAL_WRAPPERS } from './dapp-known-bugs';
import {
  AUTO_DECLINE_MS,
  HELD_R7,
  HELD_W4,
  remember,
  sheetBlock,
  type MobileCellImpl,
  type MobileCellState,
  type MobileJourney
} from './dapp-mobile-journey';
import { answerSheet, approveSheetIfShown, expectNoSheet } from './dapp-mobile-sheet';
import { selectAccount, vaultAssets } from './dapp-mobile-wallet';
import {
  captureMobileBaseline,
  captureRowWindow,
  expectFailedAfterEnqueueMobile,
  expectMobileWriteToTheEnd,
  expectNoNewMobileRows,
  mobileSideOf,
  rowOwner
} from './dapp-mobile-writes';
import { waitForNodeHeight } from './dapp-node-calls';
import pinned from './dapp-pinned.json';
import { beforeMobileDeadline } from './mobile-store-reads';
import { TOKEN, TOKEN_DECIMALS } from './money-path';
import { ECDSA_SCHEME_TAG, recoverEcdsaPublicKey } from './signature-recovery';
import { unwrap } from './test-dapp';
import type { ConnectedView, Outcome, RawArg, SessionView, SignatureView } from '../test-dapp/protocol';

/**
 * The mobile slim set (spec 3.6). Each claim is the extension cell's of the same id, answered on the approval sheet
 * instead of a popup; the chain waits a popup's page ran move to the driver (spec 3.3).
 */
const WORD = `0x${'11'.repeat(32)}`;
/** Blocks between the dApp's build and its request, as X1 and R5 run on the extension (spec B3). */
const B3 = 3;
/** The harness's clock can read the request a little before the wallet's timer started on it. */
const DECLINE_EARLY_MS = 1_000;
const DECLINE_LATE_MS = 20_000;
const SHEET = pinned.sheet;
interface ExpectedRefusal {
  name: string;
  message: string | RegExp;
  causeName?: string;
}
const CONNECT_DECLINED: ExpectedRefusal = {
  name: REFUSAL_WRAPPERS.connect,
  message: 'NOT_GRANTED',
  causeName: 'NotGrantedMidenWalletError'
};
const NOT_GRANTED_WRAPPED: ExpectedRefusal = {
  name: REFUSAL_WRAPPERS.transaction,
  message: 'NOT_GRANTED',
  causeName: 'NotGrantedMidenWalletError'
};
const NOT_GRANTED_RAW: ExpectedRefusal = { name: 'NotGrantedMidenWalletError', message: 'NOT_GRANTED' };

type RawRequest = { call: 'requestSend' | 'requestTransaction'; args: RawArg[] };

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const sameAs = (address: string | null, account: string): boolean =>
  address !== null && canonicalAddress(address) === canonicalAddress(account);
const canonicalOrNull = (address: string | null): string | null =>
  address === null ? null : canonicalAddress(address);
const sides = (view: SessionView) => ({
  provider: canonicalOrNull(view.providerAddress),
  adapter: canonicalOrNull(view.adapterAddress)
});
const onBoth = (account: string) => ({ provider: canonicalAddress(account), adapter: canonicalAddress(account) });
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Class parity is soft so a provider's plain Error cannot hide row, session or auto-decline regressions.
function expectRefusal(result: Outcome<unknown>, expected: ExpectedRefusal, ctx: CellContext): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a refusal');
  ctx.evidence.dappError = result.error;
  expect(result.error.message).toEqual(
    typeof expected.message === 'string' ? expected.message : expect.stringMatching(expected.message)
  );
  if (
    result.error.name !== expected.name ||
    (expected.causeName !== undefined && result.error.causeName !== expected.causeName)
  ) {
    ctx.softFail(
      'refusal-class',
      `the refusal was ${JSON.stringify(result.error)}, expected name ${expected.name}` +
        (expected.causeName === undefined ? '' : ` and causeName ${expected.causeName}`)
    );
  }
}

export function mobileCells(j: MobileJourney): Record<string, MobileCellImpl> {
  const connectInput = { permission: 'UponRequest' as const, network: j.network };
  const toB = (amount: bigint) => ({
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: amount.toString(),
    noteType: 'public' as const
  });
  const connectedView = async (ctx: CellContext): Promise<ConnectedView> => {
    const view = await j.call('session', {}, ctx.deadline);
    if (view.connected === null) throw new HarnessFault('the dApp is not connected');
    return view.connected;
  };
  const connectAsCurrent = async (ctx: CellContext): Promise<ConnectedView> => {
    const { result } = await approveSheetIfShown(j.dapp, () => j.call('connect', connectInput, ctx.deadline), ctx);
    const connected = unwrap(result, 'connect as the current account', ctx);
    remember(j, connected);
    return connected;
  };
  const sessionWithin = async (
    done: (view: SessionView) => boolean,
    ms: number,
    ctx: CellContext
  ): Promise<SessionView> => {
    const until = Date.now() + ms;
    let view = await j.call('session', {}, ctx.deadline);
    while (!done(view) && Date.now() < until) {
      await beforeMobileDeadline(ctx.deadline, 'the next session poll', () => sleep(1_000));
      view = await j.call('session', {}, ctx.deadline);
    }
    return view;
  };
  const rawSend = (me: ConnectedView, fields: Record<string, RawArg>): RawArg => ({
    senderAddress: me.addressCanonical,
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: Number(tst(1)),
    ...fields
  });
  // The page's own build at its height N, the chain past N + 3 by the driver's read, then the request.
  const buildPast = async (amount: bigint, ctx: CellContext) => {
    const built = await j.call('buildCustom', { shape: 'p2id', outputs: [toB(amount)] }, ctx.deadline);
    try {
      await beforeMobileDeadline(ctx.deadline, 'the chain past the dApp height', () =>
        waitForNodeHeight(j.env.rpcUrl, built.boundBlockNum + B3, ctx.deadline.remainingMs())
      );
    } catch (error) {
      if (error instanceof CellDeadlineExceeded) {
        throw new ChainUnavailable(`${ctx.deadline.label}: the chain did not pass the dApp height before the cutoff`);
      }
      throw error;
    }
    return built;
  };

  const signedCell = (
    kind: 'word' | 'signingInputs',
    ask: (ctx: CellContext) => Promise<Outcome<SignatureView>>
  ): MobileCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const me = await connectedView(ctx);
      const { result } = await answerSheet(j.dapp, () => ask(ctx), { decision: 'approve' }, ctx);
      const signature = unwrap(result, `signBytes(${kind})`, ctx);
      expect(signature.schemeTag).toBe(ECDSA_SCHEME_TAG);
      // On Guardian the key behind the signature must be the one connect handed the dApp.
      expect(
        await j.call(
          'verifySignature',
          {
            kind,
            payloadB64: signature.payloadB64,
            signatureB64: signature.signatureB64,
            publicKeyB64: recoverEcdsaPublicKey(signature.signatureB64, signature.messageB64)
          },
          ctx.deadline
        )
      ).toEqual({ verifies: true, commitmentHex: me.publicKeyHex });
    }
  });

  const declined = (start: (ctx: CellContext) => Promise<Outcome<unknown>>): MobileCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const owner = await beforeMobileDeadline(ctx.deadline, 'the row owner', () => rowOwner(j));
      const since = await captureRowWindow(owner.wallet, ctx);
      const { result } = await answerSheet(j.dapp, () => start(ctx), { decision: 'deny' }, ctx);
      expectRefusal(result, NOT_GRANTED_WRAPPED, ctx);
      await expectNoNewMobileRows(owner, since, ctx);
    }
  });

  const refusedBeforeSheet = (build: (me: ConnectedView) => RawRequest, expected: ExpectedRefusal): MobileCellImpl => ({
    budget: 'read',
    run: async ctx => {
      const me = await connectedView(ctx);
      const owner = await beforeMobileDeadline(ctx.deadline, 'the row owner', () => rowOwner(j));
      const since = await captureRowWindow(owner.wallet, ctx);
      const result = await expectNoSheet(j.dapp, () => j.call('raw', build(me), ctx.deadline), ctx, { refusal: true });
      expectRefusal(result, expected, ctx);
      await expectNoNewMobileRows(owner, since, ctx);
    }
  });

  // R7: nothing is pressed; the wallet declines after 120 s like the extension's popup (spec 3.6, D8, #1474).
  const unanswered = (
    state: Partial<MobileCellState>,
    start:
      | ((ctx: CellContext) => Promise<Outcome<unknown>>)
      | { prepare: (ctx: CellContext) => Promise<() => Promise<Outcome<unknown>>> },
    expected: ExpectedRefusal
  ): MobileCellImpl => ({
    budget: 'long',
    state,
    run: async ctx => {
      const owner = await beforeMobileDeadline(ctx.deadline, 'the row owner', () => rowOwner(j));
      const since = await captureRowWindow(owner.wallet, ctx);
      const request = typeof start === 'function' ? () => start(ctx) : await start.prepare(ctx);
      const { result, sheet, answeredAt } = await answerSheet(j.dapp, request, { decision: 'none' }, ctx);
      ctx.evidence.stepDurationsMs = {
        ...ctx.evidence.stepDurationsMs,
        declineFromRequest: answeredAt - sheet.sentAt,
        declineFromSheet: answeredAt - sheet.seenAt
      };
      expectRefusal(result, expected, ctx);
      // The wallet starts its timer once it has the request, after the driver sent it, so no decline lands sooner.
      expect(answeredAt - sheet.sentAt, 'ms from the request to the decline').toBeGreaterThanOrEqual(
        AUTO_DECLINE_MS - DECLINE_EARLY_MS
      );
      expect(answeredAt - sheet.seenAt, 'ms from the sheet to the decline').toBeLessThanOrEqual(
        AUTO_DECLINE_MS + DECLINE_LATE_MS
      );
      await expectNoNewMobileRows(owner, since, ctx);
    }
  });

  return {
    S1: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        // Late injection: the in-app browser injects the provider once the page has loaded (browserPageLoaded).
        expect(j.providerAtBoot, 'window.midenWallet present when the page booted').toBe(false);
        expect(await j.call('detect', { timeoutMs: 10_000 }, ctx.deadline)).toEqual({
          readyState: 'Installed',
          isAvailable: true
        });
      }
    },
    S2: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const primary = await beforeMobileDeadline(ctx.deadline, 'the primary account', () =>
          j.account('primary', ctx.deadline)
        );
        const { result, sheet } = await answerSheet(
          j.dapp,
          () => j.call('connect', connectInput, ctx.deadline),
          { decision: 'approve' },
          ctx
        );
        expect(sheet.origin).toBe(j.dapp.origin);
        const connected = unwrap(result, 'connect', ctx);
        remember(j, connected);
        expect(canonicalAddress(connected.address)).toBe(canonicalAddress(primary));
        expect(connected.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
        expect(connected.builder).toBe(j.axis.expected.builder);
        expect(
          await beforeMobileDeadline(ctx.deadline, 'connect key membership', () =>
            j.axis.connectKeyMembership(j.walletA, primary, connected.publicKeyHex)
          )
        ).toBe(j.axis.expected.connectKeyMembership);
      }
    },
    S3: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const { result, sheet } = await answerSheet(
          j.dapp,
          () => j.call('connect', connectInput, ctx.deadline),
          { decision: 'deny' },
          ctx
        );
        expect(sheet.origin).toBe(j.dapp.origin);
        expectRefusal(result, CONNECT_DECLINED, ctx);
        expect((await j.call('session', {}, ctx.deadline)).providerAddress).toBeNull();
      }
    },
    S6: {
      budget: 'read',
      run: async ctx => {
        const before = await j.call('session', {}, ctx.deadline);
        const old = before.adapterAddress ?? '';
        expect(old).not.toBe('');
        expect(await j.call('disconnect', {}, ctx.deadline)).toEqual({ adapterAddress: null });
        const after = await j.call('session', {}, ctx.deadline);
        expect(after.events.slice(before.events.length).map(event => `${event.source}:${event.event}`)).toContain(
          'adapter:disconnect'
        );
        const send: RawArg = {
          senderAddress: canonicalAddress(old),
          recipientAddress: j.addressB,
          faucetId: j.tokenFaucetId,
          noteType: 'public',
          amount: Number(tst(1))
        };
        // Through the provider with the old address: the adapter would refuse client-side once disconnected.
        const stale = await expectNoSheet(
          j.dapp,
          () => j.call('raw', { call: 'requestSend', args: [send], asAddress: old }, ctx.deadline),
          ctx,
          { refusal: true }
        );
        expectRefusal(stale, NOT_GRANTED_RAW, ctx);
        const again = await answerSheet(
          j.dapp,
          () => j.call('connect', connectInput, ctx.deadline),
          { decision: 'approve' },
          ctx
        );
        remember(j, unwrap(again.result, 'connect after disconnect prompts again', ctx));
      }
    },
    S10: {
      budget: 'read',
      run: async ctx => {
        expect(unwrap(await j.call('guardianInfo', {}, ctx.deadline), 'requestGuardianInfo', ctx)).toEqual(
          j.axis.expected.guardianInfo(j.env)
        );
      }
    },
    S11: {
      budget: 'read',
      state: { session: 'auto' },
      run: async ctx => {
        const result = await j.call('conformance', {}, ctx.deadline);
        // Recorded before the assertion, so a signature can name the one method a provider lacks (spec 3.7).
        ctx.evidence.conformanceFailed = result.failed.map(entry => entry.name);
        expect(result.failed).toEqual([]);
        expect(result.passed.length).toBeGreaterThanOrEqual(13);
      }
    },
    N1: {
      budget: 'read',
      run: async ctx => {
        const { result } = await answerSheet(
          j.dapp,
          () => j.call('assets', {}, ctx.deadline),
          { decision: 'approve' },
          ctx
        );
        expect(assetMap(unwrap(result, 'requestAssets', ctx))).toEqual(
          await beforeMobileDeadline(ctx.deadline, 'the wallet assets', () => vaultAssets(j.walletA))
        );
      }
    },
    G1: signedCell('word', ctx => j.call('signWord', { wordHex: WORD }, ctx.deadline)),
    G2a: signedCell('signingInputs', ctx =>
      j.call('signSigningInputs', { variant: 'arbitrary', felts: ['1', '2', '3'] }, ctx.deadline)
    ),
    M1: {
      // The second account is created on first use, and a Guardian one registers with its operator first.
      budget: 'write',
      run: async ctx => {
        const primary = await beforeMobileDeadline(ctx.deadline, 'the primary account', () =>
          j.account('primary', ctx.deadline)
        );
        const second = await beforeMobileDeadline(ctx.deadline, 'the second account', () =>
          j.account('second', ctx.deadline)
        );
        // With a session on both accounts the provider's poll moves to the second account instead of to null.
        await selectAccount(j.walletA, second, ctx.deadline);
        expect(canonicalAddress((await connectAsCurrent(ctx)).address)).toBe(canonicalAddress(second));
        await selectAccount(j.walletA, primary, ctx.deadline);
        expect(canonicalAddress((await connectAsCurrent(ctx)).address)).toBe(canonicalAddress(primary));
        const before = await j.call('session', {}, ctx.deadline);
        expect(sides(before)).toEqual(onBoth(primary));
        await selectAccount(j.walletA, second, ctx.deadline);
        const moved = await sessionWithin(view => sameAs(view.providerAddress, second), 20_000, ctx);
        expect(canonicalOrNull(moved.providerAddress)).toBe(canonicalAddress(second));
        // K1's evidence, written only once the start state and the provider are checked.
        ctx.evidence.previousAddress = before.adapterAddress;
        ctx.evidence.providerAddress = moved.providerAddress;
        ctx.evidence.adapterAddress = moved.adapterAddress;
        expect(canonicalOrNull(moved.adapterAddress)).toBe(canonicalAddress(second));
        await selectAccount(j.walletA, primary, ctx.deadline);
        const back = await sessionWithin(view => sameAs(view.providerAddress, primary), 20_000, ctx);
        expect(sides(back)).toEqual(onBoth(primary));
      }
    },
    N3a: {
      budget: 'read',
      run: async ctx => {
        const file = await j.call(
          'makeNoteFile',
          { noteBytesB64: j.produced.bytesB64, format: 'withProof' },
          ctx.deadline
        );
        const { result } = await answerSheet(
          j.dapp,
          () => j.call('importNote', { noteBytesB64: file.bytesB64 }, ctx.deadline),
          { decision: 'approve' },
          ctx
        );
        const { noteId } = unwrap(result, 'importPrivateNote (withProof)', ctx);
        expect(normalizeHex(noteId)).toBe(normalizeHex(j.produced.noteId));
      }
    },
    W1: {
      budget: 'write',
      run: async ctx => {
        const side = await beforeMobileDeadline(ctx.deadline, 'the write side', () => mobileSideOf(j));
        const baseline = await captureMobileBaseline(side, [j.tokenFaucetId], ctx);
        const amount = tst(5);
        const { result } = await answerSheet(
          j.dapp,
          () => j.call('send', { ...toB(amount), via: 'requestSend' }, ctx.deadline),
          { decision: 'approve', whileOpen: sheet => sheetBlock(j.env.rpcUrl, sheet, ctx) },
          ctx
        );
        const { txId } = unwrap(result, 'requestSend', ctx);
        const written = await expectMobileWriteToTheEnd(
          side,
          baseline,
          { txId, outputNotes: [{ noteType: 'public', toB: amount }], consumedNullifiers: [] },
          { [j.tokenFaucetId]: -amount },
          ctx
        );
        expect(
          written.outputNotes.map(note => note.script),
          'output note script'
        ).toEqual(['p2id']);
      }
    },
    W4: {
      budget: 'write',
      // Under Auto with notes granted the list comes with no sheet, so discovery is the dApp's own view.
      state: { session: 'auto' },
      run: async ctx => {
        const listed = await pollUntil(
          async () =>
            unwrap(
              await expectNoSheet(j.dapp, () => j.call('consumableNotes', {}, ctx.deadline), ctx),
              'requestConsumableNotes',
              ctx
            ),
          notes => notes.some(note => normalizeHex(note.noteId) === normalizeHex(j.held.w4.noteId)),
          'the held note listed as consumable',
          ctx,
          { bounded: true, intervalMs: 3_000 }
        );
        const held = listed.find(note => normalizeHex(note.noteId) === normalizeHex(j.held.w4.noteId));
        expect(held?.assets).toEqual([{ faucetId: j.tokenFaucetId, amount: HELD_W4.toString() }]);
        const side = await beforeMobileDeadline(ctx.deadline, 'the write side', () => mobileSideOf(j));
        const baseline = await captureMobileBaseline(side, [j.tokenFaucetId], ctx);
        const { result } = await answerSheet(
          j.dapp,
          () =>
            j.call(
              'consume',
              {
                noteId: j.held.w4.noteId,
                faucetId: j.tokenFaucetId,
                amount: HELD_W4.toString(),
                noteType: 'public',
                via: 'requestConsume'
              },
              ctx.deadline
            ),
          { decision: 'approve', whileOpen: sheet => sheetBlock(j.env.rpcUrl, sheet, ctx) },
          ctx
        );
        const { txId } = unwrap(result, 'requestConsume', ctx);
        await expectMobileWriteToTheEnd(
          side,
          baseline,
          { txId, outputNotes: [], consumedNullifiers: [held?.nullifier ?? ''] },
          { [j.tokenFaucetId]: HELD_W4 },
          ctx
        );
      }
    },
    X1: {
      budget: 'write',
      run: async ctx => {
        const side = await beforeMobileDeadline(ctx.deadline, 'the write side', () => mobileSideOf(j));
        const baseline = await captureMobileBaseline(side, [j.tokenFaucetId], ctx);
        const amount = tst(5);
        const built = await buildPast(amount, ctx);
        const feeSuffix = ` ${j.native.symbol}`;
        const expectedFixed = [
          SHEET.simulatedEffects,
          `${SHEET.leaves}, -${fromBaseUnits(amount, TOKEN_DECIMALS)} ${TOKEN}`,
          `${SHEET.fee}<amount>${feeSuffix}`,
          `${SHEET.notesConsumed}0`,
          `${SHEET.notesCreated}1`
        ];
        const fee: { figure?: string } = {};
        const { result } = await answerSheet(
          j.dapp,
          () =>
            j.call(
              'submitCustom',
              { requestId: built.requestId, recipientAddress: j.addressB, importNotes: false },
              ctx.deadline
            ),
          {
            decision: 'approve',
            whileOpen: async sheet => {
              // The declared preview precedes the effects; pin their fixed text before any later wait can fail.
              const from = sheet.messages.indexOf(SHEET.simulatedEffects);
              const effects = from < 0 ? [] : sheet.messages.slice(from);
              const fixed = effects.map((line, index) =>
                index === 2 && line.startsWith(SHEET.fee) && line.endsWith(feeSuffix)
                  ? `${SHEET.fee}<amount>${feeSuffix}`
                  : line
              );
              if (fixed[2] === expectedFixed[2]) {
                fee.figure = effects[2]?.slice(SHEET.fee.length, -feeSuffix.length);
              }
              if (!isDeepStrictEqual(fixed, expectedFixed)) {
                ctx.softFail(
                  'sheet-effects',
                  `the sheet showed ${JSON.stringify(sheet.messages)}, expected it to end ${JSON.stringify(expectedFixed)}`
                );
              }
              await sheetBlock(j.env.rpcUrl, sheet, ctx);
            }
          },
          ctx
        );
        const { txId } = unwrap(result, 'custom request', ctx);
        const written = await expectMobileWriteToTheEnd(
          side,
          baseline,
          {
            txId,
            outputNotes: built.outputNoteIds.map(noteId => ({
              noteId,
              noteType: 'public' as const,
              minBlock: built.boundBlockNum + B3,
              attachmentWordsHex: built.attachmentWordsHex,
              toB: amount
            })),
            consumedNullifiers: []
          },
          { [j.tokenFaucetId]: -amount },
          ctx
        );
        // Only the fee figure needs the landed row: it must be what actually left the vault.
        const expectedFee = `-${fromBaseUnits(written.feeAmount, j.native.decimals)}`;
        if (fee.figure !== undefined && fee.figure !== expectedFee) {
          ctx.softFail(
            'sheet-effects',
            `the sheet's fee amount was ${JSON.stringify(fee.figure)}, expected ${JSON.stringify(expectedFee)}`
          );
        }
      }
    },
    R5: {
      budget: 'write',
      run: async ctx => {
        const side = await beforeMobileDeadline(ctx.deadline, 'the write side', () => mobileSideOf(j));
        const baseline = await captureMobileBaseline(side, [j.tokenFaucetId], ctx);
        // Ten times what A was funded with: it deserializes, and cannot run (spec 3.6). No spending limit is set.
        const built = await buildPast(FUND_A * 10n, ctx);
        let shown: string[] = [];
        const { result } = await answerSheet(
          j.dapp,
          () =>
            j.call(
              'submitCustom',
              { requestId: built.requestId, recipientAddress: j.addressB, importNotes: false },
              ctx.deadline
            ),
          {
            decision: 'approve',
            whileOpen: async sheet => {
              shown = sheet.messages;
              await sheetBlock(j.env.rpcUrl, sheet, ctx);
            }
          },
          ctx
        );
        const texts = pinned.texts.R5[j.axis.label];
        const reason = new RegExp(`^${escapeRegExp(SHEET.reasonPrefix)}.*${escapeRegExp(texts.error)}`);
        // As in X1, the could-not-simulate pair is the sheet's tail, after the declared preview.
        const from = shown.indexOf(SHEET.notSimulated);
        const tail = from < 0 ? [] : shown.slice(from);
        if (tail.length !== 2 || !reason.test(tail[1] ?? '')) {
          ctx.softFail('sheet-not-simulated', `the sheet showed ${JSON.stringify(shown)}`);
        }
        const { txId } = unwrap(result, 'an overspending custom request is still queued', ctx);
        await expectFailedAfterEnqueueMobile(side, baseline, txId, texts, ctx);
      }
    },
    'R1-send': declined(ctx => j.call('send', { ...toB(tst(1)), via: 'requestSend' }, ctx.deadline)),
    'R1-custom': declined(async ctx => {
      const built = await j.call('buildCustom', { shape: 'p2id', outputs: [toB(tst(1))] }, ctx.deadline);
      return j.call(
        'submitCustom',
        { requestId: built.requestId, recipientAddress: j.addressB, importNotes: false },
        ctx.deadline
      );
    }),
    'R3-noteType': refusedBeforeSheet(me => ({ call: 'requestSend', args: [rawSend(me, {})] }), {
      name: 'InvalidParamsMidenWalletError',
      message: 'INVALID_PARAMS: Error: noteType is required'
    }),
    'R3-customPayload': refusedBeforeSheet(
      me => ({
        call: 'requestTransaction',
        args: [{ type: 'custom', payload: { address: me.addressCanonical, recipientAddress: '' } }]
      }),
      {
        name: 'InvalidParamsMidenWalletError',
        message: 'INVALID_PARAMS: Error: INVALID_PARAMS: Invalid CustomTransaction payload'
      }
    ),
    // K11 on the extension: the wallet prompts with its could-not-decode sheet instead (dapp.ts preview).
    'R3-customUndecodable': refusedBeforeSheet(
      me => ({
        call: 'requestTransaction',
        args: [
          {
            type: 'custom',
            payload: { address: me.addressCanonical, recipientAddress: '', transactionRequest: 'AAAA' }
          }
        ]
      }),
      { name: 'InvalidParamsMidenWalletError', message: /^INVALID_PARAMS: / }
    ),
    'R7-connect': unanswered(
      { session: 'none' },
      ctx => j.call('connect', connectInput, ctx.deadline),
      CONNECT_DECLINED
    ),
    'R7-send': unanswered(
      {},
      ctx => j.call('send', { ...toB(tst(1)), via: 'requestSend' }, ctx.deadline),
      NOT_GRANTED_WRAPPED
    ),
    'R7-consume': unanswered(
      {},
      ctx =>
        j.call(
          'consume',
          {
            noteId: j.held.r7.noteId,
            faucetId: j.tokenFaucetId,
            amount: HELD_R7.toString(),
            noteType: 'public',
            via: 'requestConsume'
          },
          ctx.deadline
        ),
      NOT_GRANTED_WRAPPED
    ),
    'R7-custom': unanswered(
      {},
      {
        prepare: async ctx => {
          const built = await j.call('buildCustom', { shape: 'p2id', outputs: [toB(tst(1))] }, ctx.deadline);
          return () =>
            j.call(
              'submitCustom',
              { requestId: built.requestId, recipientAddress: j.addressB, importNotes: false },
              ctx.deadline
            );
        }
      },
      NOT_GRANTED_WRAPPED
    )
  };
}

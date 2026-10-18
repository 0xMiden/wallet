import { expect, test } from '../../fixtures/two-wallets';
import { vaultAssetsOfCurrentAccount } from '../../helpers/balance-truth';
import { CONFIRM_ACTIONS } from '../../helpers/confirm-actions';
import {
  captureBaseline,
  expectReceivedByRecipient,
  expectWritesToTheEnd,
  pollUntil,
  refusal,
  unlessAThirdPartyMovedARead,
  vaultSyncedAfter
} from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { HarnessFault, type CellContext } from '../../helpers/dapp-cells';
import { waitForConfirmPopup } from '../../helpers/dapp-confirm';
import {
  assetMap,
  canonicalAddress,
  isForeignConsume,
  maxConcurrentConfirmPages,
  nonCurrentReadEvidence,
  normalizeHex,
  onlyStaleConsumesRan,
  type NonCurrentRead
} from '../../helpers/dapp-gates';
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
  dappSendToTheEnd,
  fundAccount,
  mintHeldNote,
  pendingNote,
  sideOf,
  type HeldNote
} from '../../helpers/dapp-writes';
import { describeTransactionRow, readTransactionRows } from '../../helpers/history';
import {
  answerIfPrompted,
  answerPrompt,
  callDapp,
  connectAsCurrent,
  dappSessionsFor,
  expectNoPrompt,
  popupBlock,
  revokeDappSession,
  selectAccountIfNeeded,
  sessionWithin,
  unwrap,
  waitForNoConfirmPages,
  type DappHandle
} from '../../helpers/test-dapp';
import type { ConnectedView, Outcome, RawArg, SessionView } from '../../test-dapp/protocol';

type StaleRequest = 'send' | 'transaction' | 'consume' | 'consumeBytes' | 'custom';
const STALE: readonly StaleRequest[] = ['send', 'transaction', 'consume', 'consumeBytes', 'custom'];
const NOT_GRANTED_WRAPPED = refusal('WalletTransactionError', 'NOT_GRANTED', 'NotGrantedMidenWalletError');
// M9 calls the provider directly, so the refusal reaches the dApp unwrapped: assertRequestAccountIsCurrent throws
// NOT_GRANTED (dapp.ts:1690-1695) and createError names it (client.ts:300-317). Consume is held to the same answer
// (Q9). M9 expects it before any popup (Q10).
const NOT_GRANTED_RAW = refusal('NotGrantedMidenWalletError', 'NOT_GRANTED');

interface AccountFixtures {
  held: Record<string, HeldNote>;
  /** N5: a private note only the second account can consume, which the wallet holds for it. */
  secondPrivateNoteId: string;
}

const sameAs = (address: string | null, account: string) =>
  address !== null && canonicalAddress(address) === canonicalAddress(account);
const canonicalOrNull = (address: string | null) => (address === null ? null : canonicalAddress(address));
const sides = (view: SessionView) => ({
  provider: canonicalOrNull(view.providerAddress),
  adapter: canonicalOrNull(view.adapterAddress)
});
const onBoth = (account: string) => ({ provider: canonicalAddress(account), adapter: canonicalAddress(account) });

function accountCells(j: Journey, fx: AccountFixtures): Record<string, DappCellImpl> {
  const { dapp } = j;
  const toB = {
    recipientAddress: j.addressB,
    faucetId: j.tokenFaucetId,
    amount: tst(1).toString(),
    noteType: 'public' as const
  };
  const held = (key: string): HeldNote => {
    const note = fx.held[key];
    if (note === undefined) throw new HarnessFault(`no held note for ${key}`);
    return note;
  };
  const connectedView = async (ctx: CellContext): Promise<ConnectedView> => {
    const view = await callDapp(dapp, 'session', {}, ctx.deadline);
    if (view.connected === null) throw new HarnessFault('the dApp is not connected');
    return view.connected;
  };
  // K1's evidence, written only once the start state and the provider are checked, so its signature can match
  // nothing but an adapter left on the old address.
  const recordK1 = (ctx: CellContext, before: SessionView, after: SessionView) => {
    ctx.evidence.previousAddress = before.adapterAddress;
    ctx.evidence.providerAddress = after.providerAddress;
    ctx.evidence.adapterAddress = after.adapterAddress;
  };
  const kindOf = (request: StaleRequest) =>
    request === 'consume' || request === 'consumeBytes' ? ('consume' as const) : ('transaction' as const);

  // Through the adapter, as the dApp normally issues it.
  const viaAdapter = async (
    request: StaleRequest,
    note: HeldNote | undefined,
    ctx: CellContext
  ): Promise<Outcome<{ txId: string }>> => {
    if (request === 'send' || request === 'transaction') {
      return callDapp(
        dapp,
        'send',
        { ...toB, via: request === 'send' ? 'requestSend' : 'requestTransaction' },
        ctx.deadline
      );
    }
    if (request === 'custom') {
      const built = await callDapp(dapp, 'buildCustom', { shape: 'p2id', outputs: [toB] }, ctx.deadline);
      return callDapp(
        dapp,
        'submitCustom',
        { requestId: built.requestId, recipientAddress: j.addressB, importNotes: false },
        ctx.deadline
      );
    }
    return callDapp(
      dapp,
      'consume',
      {
        noteId: note?.noteId ?? '',
        faucetId: j.tokenFaucetId,
        amount: (note?.amount ?? 0n).toString(),
        noteType: 'public',
        via: 'requestConsume',
        ...(request === 'consumeBytes' ? { noteBytesB64: note?.bytesB64 ?? '' } : {})
      },
      ctx.deadline
    );
  };

  // Through the provider as account 1, while account 2 is current: the adapter cannot express this.
  const asStaleAccount = async (
    request: StaleRequest,
    me: ConnectedView,
    note: HeldNote | undefined,
    ctx: CellContext
  ): Promise<RawArg[]> => {
    const send: RawArg = {
      senderAddress: me.addressCanonical,
      recipientAddress: j.addressB,
      faucetId: j.tokenFaucetId,
      noteType: 'public',
      amount: Number(tst(1))
    };
    if (request === 'send') return [send];
    if (request === 'transaction') return [{ type: 'send', payload: send }];
    if (request === 'custom') {
      const built = await callDapp(dapp, 'buildCustom', { shape: 'p2id', outputs: [toB] }, ctx.deadline);
      return [
        {
          type: 'custom',
          payload: { address: me.addressCanonical, recipientAddress: j.addressB, transactionRequest: built.requestB64 }
        }
      ];
    }
    return [
      {
        faucetId: j.tokenFaucetId,
        noteId: note?.noteId ?? '',
        noteType: 'public',
        amount: Number(note?.amount ?? 0n),
        ...(request === 'consumeBytes' ? { noteBytes: note?.bytesB64 ?? '' } : {})
      }
    ];
  };
  const rawCallOf = (request: StaleRequest) =>
    request === 'send'
      ? 'requestSend'
      : request === 'consume' || request === 'consumeBytes'
        ? 'requestConsume'
        : 'requestTransaction';

  // Every account's rows, not the stale one's alone: a stale request run for the account now current is as wrong. A
  // consume of a third party's note is no request's doing, so it is left out.
  const rowsRunSince = async (since: readonly string[]) =>
    (await readTransactionRows(j.walletA.page)).filter(
      row => !since.includes(row.id) && !isForeignConsume(row, j.senders())
    );

  const staleCell = (request: StaleRequest, trigger: 'switch' | 'revoke'): DappCellImpl => ({
    budget: 'write',
    run: async ctx => {
      const primary = await j.account('primary');
      const second = await j.account('second');
      const note = request === 'consume' || request === 'consumeBytes' ? held(`M3-${request}-${trigger}`) : undefined;
      const baseline = await captureBaseline(await sideOf(j, dapp), [j.tokenFaucetId], ctx);
      const { result } = await answerPrompt(
        dapp,
        () => viaAdapter(request, note, ctx),
        {
          kind: kindOf(request),
          decision: 'approve',
          origin: dapp.origin,
          // The authorization goes stale while the popup is open, then the user approves.
          whileOpen: () =>
            trigger === 'switch' ? j.walletA.selectAccount(second) : revokeDappSession(j.walletA, dapp.origin)
        },
        ctx
      );
      await j.walletA.waitForQueueDrained(ctx.deadline.remainingMs());
      const ran = await rowsRunSince(baseline.rowIds);
      ctx.evidence.staleConsumeExecuted = result.ok && onlyStaleConsumesRan(ran, primary);
      expect(result).toEqual(NOT_GRANTED_WRAPPED);
      expect(ran.map(describeTransactionRow)).toEqual([]);
    }
  });

  const nonCurrentCell = (request: StaleRequest): DappCellImpl => ({
    budget: 'write',
    run: async ctx => {
      const primary = await j.account('primary');
      const second = await j.account('second');
      const me = await connectedView(ctx);
      const note = request === 'consume' || request === 'consumeBytes' ? held(`M9-${request}`) : undefined;
      const baseline = await captureBaseline(await sideOf(j, dapp), [j.tokenFaucetId], ctx);
      const args = await asStaleAccount(request, me, note, ctx);
      await j.walletA.selectAccount(second);
      // Q10: refused before any popup; if one opens anyway, approving it lets the request settle, so what then runs
      // for account 1 is seen too.
      const { result, prompted } = await answerIfPrompted(
        dapp,
        () => callDapp(dapp, 'raw', { call: rawCallOf(request), args, asAddress: me.address }, ctx.deadline),
        kindOf(request),
        ctx
      );
      ctx.evidence.nonCurrentPrompted = prompted;
      await j.walletA.waitForQueueDrained(ctx.deadline.remainingMs());
      const ran = await rowsRunSince(baseline.rowIds);
      // A refusal must leave no row that ran, for any account.
      ctx.evidence.nonCurrentRowRan = ran.length > 0;
      ctx.evidence.staleConsumeExecuted = result.ok && onlyStaleConsumesRan(ran, primary);
      expect({ prompted, result }).toEqual({ prompted: false, result: NOT_GRANTED_RAW });
      expect(ran.map(describeTransactionRow)).toEqual([]);
    }
  });

  return {
    S7: {
      budget: 'read',
      run: async ctx => {
        const primary = await j.account('primary');
        const before = await callDapp(dapp, 'session', {}, ctx.deadline);
        expect(sides(before)).toEqual(onBoth(primary));
        // The wallet-side revoke (main.ts:768-773); the provider learns it from its 10 s poll (client.ts:68-87).
        await revokeDappSession(j.walletA, dapp.origin);
        const after = await sessionWithin(dapp, view => view.providerAddress === null, 20_000, ctx);
        expect(after.providerAddress).toBeNull();
        recordK1(ctx, before, after);
        expect(after.adapterAddress).toBeNull();
        expect(
          after.events
            .slice(before.events.length)
            .filter(event => event.source === 'provider' && event.event === 'accountChange')
            .map(event => event.address)
        ).toEqual([null]);
      }
    },
    M1: {
      budget: 'read',
      run: async ctx => {
        const primary = await j.account('primary');
        const second = await j.account('second');
        // With a session on both accounts the provider's poll moves to the second account instead of to null.
        await j.walletA.selectAccount(second);
        const asSecond = await connectAsCurrent(dapp, j.network, ctx);
        expect(canonicalAddress(asSecond.address)).toBe(canonicalAddress(second));
        await j.walletA.selectAccount(primary);
        const asPrimary = await connectAsCurrent(dapp, j.network, ctx);
        expect(canonicalAddress(asPrimary.address)).toBe(canonicalAddress(primary));
        const before = await callDapp(dapp, 'session', {}, ctx.deadline);
        expect(sides(before)).toEqual(onBoth(primary));
        await j.walletA.selectAccount(second);
        const moved = await sessionWithin(dapp, view => sameAs(view.providerAddress, second), 20_000, ctx);
        expect(canonicalOrNull(moved.providerAddress)).toBe(canonicalAddress(second));
        recordK1(ctx, before, moved);
        expect(canonicalOrNull(moved.adapterAddress)).toBe(canonicalAddress(second));
        await j.walletA.selectAccount(primary);
        const back = await sessionWithin(dapp, view => sameAs(view.providerAddress, primary), 20_000, ctx);
        expect(sides(back)).toEqual(onBoth(primary));
      }
    },
    M2: {
      budget: 'write',
      run: async ctx => {
        const second = await j.account('second');
        await j.walletA.selectAccount(second);
        const connected = await connectAsCurrent(dapp, j.network, ctx);
        expect(canonicalAddress(connected.address)).toBe(canonicalAddress(second));
        await dappSendToTheEnd(
          j,
          dapp,
          { amount: tst(1), noteType: 'public', via: 'requestSend', slot: 'second' },
          ctx
        );
      }
    },
    ...Object.fromEntries(
      STALE.flatMap(request => [
        [`M3-${request}-switch`, staleCell(request, 'switch')],
        [`M3-${request}-revoke`, staleCell(request, 'revoke')]
      ])
    ),
    ...Object.fromEntries(STALE.map(request => [`M9-${request}`, nonCurrentCell(request)])),
    'M4-reads': {
      budget: 'read',
      run: async ctx => {
        const primary = await j.account('primary');
        const second = await j.account('second');
        const two = await j.dappTwo();
        // dApp one is bound to account 1 by the quiesce; dApp two binds to account 2.
        const oneAddress = (await connectedView(ctx)).address;
        await j.walletA.selectAccount(second);
        const twoAddress = (await connectAsCurrent(two, j.network, ctx)).address;
        // Before the vaults, so a third party's note consumed on either account later counts (spec section 5, step 7),
        // and each vault is read once the store holds a sync after it, so one consumed before is in it.
        const capturedAtSec = Math.floor(Date.now() / 1000);
        const since = { capturedAtSec, rowIds: (await readTransactionRows(j.walletA.page)).map(row => row.id) };
        const vaultOf = async (account: string) => {
          await j.walletA.selectAccount(account);
          return vaultSyncedAfter(j.walletA, dapp, capturedAtSec * 1000, ctx);
        };
        const ownOne = await vaultOf(primary);
        const ownTwo = await vaultOf(second);
        // Account 2 holds its 100 TST fixture, so the vaults differ and a read that leaked the other one would fail.
        expect(ownTwo).not.toEqual(ownOne);
        // Each dApp reads as its own account while the OTHER account is current, the address pinned through the
        // provider, whose poll clears it once its account is not current (client.ts:68-87). Q10: refused before any
        // popup with NOT_GRANTED; a read that still reaches a popup must serve the dApp's own vault, so anything else
        // after a popup (another account's vault, nothing) is a failure.
        const crossRead = async (
          handle: DappHandle,
          address: string,
          own: Record<string, string>
        ): Promise<NonCurrentRead> => {
          const { result, prompted } = await answerIfPrompted(
            handle,
            () => callDapp(handle, 'raw', { call: 'requestAssets', args: [], asAddress: address }, ctx.deadline),
            'assets',
            ctx
          );
          const assets: unknown =
            result.ok && typeof result.value === 'object' && result.value !== null
              ? Reflect.get(result.value, 'assets')
              : null;
          const served = Array.isArray(assets)
            ? assetMap(
                assets.map(asset => ({
                  faucetId: String(Reflect.get(Object(asset), 'faucetId')),
                  amount: String(Reflect.get(Object(asset), 'amount'))
                }))
              )
            : null;
          return { prompted, result, served, own };
        };
        await j.walletA.selectAccount(primary);
        const fromTwo = await crossRead(two, twoAddress, ownTwo);
        await j.walletA.selectAccount(second);
        const fromOne = await crossRead(dapp, oneAddress, ownOne);
        Object.assign(ctx.evidence, nonCurrentReadEvidence([fromTwo, fromOne]));
        const owner = (account: string) => ({ wallet: j.walletA, account, journeySenders: () => j.senders() });
        await unlessAThirdPartyMovedARead(owner(second), since, fromTwo, ownOne);
        await unlessAThirdPartyMovedARead(owner(primary), since, fromOne, ownTwo);
        const answer = ({ prompted, result }: NonCurrentRead) => ({ prompted, result });
        const refusedBeforePopup = { prompted: false, result: NOT_GRANTED_RAW };
        expect({ fromTwo: answer(fromTwo), fromOne: answer(fromOne) }).toEqual({
          fromTwo: refusedBeforePopup,
          fromOne: refusedBeforePopup
        });
      }
    },
    M4: {
      budget: 'long',
      run: async ctx => {
        const primary = await j.account('primary');
        const second = await j.account('second');
        const two = await j.dappTwo();
        // dApp one is bound to account 1 by the quiesce; dApp two binds to account 2 (a silent reconnect after
        // M4-reads, a prompt when run alone).
        await j.walletA.selectAccount(second);
        await connectAsCurrent(two, j.network, ctx);
        // M1 and M2 leave dApp one a session for account 2 as well, and its connect would then be answered at once
        // (dapp.ts:344-367). The wallet-side revoke removes only the current account's (actions.ts:809-814).
        await revokeDappSession(j.walletA, dapp.origin);
        expect((await dappSessionsFor(j.walletA, dapp.origin)).filter(id => sameAs(id, second))).toEqual([]);

        // One queue for every origin (actions.ts:98-102). Q10 lets only the current account's sessions prompt, so with
        // account 2 current the second origin's prompt is dApp one's connect: it holds no session for account 2, so the
        // wallet asks (dapp.ts:333-334). Its popup may open only after dApp two's send popup closes. It is declined,
        // which leaves dApp one's account-1 session as it was. Each send below first waits for its provider's poll
        // to restore the address it cleared while the other account was current (client.ts:68-87).
        const sideTwo = await sideOf(j, two, 'second');
        const baseTwo = await captureBaseline(sideTwo, [j.tokenFaucetId], ctx);
        await sessionWithin(two, view => sameAs(view.providerAddress, second), 20_000, ctx);
        const mark = j.confirmLog.events.length;
        const firstPopup = waitForConfirmPopup(dapp.context, 60_000);
        const sendTwo = callDapp(two, 'send', { ...toB, amount: tst(2).toString(), via: 'requestSend' }, ctx.deadline);
        // Handled at once so a rejection while the popups are worked is never unhandled; still awaited below.
        void sendTwo.catch(() => undefined);
        const popupTwo = await firstPopup;
        const secondPopup = waitForConfirmPopup(dapp.context, 120_000);
        void secondPopup.catch(() => undefined);
        const connectOne = callDapp(dapp, 'raw', { call: 'connect', args: ['UPON_REQUEST', j.network] }, ctx.deadline);
        void connectOne.catch(() => undefined);
        await popupTwo.getByTestId(CONFIRM_ACTIONS.transaction.approve).waitFor({ state: 'visible', timeout: 60_000 });
        expect(await popupTwo.getByTestId('confirm-request-origin').getAttribute('title')).toBe(two.origin);
        await popupBlock(two, ctx);
        await popupTwo.getByTestId(CONFIRM_ACTIONS.transaction.approve).click();
        const popupConnect = await secondPopup;
        await popupConnect.getByTestId(CONFIRM_ACTIONS.connect.decline).waitFor({ state: 'visible', timeout: 60_000 });
        expect(await popupConnect.getByTestId('connect-origin').getAttribute('title')).toBe(dapp.origin);
        await popupConnect.getByTestId(CONFIRM_ACTIONS.connect.decline).click();
        expect(await connectOne).toEqual(NOT_GRANTED_RAW);
        // A declined popup the wallet failed to close fails here, not later as a refused placement or a stray page.
        await ctx.deadline.race(waitForNoConfirmPages(dapp.context), 'declined connect popup closed');
        const txTwo = unwrap(await sendTwo, "dApp two's send", ctx).txId;
        expect(maxConcurrentConfirmPages(j.confirmLog.events.slice(mark))).toBe(1);

        // dApp one's write, with its own account current again.
        const sideOne = await sideOf(j, dapp, 'primary');
        const baseOne = await captureBaseline(sideOne, [j.tokenFaucetId], ctx);
        await sessionWithin(dapp, view => sameAs(view.providerAddress, primary), 20_000, ctx);
        const sentOne = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'send', { ...toB, via: 'requestSend' }, ctx.deadline),
          { kind: 'transaction', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const txOne = unwrap(sentOne.result, "dApp one's send", ctx).txId;

        const [writtenTwo] = await expectWritesToTheEnd(
          sideTwo,
          baseTwo,
          [{ txId: txTwo, outputNotes: [{ noteType: 'public' }], consumedNullifiers: [] }],
          { [j.tokenFaucetId]: -tst(2) },
          ctx
        );
        const [writtenOne] = await expectWritesToTheEnd(
          sideOne,
          baseOne,
          [{ txId: txOne, outputNotes: [{ noteType: 'public' }], consumedNullifiers: [] }],
          { [j.tokenFaucetId]: -tst(1) },
          ctx
        );
        // Both notes reach B; one claim takes both, so they are checked together.
        await expectReceivedByRecipient(
          j.walletB,
          [
            { noteId: writtenTwo?.outputNotes[0]?.noteId ?? '', faucetId: j.tokenFaucetId, amount: tst(2) },
            { noteId: writtenOne?.outputNotes[0]?.noteId ?? '', faucetId: j.tokenFaucetId, amount: tst(1) }
          ],
          ctx
        );
        j.memo.set('M4.txOne', txOne);

        await j.walletA.selectAccount(primary);
        await callDapp(dapp, 'disconnect', {}, ctx.deadline);
        await j.walletA.selectAccount(second);
        await sessionWithin(two, view => sameAs(view.providerAddress, second), 20_000, ctx);
        unwrap(
          await expectNoPrompt(two, () => callDapp(two, 'guardianInfo', {}, ctx.deadline), ctx),
          "dApp two's session survives dApp one's disconnect",
          ctx
        );
      }
    },
    M7: {
      budget: 'read',
      needs: ['M4'],
      run: async ctx => {
        const txId = j.memo.get('M4.txOne') ?? '';
        const two = await j.dappTwo();
        // Review Focus 5: dApp one still reads its own result, so a refusal below cannot be the 10-minute expiry.
        unwrap(
          await callDapp(dapp, 'waitForTransaction', { txId }, ctx.deadline),
          "dApp one's own waitForTransaction",
          ctx
        );
        const fromTwo = await callDapp(two, 'raw', { call: 'waitForTransaction', args: [txId] }, ctx.deadline);
        // dApp two's session is bound to account 2, and a disconnect removes only the current account's session
        // (dapp.ts:298-313), so account 2 is selected for it; afterwards origin two holds no session at all.
        await j.walletA.selectAccount(await j.account('second'));
        await callDapp(two, 'disconnect', {}, ctx.deadline);
        expect(await dappSessionsFor(j.walletA, two.origin)).toEqual([]);
        await j.walletA.selectAccount(await j.account('primary'));
        const fromDisconnected = await callDapp(two, 'raw', { call: 'waitForTransaction', args: [txId] }, ctx.deadline);
        const served = (answer: Outcome<RawArg>) =>
          answer.ok &&
          typeof answer.value === 'object' &&
          answer.value !== null &&
          Array.isArray(Reflect.get(answer.value, 'outputNotes'));
        ctx.evidence.crossOriginWaitServed = served(fromTwo) || served(fromDisconnected);
        for (const answer of [fromTwo, fromDisconnected]) {
          expect(JSON.stringify(answer)).not.toContain('Transaction result expired');
        }
        // Q8: neither gets the result or any note bytes, and each is refused as a missing id is (R6), so the answer
        // does not say whether the row exists or whose it is (#1416).
        expect({ fromTwo: served(fromTwo), fromDisconnected: served(fromDisconnected) }).toEqual({
          fromTwo: false,
          fromDisconnected: false
        });
        expect({ fromTwo, fromDisconnected }).toEqual({ fromTwo: NOT_GRANTED_RAW, fromDisconnected: NOT_GRANTED_RAW });
      }
    },
    'M8-single': {
      budget: 'write',
      state: { account: 'third' },
      run: async ctx => {
        // The quiesce switched to the single-sig account and reconnected; guardianInfo re-selected the builder.
        expect((await connectedView(ctx)).builder).toBe('plain');
        await customWriteToTheEnd(
          j,
          dapp,
          {
            slot: 'third',
            build: { shape: 'p2id', outputs: [toB] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: 3,
            vaultDelta: { [j.tokenFaucetId]: -tst(1) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^1 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    'M8-guardian': {
      budget: 'write',
      run: async ctx => {
        // Back from the single-sig account: the quiesce reselected the Guardian account and reconnected.
        expect((await connectedView(ctx)).builder).toBe('guardian-twin');
        await customWriteToTheEnd(
          j,
          dapp,
          {
            build: { shape: 'p2id', outputs: [toB] },
            submit: { recipientAddress: j.addressB, importNotes: false },
            advance: 3,
            vaultDelta: { [j.tokenFaucetId]: -tst(1) },
            toB: [true],
            consumedNullifiers: [],
            preview: { amount: /^1 TST$/, outputNotes: 1 }
          },
          ctx
        );
      }
    },
    M10: {
      budget: 'long',
      run: async ctx => {
        const note = held('M10');
        const side = await sideOf(j, dapp);
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const sent = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'send', { ...toB, via: 'requestSend' }, ctx.deadline),
          { kind: 'transaction', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const sendTx = unwrap(sent.result, 'requestSend', ctx).txId;
        // No settle between the two: on Guardian the consume meets the send's pending candidate
        // (transaction/index.ts:3171, 3233) and must requeue through it inside the 5-minute wait.
        const consumed = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'consume',
              {
                noteId: note.noteId,
                faucetId: j.tokenFaucetId,
                amount: note.amount.toString(),
                noteType: 'public',
                via: 'requestConsume'
              },
              ctx.deadline
            ),
          { kind: 'consume', decision: 'approve', origin: dapp.origin, whileOpen: () => popupBlock(dapp, ctx) },
          ctx
        );
        const consumeTx = unwrap(consumed.result, 'requestConsume', ctx).txId;
        await expectWritesToTheEnd(
          side,
          baseline,
          [
            {
              txId: sendTx,
              outputNotes: [
                { noteType: 'public', recipient: { wallet: j.walletB, faucetId: j.tokenFaucetId, amount: tst(1) } }
              ],
              consumedNullifiers: []
            },
            { txId: consumeTx, outputNotes: [], consumedNullifiers: [note.nullifierHex] }
          ],
          { [j.tokenFaucetId]: note.amount - tst(1) },
          ctx
        );
      }
    },
    N5: {
      budget: 'read',
      state: { session: 'auto' },
      run: async ctx => {
        const foreign = normalizeHex(fx.secondPrivateNoteId);
        const read = async <T>(start: () => Promise<Outcome<T>>, what: string) =>
          unwrap(await expectNoPrompt(dapp, start, ctx), what, ctx);
        const all = await read(
          () => callDapp(dapp, 'privateNotes', { filter: 'All' }, ctx.deadline),
          'requestPrivateNotes(All)'
        );
        expect(all.map(note => normalizeHex(note.noteId))).not.toContain(foreign);
        expect(
          await read(
            () => callDapp(dapp, 'privateNotes', { filter: 'List', noteIds: [fx.secondPrivateNoteId] }, ctx.deadline),
            'requestPrivateNotes(List)'
          )
        ).toEqual([]);
        const consumable = await read(
          () => callDapp(dapp, 'consumableNotes', {}, ctx.deadline),
          'requestConsumableNotes'
        );
        expect(consumable.map(note => normalizeHex(note.noteId))).not.toContain(foreign);
        // Account 2 holds 100 TST; a leak would show as a total above account 1's own vault.
        expect(assetMap(await read(() => callDapp(dapp, 'assets', {}, ctx.deadline), 'requestAssets'))).toEqual(
          await vaultAssetsOfCurrentAccount(j.walletA.page)
        );
      }
    }
  };
}

function defineAccountsJourney(axis: DappAxis): void {
  test(journeyTitle('M', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.M);
    const j = await startJourney({ journey: 'M', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    const fixtures: AccountFixtures = { held: {}, secondPrivateNoteId: '' };
    await steps
      .step('account_fixtures', async () => {
        const second = await fundAccount(j, 'second', tst(100));
        const primary = await j.account('primary');
        const keys = [
          'M3-consume-switch',
          'M3-consume-revoke',
          'M3-consumeBytes-switch',
          'M3-consumeBytes-revoke',
          'M9-consume',
          'M9-consumeBytes',
          'M10'
        ];
        for (const [index, key] of keys.entries()) {
          fixtures.held[key] = await mintHeldNote(j, primary, tst(1.1 + index / 10));
        }
        // N5: a private note only account 2 can consume. The CLI keeps a private mint in its own store and sends
        // nothing over the note transport, so wallet B sends it, which the wallet relays (complete.ts:105-140).
        const ctx = setupContext(300_000, "N5's private note to the second account");
        const fromB = await j.dappB();
        const { result } = await answerPrompt(
          fromB,
          () =>
            callDapp(
              fromB,
              'send',
              {
                recipientAddress: canonicalAddress(second),
                faucetId: j.tokenFaucetId,
                amount: tst(3).toString(),
                noteType: 'private',
                via: 'requestSend'
              },
              ctx.deadline
            ),
          { kind: 'transaction', decision: 'approve', origin: fromB.origin },
          ctx
        );
        const { txId } = unwrap(result, "B's private send to the second account", ctx);
        const sent = unwrap(await callDapp(fromB, 'waitForTransaction', { txId }, ctx.deadline), "B's send", ctx);
        const noteId = sent.outputNotes[0]?.noteId;
        if (noteId === undefined) throw new HarnessFault("B's private send returned no output note");
        await selectAccountIfNeeded(walletA, second);
        await pollUntil(
          () => pendingNote(walletA.page, noteId),
          note => note !== null,
          `N5 note ${noteId} discovered by the second account`,
          ctx
        );
        await selectAccountIfNeeded(walletA, primary);
        fixtures.secondPrivateNoteId = noteId;
        // M8 needs TST of its own on the single-sig account, on the leg that runs it. Funds a fixture, asserts nothing.
        if (cellIdsFor('M', axis.label).includes('M8-single')) await fundAccount(j, 'third', tst(20));
      })
      .catch((error: unknown) => {
        // Journey setup, so a public-faucet grant for the second account's fees writes INFRA_ABORT, and a node that
        // fails a held note's chain read records the cells blocked (infrastructure), not not-run.
        j.runner.setupFailed(error);
        throw error;
      });
    await runJourneyCells(j, accountCells(j, fixtures));
  });
}

for (const axis of dappAxes()) defineAccountsJourney(axis);

import { expect, test } from '../../fixtures/two-wallets';
import { captureBaseline, refusal } from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { HarnessFault, type CellContext } from '../../helpers/dapp-cells';
import { canonicalAddress } from '../../helpers/dapp-gates';
import { runJourneyCells, startJourney, tst, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { dappSendToTheEnd, fundAccount, mintHeldNote, sideOf, type HeldNote } from '../../helpers/dapp-writes';
import { describeTransactionRow, readTransactionRows } from '../../helpers/history';
import {
  answerIfPrompted,
  answerPrompt,
  callDapp,
  connectAsCurrent,
  revokeDappSession,
  sessionWithin
} from '../../helpers/test-dapp';
import type { ConnectedView, Outcome, RawArg, SessionView } from '../../test-dapp/protocol';

type StaleRequest = 'send' | 'transaction' | 'consume' | 'consumeBytes' | 'custom';
const STALE: readonly StaleRequest[] = ['send', 'transaction', 'consume', 'consumeBytes', 'custom'];
const NOT_GRANTED_WRAPPED = refusal('WalletTransactionError', 'NOT_GRANTED', 'NotGrantedMidenWalletError');
// M9 calls the provider directly, so the refusal reaches the dApp unwrapped: assertDappSendStillAuthorized throws
// NOT_GRANTED (dapp.ts:1670-1685) and createError names it (client.ts:300-317). Consume is held to the same answer
// (Q9); today it executes instead, which is K6. M9 expects it before any popup (Q10).
const NOT_GRANTED_RAW = refusal('NotGrantedMidenWalletError', 'NOT_GRANTED');

interface AccountFixtures {
  held: Record<string, HeldNote>;
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

  const rowsRunFor = async (account: string, since: readonly string[]) =>
    (await readTransactionRows(j.walletA.page)).filter(
      row => !since.includes(row.id) && sameAs(row.accountId ?? null, account)
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
      const ran = await rowsRunFor(primary, baseline.rowIds);
      ctx.evidence.staleConsumeExecuted = result.ok && ran.length > 0;
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
      // Q10: refused before any popup. Today the wallet prompts (K9); approving that popup lets the request settle,
      // so what then runs for account 1 is seen too (an executed consume is K6).
      const { result, prompted } = await answerIfPrompted(
        dapp,
        () => callDapp(dapp, 'raw', { call: rawCallOf(request), args, asAddress: me.address }, ctx.deadline),
        kindOf(request),
        ctx
      );
      ctx.evidence.nonCurrentPrompted = prompted;
      await j.walletA.waitForQueueDrained(ctx.deadline.remainingMs());
      const ran = await rowsRunFor(primary, baseline.rowIds);
      ctx.evidence.staleConsumeExecuted = result.ok && ran.length > 0;
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
    ...Object.fromEntries(STALE.map(request => [`M9-${request}`, nonCurrentCell(request)]))
  };
}

function defineAccountsJourney(axis: DappAxis): void {
  test(journeyTitle('M', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.M);
    const j = await startJourney({ journey: 'M', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    const held: Record<string, HeldNote> = {};
    await steps
      .step('account_fixtures', async () => {
        await fundAccount(j, 'second', tst(100));
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
        for (const [index, key] of keys.entries()) held[key] = await mintHeldNote(j, primary, tst(1.1 + index / 10));
      })
      .catch((error: unknown) => {
        // Journey setup, so a public-faucet grant for the second account's fees writes INFRA_ABORT, and a node that
        // fails a held note's chain read records the cells blocked (infrastructure), not not-run.
        j.runner.setupFailed(error);
        throw error;
      });
    await runJourneyCells(j, accountCells(j, { held }));
  });
}

for (const axis of dappAxes()) defineAccountsJourney(axis);

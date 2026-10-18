import { expect, test } from '../../fixtures/two-wallets';
import {
  captureBaseline,
  expectWritesToTheEnd,
  pollUntil,
  refusal,
  type WriteSide
} from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { deadlineIn, HarnessFault, type CellContext } from '../../helpers/dapp-cells';
import { canonicalAddress, latestSnapshot, settledMiden } from '../../helpers/dapp-gates';
import { runJourneyCells, startJourney, tst, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { sideOf } from '../../helpers/dapp-writes';
import {
  callReact,
  connectReact,
  loadReact,
  openReactDapp,
  resetReact,
  selectReact,
  waitForReact,
  type ReactDappQuery
} from '../../helpers/react-dapp';
import { recoverEcdsaPublicKey } from '../../helpers/signature-recovery';
import {
  answerPrompt,
  callDapp,
  dappSessionsFor,
  expectNoPrompt,
  popupBlock,
  revokeDappSession,
  unwrap,
  type DappHandle
} from '../../helpers/test-dapp';
import type { ReactPageView, ReactSnapshot, ReactTree } from '../../test-dapp/react-protocol';

// The wallet's named refusal (src/lib/adapter/midenWindowObject.ts:203-207); adapter-base's WalletError keeps the
// name Error (errors.js:1-8), and the adapter wraps it as WalletTransactionError.
const CREATE_ACCOUNT_REFUSED =
  'createAccount is not supported by the Miden wallet. No provider implements it and there is no wire message for it.';
// The provider polls its permission every 10 s (src/lib/adapter/client.ts:68-87): two polls to follow a change.
const FOLLOW_MS = 20_000;
// MidenProvider's client setup can start again (MidenFiSignerProvider.tsx:618-631): settled means unchanged this long.
const SETTLED_MS = 2_000;

const canonicalOrNull = (address: string | null | undefined): string | null =>
  typeof address === 'string' ? canonicalAddress(address) : null;
const sameAs = (address: string | null | undefined, account: string): boolean =>
  canonicalOrNull(address) === canonicalAddress(account);
const onErrors = (view: ReactPageView, tree: ReactTree) =>
  view.events.filter(event => event.tree === tree && event.source === 'onError');
// connectReact returns its last snapshot whether or not it shows the account, so a cell that goes on from a connect
// checks that it does.
const expectConnectedAs = (now: ReactSnapshot, account: string, what: string): void =>
  expect({ address: canonicalOrNull(now.address), connected: now.connected }, what).toEqual({
    address: canonicalAddress(account),
    connected: true
  });

function reactCells(j: Journey, react: DappHandle, query: ReactDappQuery): Record<string, DappCellImpl> {
  const toB = { recipientAddress: j.addressB, faucetId: j.tokenFaucetId, noteType: 'public' as const };
  const view = (ctx: CellContext) => callReact(react, 'view', {}, ctx.deadline);
  const snapshot = (current: ReactPageView, tree: ReactTree): ReactSnapshot => {
    const found = latestSnapshot(current, tree);
    if (found === undefined) throw new HarnessFault(`the ${tree} probe has not committed`);
    return found;
  };
  const reset = (session: 'keep' | 'none', ctx: CellContext) => resetReact(j.walletA, react, query, session, ctx);
  const connectWallet = async (account: string, ctx: CellContext): Promise<ReactSnapshot> => {
    await selectReact(react, 'wallet', ctx);
    const now = await connectReact(react, 'wallet', account, ctx);
    expectConnectedAs(now, account, 'useWallet() connected as the account');
    return now;
  };
  // K1's evidence at the React layer, written once the start state and the provider are checked, so its signature can
  // match nothing but a context left on the old account.
  const recordK1 = (ctx: CellContext, before: ReactSnapshot, after: ReactPageView) => {
    const now = snapshot(after, 'wallet');
    ctx.evidence.previousAddress = before.address;
    ctx.evidence.providerAddress = after.providerAddress;
    ctx.evidence.reactAddress = now.address;
    ctx.evidence.reactConnected = now.connected;
  };
  // MidenProvider starts its client once MidenFi connects; a cell waits for it to settle, ready or failed, so a second
  // setup racing the first (MidenFiSignerProvider.tsx:618-631) cannot run under the cell's own calls.
  const settledSigner = (ctx: CellContext) =>
    waitForReact(
      react,
      current => settledMiden(current, SETTLED_MS) !== null,
      Math.max(0, ctx.deadline.remainingMs() - 30_000),
      ctx
    );
  const sides = (current: ReactPageView) => {
    const wallet = snapshot(current, 'wallet');
    return {
      provider: canonicalOrNull(current.providerAddress),
      react: canonicalOrNull(wallet.address),
      connected: wallet.connected
    };
  };

  return {
    WP1: {
      budget: 'long',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('none', ctx);
        await selectReact(react, 'wallet', ctx);
        const { result } = await answerPrompt(
          react,
          () => callReact(react, 'connect', { tree: 'wallet' }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: react.origin },
          ctx
        );
        unwrap(result, 'useWallet().connect', ctx);
        const connected = await waitForReact(
          react,
          current => sameAs(latestSnapshot(current, 'wallet')?.address, primary),
          10_000,
          ctx
        );
        expect(sides(connected)).toEqual({
          provider: canonicalAddress(primary),
          react: canonicalAddress(primary),
          connected: true
        });
        // dApp one, connected to this account by the quiesce, reads the chain; the React page waits for its own write.
        const side: WriteSide = {
          ...(await sideOf(j, j.dapp)),
          waitForTransaction: (txId, c) => callReact(react, 'waitForTransaction', { txId }, c.deadline)
        };
        const baseline = await captureBaseline(side, [j.tokenFaucetId], ctx);
        const amount = tst(1);
        const sent = await answerPrompt(
          react,
          () => callReact(react, 'send', { ...toB, amount: amount.toString() }, ctx.deadline),
          { kind: 'transaction', decision: 'approve', origin: react.origin, whileOpen: () => popupBlock(j.dapp, ctx) },
          ctx
        );
        const { txId } = unwrap(sent.result, 'useWallet().requestSend', ctx);
        const [written] = await expectWritesToTheEnd(
          side,
          baseline,
          [
            {
              txId,
              outputNotes: [
                { noteType: 'public', recipient: { wallet: j.walletB, faucetId: j.tokenFaucetId, amount } }
              ],
              consumedNullifiers: []
            }
          ],
          { [j.tokenFaucetId]: -amount },
          ctx
        );
        expect(
          written?.outputNotes.map(note => note.script),
          'output note script'
        ).toEqual(['p2id']);
      }
    },
    WP2: {
      budget: 'write',
      run: async ctx => {
        const atRest = await reset('keep', ctx);
        // Under its own storage key WalletProvider selects nothing, whatever MidenFi selected beside it.
        expect(snapshot(atRest, 'wallet').selected).toBeNull();
        const result = await expectNoPrompt(
          j.dapp,
          () => callReact(react, 'connect', { tree: 'wallet' }, ctx.deadline),
          ctx,
          { refusal: true }
        );
        expect(result).toEqual({ ok: false, error: { name: 'WalletNotSelectedError', message: '' } });
        expect(onErrors(await view(ctx), 'wallet').map(event => event.event)).toEqual(['WalletNotSelectedError']);
      }
    },
    WP3: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        await connectWallet(primary, ctx);
        // The reload keeps localStorage, so WalletProvider starts from the stored name; this origin still holds a
        // session for the account, so its auto-connect must not prompt.
        const after = await expectNoPrompt(
          j.dapp,
          async () => {
            await loadReact(react, { ...query, autoConnect: true }, ctx.deadline);
            return waitForReact(react, current => latestSnapshot(current, 'wallet')?.connected === true, 30_000, ctx);
          },
          ctx
        );
        const wallet = after.snapshots.filter(entry => entry.tree === 'wallet');
        const connecting = wallet.findIndex(entry => entry.connecting);
        expect({
          ...sides(after),
          autoConnect: snapshot(after, 'wallet').autoConnect,
          wentConnecting: connecting >= 0,
          settledAfter: wallet.slice(connecting + 1).some(entry => entry.connected && !entry.connecting)
        }).toEqual({
          provider: canonicalAddress(primary),
          react: canonicalAddress(primary),
          connected: true,
          autoConnect: true,
          wentConnecting: true,
          settledAfter: true
        });
      }
    },
    WP4: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        await connectWallet(primary, ctx);
        // The stored name stays and the wallet forgets the session, so the auto-connect after the reload must ask.
        await revokeDappSession(j.walletA, react.origin);
        await answerPrompt(
          react,
          async () => {
            await loadReact(react, { ...query, autoConnect: true }, ctx.deadline);
            return waitForReact(
              react,
              current =>
                onErrors(current, 'wallet').length > 0 || latestSnapshot(current, 'wallet')?.connected === true,
              Math.max(0, ctx.deadline.remainingMs() - 10_000),
              ctx
            );
          },
          { kind: 'connect', decision: 'decline', origin: react.origin },
          ctx
        );
        const after = await waitForReact(react, current => current.storedNames.wallet === null, 5_000, ctx);
        expect({
          errors: onErrors(after, 'wallet').map(event => event.error),
          stored: after.storedNames.wallet,
          connected: snapshot(after, 'wallet').connected,
          pageErrors: after.pageErrors
        }).toEqual({
          errors: [
            expect.objectContaining({
              name: 'WalletConnectionError',
              message: 'NOT_GRANTED',
              causeName: 'NotGrantedMidenWalletError'
            })
          ],
          stored: null,
          connected: false,
          pageErrors: []
        });
      }
    },
    WP5: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        await connectWallet(primary, ctx);
        unwrap(await callReact(react, 'disconnect', { tree: 'wallet' }, ctx.deadline), 'useWallet().disconnect', ctx);
        const after = await waitForReact(
          react,
          current => latestSnapshot(current, 'wallet')?.connected === false,
          5_000,
          ctx
        );
        const now = snapshot(after, 'wallet');
        expect({
          connected: now.connected,
          address: now.address,
          requestFunctions: now.requestFunctions,
          stored: after.storedNames.wallet
        }).toEqual({ connected: false, address: null, requestFunctions: [], stored: null });
        // The wallet removes the session (dapp.ts:289-304); read until the store shows it, within the cell.
        const sessions = await pollUntil(
          () => dappSessionsFor(j.walletA, react.origin),
          ids => !ids.some(id => sameAs(id, primary)),
          'the wallet session removed',
          ctx
        );
        expect(sessions.filter(id => sameAs(id, primary))).toEqual([]);
      }
    },
    WP6: {
      budget: 'write',
      run: async ctx => {
        await reset('keep', ctx);
        const selected = await selectReact(react, 'wallet', ctx);
        // Selected, never connected: the context offers requestSend and must refuse it itself.
        expect({
          connected: selected.connected,
          offersSend: selected.requestFunctions.includes('requestSend')
        }).toEqual({
          connected: false,
          offersSend: true
        });
        const mark = (await view(ctx)).events.length;
        const result = await expectNoPrompt(
          j.dapp,
          () => callReact(react, 'send', { ...toB, amount: tst(1).toString() }, ctx.deadline),
          ctx,
          { refusal: true }
        );
        expect(result).toEqual({ ok: false, error: { name: 'WalletNotConnectedError', message: '' } });
        const since = (await view(ctx)).events.slice(mark).filter(event => event.tree === 'wallet');
        expect(since.map(event => `${event.source}:${event.event}`)).toEqual(['onError:WalletNotConnectedError']);
      }
    },
    'WP7-switch': {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        const second = await j.account('second');
        await reset('keep', ctx);
        await selectReact(react, 'wallet', ctx);
        // A session on both accounts, so the provider's poll moves to the second account instead of to null.
        await j.walletA.selectAccount(second);
        expectConnectedAs(
          await connectReact(react, 'wallet', second, ctx),
          second,
          'useWallet() connected as the second account'
        );
        await j.walletA.selectAccount(primary);
        await connectReact(react, 'wallet', primary, ctx);
        const beforeView = await view(ctx);
        expect(sides(beforeView)).toEqual({
          provider: canonicalAddress(primary),
          react: canonicalAddress(primary),
          connected: true
        });
        await j.walletA.selectAccount(second);
        const after = await waitForReact(
          react,
          current =>
            sameAs(current.providerAddress, second) && sameAs(latestSnapshot(current, 'wallet')?.address, second),
          FOLLOW_MS,
          ctx
        );
        expect(canonicalOrNull(after.providerAddress)).toBe(canonicalAddress(second));
        recordK1(ctx, snapshot(beforeView, 'wallet'), after);
        expect(sides(after)).toEqual({
          provider: canonicalAddress(second),
          react: canonicalAddress(second),
          connected: true
        });
      }
    },
    'WP7-revoke': {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        await connectWallet(primary, ctx);
        const beforeView = await view(ctx);
        expect(sides(beforeView)).toEqual({
          provider: canonicalAddress(primary),
          react: canonicalAddress(primary),
          connected: true
        });
        // The wallet-side revoke (src/lib/miden/back/main.ts:769-774); the provider's poll clears its account.
        await revokeDappSession(j.walletA, react.origin);
        const after = await waitForReact(
          react,
          current => current.providerAddress === null && latestSnapshot(current, 'wallet')?.connected === false,
          FOLLOW_MS,
          ctx
        );
        expect(after.providerAddress).toBeNull();
        recordK1(ctx, snapshot(beforeView, 'wallet'), after);
        expect(sides(after)).toEqual({ provider: null, react: null, connected: false });
      }
    },
    WP8: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        const second = await j.account('second');
        await reset('keep', ctx);
        await connectWallet(primary, ctx);
        await j.walletA.selectAccount(second);
        // A second connect re-drives the adapter, which takes the wallet's current account (web-sdk #470); the wallet
        // asks only when this origin holds no session for that account.
        const now = await connectReact(react, 'wallet', second, ctx);
        expectConnectedAs(now, second, 'useWallet() after a second connect');
      }
    },
    WP9: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        const now = await connectWallet(primary, ctx);
        const exported = now.exported ?? { connected: null, address: null };
        ctx.evidence.reactConnected = now.connected;
        ctx.evidence.reactExportedConnected = exported.connected;
        expect({ connected: exported.connected, address: canonicalOrNull(exported.address) }).toEqual({
          connected: true,
          address: canonicalAddress(primary)
        });
      }
    },
    MF1: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        const atRest = await reset('none', ctx);
        // One wallet listed: MidenFi selects it on load, before any call (MidenFiSignerProvider.tsx:352-357).
        expect({ selected: snapshot(atRest, 'midenfi').selected, stored: atRest.storedNames.midenfi }).toEqual({
          selected: atRest.adapterName,
          stored: atRest.adapterName
        });
        const { result } = await answerPrompt(
          react,
          () => callReact(react, 'connect', { tree: 'midenfi' }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: react.origin },
          ctx
        );
        unwrap(result, 'useMidenFiWallet().connect', ctx);
        const after = await waitForReact(
          react,
          current => sameAs(latestSnapshot(current, 'midenfi')?.address, primary),
          10_000,
          ctx
        );
        expectConnectedAs(snapshot(after, 'midenfi'), primary, 'useMidenFiWallet() connected as the account');
      }
    },
    MF2: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        expectConnectedAs(
          await connectReact(react, 'midenfi', primary, ctx),
          primary,
          'MidenFi connected as the current account'
        );
        await settledSigner(ctx);
        const result = await expectNoPrompt(j.dapp, () => callReact(react, 'createAccount', {}, ctx.deadline), ctx, {
          refusal: true
        });
        expect(result).toEqual(refusal('WalletTransactionError', CREATE_ACCOUNT_REFUSED, 'Error'));
      }
    },
    MF3: {
      budget: 'long',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        // The height the dApp's own client sees now: MidenProvider's client must reach at least this one.
        const { height: before } = await callDapp(j.dapp, 'syncHeight', {}, ctx.deadline);
        const connected = await connectReact(react, 'midenfi', primary, ctx);
        expectConnectedAs(connected, primary, 'MidenFi connected as the current account');
        const settled = await settledSigner(ctx);
        const miden = settledMiden(settled, SETTLED_MS) ?? snapshot(settled, 'midenfi').miden ?? null;
        ctx.evidence.signerInitError = miden?.error ?? undefined;
        // The node answers here, so a signer that did not start is not the network's failure.
        await callDapp(j.dapp, 'syncHeight', {}, ctx.deadline);
        expect({
          ready: miden?.isReady ?? false,
          error: miden?.error ?? null,
          account: miden?.signerAccountId ?? null
        }).toEqual({ ready: true, error: null, account: connected.address });
        const { height } = await callReact(react, 'signerSync', {}, ctx.deadline);
        expect(height).toBeGreaterThanOrEqual(before);
      }
    },
    MF4: {
      budget: 'write',
      run: async ctx => {
        const primary = await j.account('primary');
        await reset('keep', ctx);
        const connected = await connectReact(react, 'midenfi', primary, ctx);
        expectConnectedAs(connected, primary, 'MidenFi connected as the current account');
        const settled = await settledSigner(ctx);
        // MidenFi builds its signer context once the connect is committed (MidenFiSignerProvider.tsx:669-736).
        expect(snapshot(settled, 'midenfi').signer?.isConnected).toBe(true);
        const { result } = await answerPrompt(
          react,
          () => callReact(react, 'signerSign', { felts: ['1', '2', '3'] }, ctx.deadline),
          { kind: 'sign', decision: 'approve', origin: react.origin },
          ctx
        );
        // Q2: a Guardian account signs with its hot key, so both kinds expect the same verifiable signature.
        const signed = unwrap(result, 'MidenFi signCb', ctx);
        const verified = await callDapp(
          j.dapp,
          'verifySignature',
          {
            kind: 'signingInputs',
            payloadB64: signed.payloadB64,
            signatureB64: signed.signatureB64,
            publicKeyB64: recoverEcdsaPublicKey(signed.signatureB64, signed.messageB64)
          },
          ctx.deadline
        );
        // A connect key that is not a Word leaves publicKeyHex null; its reason shows here rather than a bare null.
        expect({ ...verified, keyError: connected.publicKeyError ?? null }).toEqual({
          verifies: true,
          commitmentHex: connected.publicKeyHex,
          keyError: null
        });
      }
    }
  };
}

function defineReactJourney(axis: DappAxis): void {
  test(journeyTitle('RA', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.RA);
    const j = await startJourney({ journey: 'RA', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    const query: ReactDappQuery = {
      network: j.network,
      rpcUrl: j.env.rpcUrl,
      feeFaucetId: j.nativeFaucetId,
      autoConnect: false
    };
    let react: DappHandle;
    try {
      // WP7 and WP8 switch to it; created here, so no cell spends its budget on an account.
      await j.account('second');
      react = await openReactDapp(walletA.page.context(), query, deadlineIn(180_000, 'React dApp open'));
    } catch (error) {
      j.runner.setupFailed(error);
      throw error;
    }
    await runJourneyCells(j, reactCells(j, react, query));
  });
}

for (const axis of dappAxes()) defineReactJourney(axis);

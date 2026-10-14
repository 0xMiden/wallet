import { expect, test } from '../../fixtures/two-wallets';
import { vaultAssetsOfCurrentAccount } from '../../helpers/balance-truth';
import { refusal } from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { assetMap, canonicalAddress } from '../../helpers/dapp-gates';
import {
  ASSETS_AND_NOTES,
  runJourneyCells,
  startJourney,
  tst,
  type DappCellImpl,
  type Journey
} from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { dappSendToTheEnd } from '../../helpers/dapp-writes';
import { answerPrompt, callDapp, expectNoPrompt, reloadDapp, unwrap } from '../../helpers/test-dapp';

function sessionCells(j: Journey): Record<string, DappCellImpl> {
  const { dapp } = j;
  return {
    S1: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        expect(await callDapp(dapp, 'detect', { timeoutMs: 10_000 }, ctx.deadline)).toEqual({
          readyState: 'Installed',
          isAvailable: true
        });
      }
    },
    S2: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const connected = unwrap(result, 'connect', ctx);
        expect(canonicalAddress(connected.address)).toBe(canonicalAddress(await j.account('primary')));
        expect(connected.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
        expect(connected.builder).toBe(j.axis.expected.builder);
        expect(await j.axis.connectKeyMembership(j.walletA, await j.account('primary'), connected.publicKeyHex)).toBe(
          j.axis.expected.connectKeyMembership
        );
      }
    },
    S3: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          { kind: 'connect', decision: 'decline', origin: dapp.origin },
          ctx
        );
        expect(result).toEqual(refusal('WalletConnectionError', 'NOT_GRANTED', 'NotGrantedMidenWalletError'));
        expect((await callDapp(dapp, 'session', {}, ctx.deadline)).providerAddress).toBeNull();
      }
    },
    S4: {
      budget: 'read',
      run: async ctx => {
        await reloadDapp(dapp, j.init('A-one'), ctx.deadline);
        const result = await expectNoPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          ctx
        );
        expect(canonicalAddress(unwrap(result, 'silent reconnect', ctx).address)).toBe(
          canonicalAddress(await j.account('primary'))
        );
      }
    },
    S5: {
      budget: 'read',
      run: async ctx => {
        await j.walletA.lockWallet();
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          // An existing permission confirms itself once the popup is unlocked (ConfirmPage.tsx:501-506).
          { kind: 'connect', decision: 'auto-after-unlock', origin: dapp.origin, unlockFirst: true },
          ctx
        );
        expect(canonicalAddress(unwrap(result, 'reconnect through the lock', ctx).address)).toBe(
          canonicalAddress(await j.account('primary'))
        );
      }
    },
    S6: {
      budget: 'read',
      run: async ctx => {
        const before = await callDapp(dapp, 'session', {}, ctx.deadline);
        const old = before.adapterAddress ?? '';
        expect(old).not.toBe('');
        expect(await callDapp(dapp, 'disconnect', {}, ctx.deadline)).toEqual({ adapterAddress: null });
        const after = await callDapp(dapp, 'session', {}, ctx.deadline);
        expect(after.events.slice(before.events.length).map(event => `${event.source}:${event.event}`)).toContain(
          'adapter:disconnect'
        );
        const send = {
          senderAddress: canonicalAddress(old),
          recipientAddress: j.addressB,
          faucetId: j.tokenFaucetId,
          noteType: 'public',
          amount: Number(tst(1))
        };
        // Through the provider with the old address: the adapter would refuse client-side once disconnected.
        const stale = await expectNoPrompt(
          dapp,
          () => callDapp(dapp, 'raw', { call: 'requestSend', args: [send], asAddress: old }, ctx.deadline),
          ctx,
          { refusal: true }
        );
        expect(stale).toEqual(refusal('NotGrantedMidenWalletError', 'NOT_GRANTED'));
        const again = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: dapp.origin },
          ctx
        );
        unwrap(again.result, 'connect after disconnect prompts again', ctx);
      }
    },
    S8: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () =>
            callDapp(
              dapp,
              'connect',
              { permission: 'Auto', network: j.network, allowedPrivateData: ASSETS_AND_NOTES },
              ctx.deadline
            ),
          { kind: 'connect', decision: 'approve', origin: dapp.origin, tickPrivateData: true },
          ctx
        );
        expect(unwrap(result, 'Auto connect', ctx).privateDataPermission).toBe('AUTO');
        unwrap(
          await expectNoPrompt(dapp, () => callDapp(dapp, 'assets', {}, ctx.deadline), ctx),
          'assets under Auto',
          ctx
        );
        unwrap(
          await expectNoPrompt(dapp, () => callDapp(dapp, 'consumableNotes', {}, ctx.deadline), ctx),
          'notes under Auto',
          ctx
        );
      }
    },
    S9: {
      budget: 'write',
      run: async ctx => {
        // Q1: a locked wallet opens the popup on Unlock and continues (ConfirmPage.tsx:49-70).
        await j.walletA.lockWallet();
        const read = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'assets', {}, ctx.deadline),
          { kind: 'assets', decision: 'approve', origin: dapp.origin, unlockFirst: true },
          ctx
        );
        unwrap(read.result, 'requestAssets while locked', ctx);
        await dappSendToTheEnd(
          j,
          dapp,
          { amount: tst(1), noteType: 'public', via: 'requestSend', beforeRequest: () => j.walletA.lockWallet() },
          ctx,
          { unlockFirst: true }
        );
      }
    },
    S10: {
      budget: 'read',
      run: async ctx => {
        expect(unwrap(await callDapp(dapp, 'guardianInfo', {}, ctx.deadline), 'requestGuardianInfo', ctx)).toEqual(
          j.axis.expected.guardianInfo(j.env)
        );
      }
    },
    S11: {
      budget: 'read',
      state: { session: 'auto' },
      run: async ctx => {
        const result = await callDapp(dapp, 'conformance', {}, ctx.deadline);
        expect(result.failed).toEqual([]);
        expect(result.passed.length).toBeGreaterThanOrEqual(13);
      }
    },
    S14: {
      budget: 'read',
      state: { session: 'none' },
      run: async ctx => {
        const first = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'connect', { permission: 'UponRequest', network: j.network }, ctx.deadline),
          { kind: 'connect', decision: 'approve', origin: dapp.origin },
          ctx
        );
        const granted = unwrap(first.result, 'first connect', ctx);
        const escalated = unwrap(
          await expectNoPrompt(
            dapp,
            () =>
              callDapp(
                dapp,
                'connect',
                { permission: 'Auto', network: j.network, allowedPrivateData: ASSETS_AND_NOTES },
                ctx.deadline
              ),
            ctx
          ),
          'reconnect asking for more',
          ctx
        );
        expect({ permission: escalated.privateDataPermission, allowed: escalated.allowedPrivateData }).toEqual({
          permission: 'UPON_REQUEST',
          allowed: granted.allowedPrivateData
        });
        const read = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'assets', {}, ctx.deadline),
          { kind: 'assets', decision: 'approve', origin: dapp.origin },
          ctx
        );
        unwrap(read.result, 'requestAssets still prompts', ctx);
      }
    },
    N1: {
      budget: 'read',
      run: async ctx => {
        const { result } = await answerPrompt(
          dapp,
          () => callDapp(dapp, 'assets', {}, ctx.deadline),
          { kind: 'assets', decision: 'approve', origin: dapp.origin },
          ctx
        );
        expect(assetMap(unwrap(result, 'requestAssets', ctx))).toEqual(
          await vaultAssetsOfCurrentAccount(j.walletA.page)
        );
      }
    }
  };
}

function defineSessionJourney(axis: DappAxis): void {
  test(journeyTitle('S', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.S);
    const j = await startJourney({ journey: 'S', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    await runJourneyCells(j, sessionCells(j));
  });
}

for (const axis of dappAxes()) defineSessionJourney(axis);

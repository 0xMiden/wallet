import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/two-wallets';
import { refusal } from '../../helpers/dapp-assertions';
import { dappAxes, type DappAxis } from '../../helpers/dapp-axis';
import { HarnessFault, type CellContext } from '../../helpers/dapp-cells';
import { runJourneyCells, startJourney, tst, type DappCellImpl, type Journey } from '../../helpers/dapp-journey';
import { JOURNEY_TIMEOUT_MS, journeyTitle } from '../../helpers/dapp-matrix';
import { ECDSA_SCHEME_TAG, recoverEcdsaPublicKey } from '../../helpers/signature-recovery';
import { answerPrompt, bytesArg, callDapp, expectNoPrompt, unwrap } from '../../helpers/test-dapp';
import type { ConnectedView } from '../../test-dapp/protocol';

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

function defineRefusalsJourney(axis: DappAxis): void {
  test(journeyTitle('R', axis.label), async ({ walletA, walletB, midenCli, envConfig, steps }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS.R);
    const j = await startJourney({ journey: 'R', axis, walletA, walletB, midenCli, envConfig, steps, testInfo });
    await runJourneyCells(j, signingCells(j));
  });
}

for (const axis of dappAxes()) defineRefusalsJourney(axis);

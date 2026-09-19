import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  CONFIRM_TESTID,
  clickConfirmAction,
  openFixtureDapp,
  waitForConfirmForm,
  waitForConfirmPopup
} from '../helpers/dapp-confirm';
import { readTransactionRows } from '../helpers/history';

const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
const MINT_BASE_UNITS = 100_000_000_000n;
const toBaseUnits = (amount: number): string => (BigInt(amount) * 10n ** BigInt(TOKEN_DECIMALS)).toString();

type InjectedProvider = {
  address?: string;
  connect(privateDataPermission: string, network: string): Promise<void>;
  requestSend(transaction: {
    senderAddress: string;
    recipientAddress: string;
    faucetId: string;
    noteType: string;
    amount: number;
  }): Promise<{ transactionId?: string }>;
};

type RequestOutcome = { ok: boolean; message: string; transactionId: string };

const connectDapp = async (page: Page, context: BrowserContext, network: string): Promise<string> => {
  const popupPromise = waitForConfirmPopup(context);
  const connect = page.evaluate(async requestedNetwork => {
    const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
    await provider.connect('UPON_REQUEST', requestedNetwork);
    return provider.address ?? '';
  }, network);
  const popup = await waitForConfirmForm(await popupPromise, CONFIRM_TESTID.connectApprove);
  await clickConfirmAction(popup, CONFIRM_TESTID.connectApprove);
  return connect;
};

const requestDappSend = async (
  page: Page,
  transaction: Parameters<InjectedProvider['requestSend']>[0]
): Promise<RequestOutcome> =>
  page.evaluate(async request => {
    const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
    try {
      const response = await provider.requestSend(request);
      return { ok: true, message: '', transactionId: response.transactionId ?? '' };
    } catch (error) {
      const rejected = error as { message?: unknown };
      const message = typeof rejected?.message === 'string' ? rejected.message : JSON.stringify(error);
      return { ok: false, message, transactionId: '' };
    }
  }, transaction);

const sendRows = async (page: Page) => (await readTransactionRows(page)).filter(row => row.type === 'send');

test.describe('Spending limits', () => {
  test.describe.configure({ mode: 'serial' });

  test('enforces wallet and dApp sends atomically with exact one-time authentication', async ({
    walletA,
    walletB,
    midenCli,
    envConfig,
    steps
  }, testInfo) => {
    test.setTimeout(1_200_000);
    let addressA = '';
    let addressB = '';
    let cliFaucetId = '';
    let faucetId = '';

    await steps.step('create_and_fund_wallets', async () => {
      addressA = (await walletA.createNewWallet()).address;
      addressB = (await walletB.createNewWallet()).address;
      await midenCli.init();
      cliFaucetId = await midenCli.createFaucet();
      await midenCli.mint(cliFaucetId, addressA, Number(MINT_BASE_UNITS), 'public');
      await midenCli.sync();
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

    await steps.step('wallet_send_below_limit', async () => {
      const configured = await walletA.configureSpendingLimitForTest({
        tokenSymbol: TOKEN,
        dailyLimitBaseUnits: toBaseUnits(500)
      });
      faucetId = configured.faucetId;
      const before = await sendRows(walletA.page);
      await walletA.sendTokens({
        recipientAddress: addressB,
        amount: '400',
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      await expect.poll(() => sendRows(walletA.page).then(rows => rows.length)).toBe(before.length + 1);
    });

    await steps.step('wallet_send_over_limit_requires_exact_authentication', async () => {
      const before = await sendRows(walletA.page);
      await walletA.prepareSendReview({
        recipientAddress: addressB,
        amount: '200',
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      await walletA.submitSendReview();
      await expect(walletA.page.getByText('Spending limit exceeded')).toBeVisible();
      await expect(walletA.page.getByText('To raise the limit, go to Settings > Spending limits.')).toBeVisible();
      await walletA.page.screenshot({
        path: testInfo.outputPath('spending-limit-challenge-desktop.png'),
        animations: 'disabled'
      });
      await expect.poll(() => sendRows(walletA.page).then(rows => rows.length)).toBe(before.length);
      await walletA.cancelSpendingLimitChallenge();

      await walletA.submitSendReview();
      await walletA.authenticateSpendingLimitForTest();
      await walletA.waitForSendSubmissionAccepted();
      await expect.poll(() => sendRows(walletA.page).then(rows => rows.length)).toBe(before.length + 1);
      const matching = (await sendRows(walletA.page)).filter(
        row => row.amount === toBaseUnits(200) && row.secondaryAccountId === addressB
      );
      expect(matching).toHaveLength(1);
    });

    const dapp = await openFixtureDapp(walletA.page.context());
    const network = envConfig.name === 'localhost' ? 'localnet' : envConfig.name;
    expect(await connectDapp(dapp, walletA.page.context(), network)).toBe(addressA);

    await steps.step('dapp_send_over_limit_requires_wallet_owned_authentication', async () => {
      const before = await sendRows(walletA.page);
      const popupPromise = waitForConfirmPopup(walletA.page.context());
      const send = requestDappSend(dapp, {
        senderAddress: addressA,
        recipientAddress: addressB,
        faucetId,
        noteType: 'public',
        amount: Number(toBaseUnits(1))
      });
      const popup = await waitForConfirmForm(await popupPromise, CONFIRM_TESTID.transactionApprove);
      await clickConfirmAction(popup, CONFIRM_TESTID.transactionApprove);
      await expect(popup.getByText('Spending limit exceeded')).toBeVisible();
      await expect.poll(() => sendRows(walletA.page).then(rows => rows.length)).toBe(before.length);
      await popup.locator('[data-slot="drawer-content"]').getByRole('button', { name: 'Cancel' }).click();
      const outcome = await send;
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toBe('NOT_GRANTED');
    });

    await steps.step('concurrent_outgoing_sends_cannot_both_cross_the_limit', async () => {
      await walletA.configureSpendingLimitForTest({
        tokenSymbol: TOKEN,
        dailyLimitBaseUnits: toBaseUnits(700)
      });
      const before = await sendRows(walletA.page);
      const result = await walletA.runSpendingLimitRaceForTest({
        recipientAddress: addressB,
        faucetId,
        amountBaseUnits: toBaseUnits(60)
      });

      expect(result).toEqual({
        fulfilledCount: 1,
        rejectedCount: 1,
        insertedCount: 1,
        rejectionCodes: ['SPENDING_LIMIT_AUTHORIZATION_REQUIRED']
      });
      await expect.poll(() => sendRows(walletA.page).then(rows => rows.length)).toBe(before.length);
    });

    await steps.step('spending_limit_settings_render_configured_policy', async () => {
      await walletA.page.bringToFront();
      await walletA.navigateTo('/settings/spending-limits');
      const settings = walletA.page.getByTestId('spending-limits-settings');
      await expect(settings).toBeVisible();
      await expect(walletA.page.getByRole('heading', { name: TOKEN, exact: true })).toBeVisible();
      const configuredDailyLimit = walletA.page.getByRole('textbox', {
        name: `${TOKEN} Rolling 24-hour limit`
      });
      await expect(configuredDailyLimit).toHaveValue('700');
      await expect
        .poll(async () => {
          const box = await settings.boundingBox();
          const width = walletA.page.viewportSize()?.width ?? 0;
          return box !== null && box.x >= 0 && box.x + box.width <= width;
        })
        .toBe(true);
      await configuredDailyLimit.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await walletA.page.screenshot({ path: testInfo.outputPath('spending-limit-settings-desktop.png') });
    });
  });
});

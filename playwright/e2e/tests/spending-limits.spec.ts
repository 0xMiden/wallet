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
import { describeTransactionRow, readTransactionRows } from '../helpers/history';
import { authenticateSpendingLimitChallenge, SPENDING_LIMIT_CHALLENGE } from '../helpers/wallet-page';

const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
const MINT_BASE_UNITS = 100_000_000_000n;
const toBaseUnits = (amount: number): string => (BigInt(amount) * 10n ** BigInt(TOKEN_DECIMALS)).toString();

type CustomTransactionPayload = {
  address: string;
  transactionRequest: string;
  recipientAddress: string;
};

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
  requestTransaction(transaction: {
    type: string;
    payload: CustomTransactionPayload;
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

const requestDappCustom = async (page: Page, payload: CustomTransactionPayload): Promise<RequestOutcome> =>
  page.evaluate(async request => {
    const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
    try {
      const response = await provider.requestTransaction({ type: 'custom', payload: request });
      return { ok: true, message: '', transactionId: response.transactionId ?? '' };
    } catch (error) {
      const rejected = error as { message?: unknown };
      const message = typeof rejected?.message === 'string' ? rejected.message : JSON.stringify(error);
      return { ok: false, message, transactionId: '' };
    }
  }, payload);

const sendRows = async (page: Page) => (await readTransactionRows(page)).filter(row => row.type === 'send');

/** A dApp custom request queues an `execute` row, not a `send` one. */
const executeRows = async (page: Page) => (await readTransactionRows(page)).filter(row => row.type === 'execute');

/**
 * Whether the row the dApp's own `transactionId` names is queued, as a STRING rather than a
 * boolean, so a failure prints what the read actually saw instead of `false`.
 *
 * Keyed on the id rather than on a row count: a count says nothing about WHICH row it counted, and
 * when the read comes back empty it cannot tell "the request queued nothing" apart from "this page
 * could not read the table" - two failures that need opposite fixes.
 */
const queuedCustomRow = async (page: Page, transactionId: string): Promise<string> => {
  const rows = await readTransactionRows(page);
  if (rows.some(row => row.id === transactionId && row.type === 'execute')) return 'queued';
  const execute = rows.filter(row => row.type === 'execute').map(describeTransactionRow);
  return `absent (${rows.length} rows, ${execute.length} execute: ${execute.join(' | ') || 'none'})`;
};

/**
 * The execute rows added since `before`, plus whether a row known to exist is still readable - so
 * an empty read fails this assertion instead of passing it vacuously.
 */
const addedCustomRows = async (page: Page, before: Set<string>, mustStillSee: string): Promise<string> => {
  const rows = await readTransactionRows(page);
  const added = rows.filter(row => row.type === 'execute' && !before.has(row.id));
  const anchor = rows.some(row => row.id === mustStillSee) ? 'anchor present' : 'ANCHOR MISSING';
  return `${added.map(describeTransactionRow).join(' | ') || 'none added'}; ${anchor}`;
};

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
    // The within-limit custom row's id, reused below as the anchor that proves a later read of the
    // table is live rather than empty.
    let withinLimitTxId = '';

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
      await popup.locator(SPENDING_LIMIT_CHALLENGE).getByRole('button', { name: 'Cancel' }).click();
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

    // 600 TST is spent against a 700 limit when these three steps start: the race step's rows are
    // rolled back by its own hook, so the only value in the window is the 400 + 200 sent above.
    await steps.step('dapp_custom_within_limit_is_approved_and_counted', async () => {
      const transactionRequest = await walletA.buildCustomTransactionRequestForTest({
        recipientAddress: addressB,
        faucetId,
        amountBaseUnits: toBaseUnits(50)
      });
      const popupPromise = waitForConfirmPopup(walletA.page.context());
      const request = requestDappCustom(dapp, {
        address: addressA,
        transactionRequest,
        recipientAddress: addressB
      });
      const popup = await waitForConfirmForm(await popupPromise, CONFIRM_TESTID.transactionApprove);
      await clickConfirmAction(popup, CONFIRM_TESTID.transactionApprove);

      const outcome = await request;
      expect(outcome.ok).toBe(true);
      expect(outcome.transactionId).not.toBe('');
      withinLimitTxId = outcome.transactionId;
      await expect.poll(() => queuedCustomRow(walletA.page, withinLimitTxId)).toBe('queued');
    });

    await steps.step('dapp_custom_over_limit_requires_wallet_owned_authentication', async () => {
      // 650 is now spent, so 100 breaches - and ONLY because the custom request above was counted.
      // Uncounted, this would be 600 + 100 against a 700 limit and would go straight through.
      const before = new Set((await executeRows(walletA.page)).map(row => row.id));
      const transactionRequest = await walletA.buildCustomTransactionRequestForTest({
        recipientAddress: addressB,
        faucetId,
        amountBaseUnits: toBaseUnits(100)
      });
      const popupPromise = waitForConfirmPopup(walletA.page.context());
      const request = requestDappCustom(dapp, {
        address: addressA,
        transactionRequest,
        recipientAddress: addressB
      });
      const popup = await waitForConfirmForm(await popupPromise, CONFIRM_TESTID.transactionApprove);
      await clickConfirmAction(popup, CONFIRM_TESTID.transactionApprove);
      const challenge = popup.locator(SPENDING_LIMIT_CHALLENGE);
      await expect(challenge.getByText('Spending limit exceeded')).toBeVisible();
      await expect
        .poll(() => addedCustomRows(walletA.page, before, withinLimitTxId))
        .toBe('none added; anchor present');

      await challenge.getByRole('button', { name: 'Cancel', exact: true }).click();
      const outcome = await request;
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toBe('NOT_GRANTED');
      await expect
        .poll(() => addedCustomRows(walletA.page, before, withinLimitTxId))
        .toBe('none added; anchor present');
    });

    await steps.step('dapp_custom_over_limit_proceeds_once_authenticated', async () => {
      const transactionRequest = await walletA.buildCustomTransactionRequestForTest({
        recipientAddress: addressB,
        faucetId,
        amountBaseUnits: toBaseUnits(100)
      });
      const popupPromise = waitForConfirmPopup(walletA.page.context());
      const request = requestDappCustom(dapp, {
        address: addressA,
        transactionRequest,
        recipientAddress: addressB
      });
      const popup = await waitForConfirmForm(await popupPromise, CONFIRM_TESTID.transactionApprove);
      await clickConfirmAction(popup, CONFIRM_TESTID.transactionApprove);
      await expect(popup.locator(SPENDING_LIMIT_CHALLENGE).getByText('Spending limit exceeded')).toBeVisible();
      await authenticateSpendingLimitChallenge(popup);

      const outcome = await request;
      expect(outcome.ok).toBe(true);
      expect(outcome.transactionId).not.toBe('');
      await expect.poll(() => queuedCustomRow(walletA.page, outcome.transactionId)).toBe('queued');
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

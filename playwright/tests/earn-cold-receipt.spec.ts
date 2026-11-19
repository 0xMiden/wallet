import type { Page } from '@playwright/test';

import {
  preparedAllocation,
  PREPARED_FAUCET,
  PREPARED_OWNER,
  PREPARED_RECIPIENT,
  PREPARED_TOKEN
} from '../../src/lib/epoch/testing/earn-prepared';
import { EarnWithdrawTransaction } from '../../src/lib/miden/db/types';
import { loadMidenSdk } from '../e2e/helpers/dapp-confirm';
import { importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';

async function seedPreparedFailure(page: Page, id: string, accountId: string) {
  const { Address } = await loadMidenSdk();
  let recipient: string;
  try {
    recipient = Address.fromBech32(accountId.split('_')[0]!).accountId().toString();
  } catch {
    throw new Error('Could not decode the mock wallet receive address');
  }
  const delivery = preparedAllocation('22', true);
  delivery.requestJson = delivery.requestJson.replace(PREPARED_RECIPIENT, recipient);
  const attemptId = 'mock-original-attempt';
  const row = new EarnWithdrawTransaction(
    accountId,
    10n ** 19n,
    PREPARED_OWNER,
    `DUMMY_LENDING:11155111:${PREPARED_TOKEN}`,
    PREPARED_FAUCET,
    '10',
    'USDC',
    attemptId,
    undefined,
    18,
    'dummy-lending',
    11155111
  );
  row.id = id;
  row.extraInputs = {
    ...row.extraInputs,
    phase: 'failed',
    error: 'Mock delivery failed',
    submissionState: 'prepared',
    withdrawIntentNonce: delivery.nonce,
    epochAllocatorUrl: 'https://earn-cold-receipt.invalid',
    preparedExecution: {
      chainId: 11155111,
      attemptId,
      allocations: [preparedAllocation('11', false), delivery],
      delivery: {
        allocationIndex: 1,
        owner: PREPARED_OWNER,
        nonce: delivery.nonce,
        destinationChainId: 999999999,
        recipientAccountId: recipient,
        destinationFaucetId: PREPARED_FAUCET
      }
    }
  };

  // Commit before the second document boots; the receipt must use its own real Dexie subscription.
  await page.evaluate(
    saved =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('TridentMain');
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => reject(new Error('Could not open the initialized mock transaction store'));
        open.onsuccess = () => {
          const db = open.result;
          try {
            const transaction = db.transaction('transactions', 'readwrite');
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            transaction.onabort = () => {
              db.close();
              reject(new Error('Could not commit the mock withdrawal'));
            };
            transaction.objectStore('transactions').add(saved);
          } catch {
            db.close();
            reject(new Error('Could not write to the mock transaction store'));
          }
        };
      }),
    { ...row }
  );
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('cold FullPage history opens the original failed Earn withdrawal with Retry delivery enabled', async ({
  extensionContext,
  extensionId
}) => {
  test.setTimeout(300_000);
  await extensionContext.route(/^https?:\/\//, route => {
    const { hostname } = new URL(route.request().url());
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? route.continue() : route.abort();
  });
  await importWallet(extensionContext, extensionId);

  const id = 'mock-original-earn-withdrawal';
  const fullpage = `chrome-extension://${extensionId}/fullpage.html`;
  const url = `${fullpage}#/history-details/${id}`;
  const empty = await extensionContext.newPage();
  await empty.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(empty.getByTestId('command-workbench').getByText('Failed to load transaction')).toBeVisible({
    timeout: 30_000
  });
  await empty.goto(`${fullpage}#/receive`);
  const accountId = (await empty.getByTestId('receive-address-full').textContent())?.trim();
  if (!accountId) throw new Error('Mock wallet receive address is missing');
  await seedPreparedFailure(empty, id, accountId);
  await empty.close();

  const cold = await extensionContext.newPage();
  let react185 = false;
  const markReact185 = (message: string) => {
    if (message.includes('Minified React error #185')) react185 = true;
  };
  cold.on('console', message => {
    if (message.type() === 'error') markReact185(message.text());
  });
  cold.on('pageerror', error => markReact185(error.message));
  await cold.goto(url, { waitUntil: 'domcontentloaded' });

  const receipt = cold.getByTestId('command-workbench');
  const retry = receipt.getByRole('button', { name: 'Retry delivery', exact: true });
  await expect
    .poll(
      async () => {
        if (react185) return 'React #185';
        if (await retry.isVisible()) return 'receipt';
        if (await receipt.getByTestId('withdrawal-recovery-unavailable').isVisible()) return 'retry unavailable';
        return 'not ready';
      },
      {
        message: 'The cold prepared/failed receipt should reach Retry delivery without React #185',
        timeout: 30_000
      }
    )
    .toBe('receipt');
  await expect(receipt.getByText('Withdrawal details', { exact: true })).toBeVisible();
  await expect(receipt.getByTestId('history-status-pill')).toHaveText('Failed');
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
  expect(react185).toBe(false);
});

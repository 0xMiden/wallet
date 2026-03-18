import { WalletType } from 'screens/onboarding/types';

import { expect, test } from './fixtures';
import { createAccount, fundAccount, getState, switchAccount, waitForBalance } from './helpers';

const TEST_PASSWORD = 'StressTest123!';
const NUM_RECEIVERS = 10;
const NOTES_PER_RECEIVER = 10;
const TOTAL_NOTES = NUM_RECEIVERS * NOTES_PER_RECEIVER;
const AMOUNT_PER_NOTE = '0.1'; // 0.01 MDN per note

test.describe.configure({ mode: 'serial' });

test.describe('Stress Test: Private Notes', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension only runs in Chromium');

  test('send 100 private notes to 10 accounts and verify receipt', async ({ extensionContext, extensionId }) => {
    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const page = await extensionContext.newPage();

    // ==================== PHASE 1: SETUP ====================
    console.log('=== PHASE 1: SETUP ===');

    await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded' });

    // Onboard wallet via UI
    const welcome = page.getByTestId('onboarding-welcome');
    await welcome.waitFor({ timeout: 30_000 });
    await welcome.getByRole('button', { name: /create a new wallet/i }).click();

    // Back up seed phrase
    await page.getByText(/back up your wallet/i).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /show/i }).click();

    // Extract first and last seed words for verification
    const seedWords = await page.$$eval('article > label > label > p:last-child', paragraphs =>
      paragraphs.map(p => p.textContent?.trim() || '')
    );
    const firstWord = seedWords[0];
    const lastWord = seedWords[11];
    if (!firstWord || !lastWord) {
      throw new Error('Failed to read seed words from backup screen');
    }

    await page.getByRole('button', { name: /continue/i }).click();

    // Verify seed phrase
    await page.getByTestId('verify-seed-phrase').waitFor({ timeout: 15_000 });
    const verifyContainer = page.getByTestId('verify-seed-phrase');
    await verifyContainer.locator(`button:has-text("${firstWord}")`).first().click();
    await verifyContainer.locator(`button:has-text("${lastWord}")`).first().click();
    await verifyContainer.getByRole('button', { name: /continue/i }).click();

    // Set password
    await expect(page).toHaveURL(/create-password/);
    await page.locator('input[placeholder="Enter password"]').first().fill(TEST_PASSWORD);
    await page.locator('input[placeholder="Enter password again"]').first().fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /continue/i }).click();

    // Complete onboarding
    await expect(page.getByText(/your wallet is ready/i)).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /get started/i }).click();
    await expect(page.getByText('Send')).toBeVisible({ timeout: 30_000 });

    console.log('Wallet onboarded successfully');

    // Get sender account info
    const initialState = await getState(page);
    const senderAccount = initialState.accounts[0];
    const senderPubKey = senderAccount.publicKey;
    console.log(`Sender address: ${senderPubKey}`);

    // Fund sender via faucet API
    await fundAccount(senderPubKey);
    console.log('Faucet request sent, waiting for faucet note...');

    // Go to Receive page and wait for the faucet note to appear
    await page.goto(`${fullpageUrl}#/receive`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('receive-page').waitFor({ timeout: 30_000 });

    // Poll until a claimable note shows up
    for (let attempt = 0; attempt < 120; attempt++) {
      // Wait for React to fully render after each reload
      await page.getByTestId('receive-page').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2_000);

      const claimSpan = page.locator('span:text("Claim")').first();
      if (await claimSpan.isVisible().catch(() => false)) {
        break;
      }
      await page.waitForTimeout(5_000);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    // Click the parent <button> of the Claim span
    await page.getByTestId('receive-page').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const claimButton = page.locator('button:has(span:text("Claim"))').first();
    await expect(claimButton).toBeVisible({ timeout: 10_000 });
    await claimButton.click();
    console.log('Claiming faucet note...');

    // Then wait until we're back on a stable page
    await page.waitForTimeout(10_000);

    // Navigate to home and wait for balance to appear
    await page.goto(`${fullpageUrl}#/`, { waitUntil: 'domcontentloaded' });
    await waitForBalance(page);
    console.log('Sender funded and faucet note claimed successfully');

    // Create 10 receiver accounts (private/off-chain)
    for (let i = 0; i < NUM_RECEIVERS; i++) {
      await createAccount(page, WalletType.OffChain, `Receiver-${i}`);
    }
    const stateAfterCreate = await getState(page);
    const receivers = stateAfterCreate.accounts.slice(1); // skip sender (index 0)
    console.log(`Created ${receivers.length} receiver accounts`);

    for (const r of receivers) {
      console.log(`  ${r.name}: ${r.publicKey}`);
    }

    // Switch back to sender
    await switchAccount(page, senderPubKey);
    await page.goto(`${fullpageUrl}#/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);

    // ==================== PHASE 2: SEND 100 NOTES ====================
    console.log('=== PHASE 2: SENDING 100 PRIVATE NOTES ===');

    const sendTimings: number[] = [];

    for (let receiverIdx = 0; receiverIdx < receivers.length; receiverIdx++) {
      const receiver = receivers[receiverIdx];

      for (let noteIdx = 0; noteIdx < NOTES_PER_RECEIVER; noteIdx++) {
        const noteNum = receiverIdx * NOTES_PER_RECEIVER + noteIdx + 1;
        const sendStart = Date.now();

        // Navigate to send flow
        await page.goto(`${fullpageUrl}#/send`, { waitUntil: 'domcontentloaded' });
        const sendFlow = page.getByTestId('send-flow');
        await sendFlow.waitFor({ timeout: 30_000 });

        // Step 1: SelectToken — click the MDN token row
        await sendFlow.locator('text=MDN').first().click();

        // Step 2: SelectRecipient — paste recipient address, click Next
        await page.locator('textarea').fill(receiver.publicKey);
        await page.getByRole('button', { name: /next/i }).click();

        // Step 3: SelectAmount — enter amount, click Next
        const amountInput = page.locator('input[type="text"]').first();
        await amountInput.fill(AMOUNT_PER_NOTE);
        await page.getByRole('button', { name: /next/i }).click();

        // Step 4: ReviewTransaction — enable "Share privately" toggle, then submit
        const sharePrivatelyToggle = sendFlow.locator('input[name="sharePrivately"]');
        const isChecked = await sharePrivatelyToggle.isChecked();
        if (!isChecked) {
          // Click the toggle's parent container (ToggleSwitch wraps the input)
          await sharePrivatelyToggle.locator('..').click();
        }

        // Click Send (type="submit")
        await page.getByRole('button', { name: /^send$/i }).click();

        // Wait for transaction to complete — URL will leave #/send
        await page.waitForURL(url => !url.hash?.includes('/send'), { timeout: 120_000 });

        const sendDuration = Date.now() - sendStart;
        sendTimings.push(sendDuration);
        console.log(`[${noteNum}/${TOTAL_NOTES}] Sent to ${receiver.name} (${sendDuration}ms)`);
      }
    }

    const avgSendTime = sendTimings.reduce((a, b) => a + b, 0) / sendTimings.length;
    console.log(`Average send time: ${Math.round(avgSendTime)}ms`);

    // ==================== PHASE 3: VERIFY RECEIPT ====================
    console.log('=== PHASE 3: VERIFYING RECEIPT ===');

    type ReceiverResult = {
      receiver: string;
      address: string;
      expected: number;
      received: number;
    };

    const results: ReceiverResult[] = [];

    for (const receiver of receivers) {
      // Switch to receiver account
      await switchAccount(page, receiver.publicKey);

      // Navigate to Receive page
      await page.goto(`${fullpageUrl}#/receive`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('receive-page').waitFor({ timeout: 30_000 });

      // Wait for claimable notes to appear by counting MDN labels
      let noteCount = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        await page.waitForTimeout(2_000);
        const mdnLabels = page.getByTestId('receive-page').locator('p:text("MDN")');
        noteCount = await mdnLabels.count();
        console.log(`[${receiver.name}] Attempt ${attempt + 1}: Found ${noteCount} notes`);
        if (noteCount >= NOTES_PER_RECEIVER) break;

        await page.waitForTimeout(5_000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByTestId('receive-page').waitFor({ timeout: 30_000 });
      }

      results.push({
        receiver: receiver.name,
        address: receiver.publicKey,
        expected: NOTES_PER_RECEIVER,
        received: noteCount
      });

      console.log(`${receiver.name}: ${noteCount}/${NOTES_PER_RECEIVER} notes received`);
    }

    // ==================== PHASE 4: REPORT ====================
    console.log('=== STRESS TEST RESULTS ===');

    const totalReceived = results.reduce((sum, r) => sum + r.received, 0);
    const totalMissing = TOTAL_NOTES - totalReceived;

    const report = {
      totalSent: TOTAL_NOTES,
      totalReceived,
      totalMissing,
      averageSendTimeMs: Math.round(avgSendTime),
      results
    };

    console.log(JSON.stringify(report, null, 2));

    for (const r of results) {
      if (r.received < r.expected) {
        console.error(`MISSING: ${r.receiver} received ${r.received}/${r.expected}`);
      }
    }

    expect(totalMissing).toBe(0);
  });
});

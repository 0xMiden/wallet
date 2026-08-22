import { errors } from '@playwright/test';

import {
  CONFIRM_TESTID,
  FIXTURE_DAPP_ORIGIN,
  clickConfirmAction,
  completeSeedImportOnboarding,
  loadMidenSdk,
  openFixtureDapp,
  readQueuedTransactions,
  readWalletAddress,
  waitForConfirmForm,
  waitForConfirmPopup
} from '../e2e/helpers/dapp-confirm';
import { expect, test } from '../fixtures/extension';

/**
 * The dApp provider surface, driven for real across every realm boundary it
 * has: an https page -> `window.midenWallet` -> content script -> intercom ->
 * service worker -> a separate `confirm.html` popup window -> back to the
 * page's promise.
 *
 * Jest already covers each of those units in isolation
 * (`midenWindowObject.test.ts`, `client.test.ts`, `contentScript.test.ts`,
 * `ConfirmPage.test.tsx`). What no unit test reaches is the WIRING between
 * them, the REAL page origin the service worker sees, and what the approval
 * screen shows next to what the wallet then queues. Those are what this spec
 * is for.
 *
 * NO CHAIN: every approval payload here is built before any RPC happens, so
 * all of it runs on the cheap mocked build (`MIDEN_USE_MOCK_CLIENT`).
 *
 * NOT COVERED HERE — verifying a real signature against the advertised public
 * key. `MidenClientInterface.create` drops the wallet's keystore callbacks in
 * the mock branch, so no auth secret is ever persisted and APPROVING a
 * `signBytes` fails inside the vault with "Some storage item not found". That
 * is a property of the mock, not of the product, and it means the signing
 * ceremony can only be driven up to the approval screen here. The sign screen
 * and its decline path ARE covered below; the cryptographic check needs the
 * real client, i.e. a chain-backed job.
 *
 * NOT COVERED HERE either, and covered in jest instead by
 * `src/lib/miden/back/dapp.send-preview.test.ts`:
 *  - The mobile/desktop approval sheet. This file is Chromium/MV3-only
 *    (`test.skip` below), so the whole `!isExtension()` confirmation-store
 *    branch of `dapp.ts` — a different renderer with its own origin field — is
 *    unreachable from here.
 *  - The send amount's DECIMALS. Chainless, no faucet resolves at all, so the
 *    approval sheet withholds the quantity rather than quoting one. See
 *    {@link EXPECTED_AMOUNT_ROW}.
 */

/** A syntactically valid Word: four small field elements, little-endian u64s. */
const SIGN_WORD_BYTES = [
  1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0
];

/**
 * Fixed dApp-requested send. Distinct, non-symmetric strings so a substituted
 * value cannot coincidentally match the truncated form rendered on screen.
 */
const REQUESTED = {
  recipient: 'mtst1qq0dapprecipientfixture0000000000000wxyz',
  faucetId: 'mtst1qqdappfaucetfixture00000000000000000abcd',
  /** Base units. */
  amountBaseUnits: 1_500_000,
  noteType: 'private' as const
};

/**
 * What the approval screen must show for {@link REQUESTED}.
 *
 * `?`, not a number. The wallet reads a faucet's decimals from the chain, and
 * this fixture's faucet does not exist — so there is no scale to convert
 * `amountBaseUnits` by. The approval sheet is where a user decides whether to
 * authorise a transfer, and quoting a quantity derived from the placeholder's
 * guessed 6 decimals states as fact something that can be off by a factor of a
 * trillion. The sheet names the asset and withholds the number instead.
 *
 * This spec ran chainless before that change too, so it was asserting `-1.5` —
 * the guess — and calling it the expected output.
 *
 * LIMIT OF THIS CHECK: it pins the WIRING (the preview string reaches the
 * screen, rendered verbatim and signed as an outflow) and still fails if the
 * amount is shown raw in base units, which is what mobile and desktop used to
 * show. It cannot exercise the decimals arithmetic, since nothing here resolves.
 *
 * The falsifying coverage for both the decimals fix and the withholding lives in
 * `src/lib/miden/back/dapp.send-preview.test.ts`, which drives the same
 * formatter with 9-decimal, 18-decimal, placeholder and absent metadata.
 */
const EXPECTED_AMOUNT_ROW = '-?';
/** `truncateAddress` on a bech32 with no underscore is `truncateHash(addr, 6, 4)`. */
const EXPECTED_RECIPIENT_ROW = `${REQUESTED.recipient.slice(0, 6)}…${REQUESTED.recipient.slice(-4)}`;

type ConnectOutcome = {
  ok: boolean;
  name: string;
  message: string;
  address: string;
  publicKey: number[];
};

/**
 * No `signature` field: only the DECLINE path is driven here (approving a
 * `signBytes` needs the real client — see the file docstring), so a captured
 * signature would be permanently unasserted.
 */
type SignOutcome = {
  ok: boolean;
  name: string;
  message: string;
};

type SendOutcome = {
  ok: boolean;
  name: string;
  message: string;
  transactionId: string;
};

/**
 * The provider as the PAGE sees it — declared structurally rather than
 * imported from `src/`. A spec that imported the wallet's own class would be
 * asserting against the very object it is supposed to be probing through the
 * injected global.
 */
type InjectedProvider = {
  address?: string;
  publicKey?: Uint8Array;
  connect(privateDataPermission: string, network: string): Promise<void>;
  disconnect(): Promise<void>;
  signBytes(data: Uint8Array, kind: string): Promise<{ signature: Uint8Array }>;
  requestSend(transaction: {
    senderAddress: string;
    recipientAddress: string;
    faucetId: string;
    noteType: string;
    amount: number;
  }): Promise<{ transactionId?: string }>;
};

/** Page-side: `connect()`, flattened so a rejection survives serialization. */
const pageConnect = async (): Promise<ConnectOutcome> => {
  const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
  try {
    await provider.connect('UPON_REQUEST', 'testnet');
    return {
      ok: true,
      name: '',
      message: '',
      address: provider.address ?? '',
      publicKey: Array.from(provider.publicKey ?? new Uint8Array())
    };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, name: err?.name ?? '', message: err?.message ?? '', address: '', publicKey: [] };
  }
};

/** Page-side: `signBytes(word)`. */
const pageSignBytes = async (bytes: number[]): Promise<SignOutcome> => {
  const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
  try {
    await provider.signBytes(new Uint8Array(bytes), 'word');
    return { ok: true, name: '', message: '' };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, name: err?.name ?? '', message: err?.message ?? '' };
  }
};

/** Page-side: `requestSend(...)`. */
const pageRequestSend = async (transaction: {
  senderAddress: string;
  recipientAddress: string;
  faucetId: string;
  noteType: string;
  amount: number;
}): Promise<SendOutcome> => {
  const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
  try {
    const { transactionId } = await provider.requestSend(transaction);
    return { ok: true, name: '', message: '', transactionId: transactionId ?? '' };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, name: err?.name ?? '', message: err?.message ?? '', transactionId: '' };
  }
};

/** Page-side: `disconnect()`. Never prompts, so it can simply be awaited. */
const pageDisconnect = async (): Promise<{ ok: boolean; message: string }> => {
  const provider = (window as unknown as { midenWallet: InjectedProvider }).midenWallet;
  try {
    await provider.disconnect();
    return { ok: true, message: '' };
  } catch (e) {
    return { ok: false, message: (e as { message?: string })?.message ?? '' };
  }
};

test.describe('dApp provider', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'MV3 extension only runs in Chromium');

  /**
   * Budget, itemised — the test timeout must exceed the SUM of every bounded
   * wait below, otherwise a stuck step reports a bare "Test timeout" instead of
   * the wait's own diagnostic, which is the whole point of bounding them:
   *
   *   onboarding                380s  (see `completeSeedImportOnboarding`:
   *                                    goto 30 + 5 screen waits at 30
   *                                    + 14 fills and 6 clicks at 10)
   *   readWalletAddress          40s  (goto 20 + attached 20)
   *   openFixtureDapp            60s  (goto 30 + provider injection 30)
   *   connect popup + form       35s  (20 + 15)
   *   connect-origin assertion   10s  (config `expect.timeout`)
   *   approve click              15s
   *   send popup + form          35s  (20 + 15)
   *   5 screen assertions        50s  (5 x 10)
   *   approve click              15s
   *   queued-row poll            20s
   *                            -----
   *                             660s
   *
   * Playwright's `actionTimeout`/`navigationTimeout` both default to 0 (no
   * limit) and this config sets neither, so the helper bounds each of its own
   * clicks, fills and navigations explicitly — see `ACTION_TIMEOUT`.
   *
   * Every individual popup interaction stays well under `AUTODECLINE_AFTER`
   * (120s in `dapp.ts`).
   */
  test('connect and requestSend: the screen matches what gets queued', async ({ extensionContext, extensionId }) => {
    test.setTimeout(780_000);

    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const walletPage = await extensionContext.newPage();
    await completeSeedImportOnboarding(walletPage, fullpageUrl);

    const walletAddress = await readWalletAddress(walletPage, fullpageUrl, 20_000);
    const dapp = await openFixtureDapp(extensionContext);

    // ── connect ────────────────────────────────────────────────────────────
    // Arm the popup waiter BEFORE the call that opens it: `waitForEvent` only
    // observes pages created after it starts listening.
    const connectPopupPromise = waitForConfirmPopup(extensionContext, 20_000);
    const connectCall = dapp.evaluate(pageConnect);
    const connectPopup = await waitForConfirmForm(await connectPopupPromise, CONFIRM_TESTID.connectApprove, 15_000);

    // The connect prompt is the ONLY place the user learns who is asking. If it
    // rendered the wallet's own chrome-extension:// origin, or the dApp-supplied
    // display name, a phishing page would be indistinguishable from a real one.
    await expect(connectPopup.getByTestId('connect-origin')).toHaveText(FIXTURE_DAPP_ORIGIN);

    await clickConfirmAction(connectPopup, CONFIRM_TESTID.connectApprove, 15_000);
    const connected = await connectCall;

    expect(connected.message).toBe('');
    expect(connected.ok).toBe(true);
    // The account identifier handed to the dApp must be the one the wallet
    // shows the user. Fails if the permission response drops the field (the
    // page-side `provider.address ?? ''` turns that into `''`) or returns the
    // wrong one of the session's two identifiers — it carries BOTH an
    // `accountId` and a `publicKey` commitment and the request types name them
    // inconsistently. It does NOT prove account SELECTION: this wallet has one
    // account, and both the Receive screen and the confirm page read the same
    // `account.publicKey`, so there is no second account to pick by mistake.
    expect(connected.address).toBe(walletAddress);
    // A public-key commitment is one Word: exactly 32 bytes. A short/empty
    // value means the connect resolved without ever resolving a signer.
    expect(connected.publicKey.length).toBe(32);

    // ── requestSend: what the screen says vs what gets queued ───────────────
    const sendPopupPromise = waitForConfirmPopup(extensionContext, 20_000);
    const sendCall = dapp.evaluate(pageRequestSend, {
      senderAddress: walletAddress,
      recipientAddress: REQUESTED.recipient,
      faucetId: REQUESTED.faucetId,
      noteType: REQUESTED.noteType,
      amount: REQUESTED.amountBaseUnits
    });
    const sendPopup = await waitForConfirmForm(await sendPopupPromise, CONFIRM_TESTID.transactionApprove, 15_000);

    // The highest-consequence bug class on this surface: an approval screen
    // that shows the user something other than what it is about to sign.
    // The origin row used to render the service worker's own
    // `chrome-extension://<id>` on every non-connect screen, because the
    // payload builders closed over the DOM global `origin`.
    await expect(sendPopup.getByTestId('confirm-request-origin')).toHaveText(FIXTURE_DAPP_ORIGIN);
    await expect(sendPopup.getByTestId('confirm-tx-faucet')).toHaveText(REQUESTED.faucetId);
    await expect(sendPopup.getByTestId('confirm-tx-value-amount')).toHaveText(EXPECTED_AMOUNT_ROW);
    // Only the first 6 and last 4 characters are on screen (the product
    // truncates addresses); the untruncated value is checked against the queued
    // row below.
    await expect(sendPopup.getByTestId('confirm-tx-value-recipient')).toHaveText(EXPECTED_RECIPIENT_ROW);
    // What the user is asked to approve for note visibility. On its own this
    // only proves the preview renders `capitalizeFirstLetter(noteType)`; the
    // half that proves the wallet then BROADCASTS that visibility is the queued
    // -row check at the end of this test.
    await expect(sendPopup.getByTestId('confirm-tx-value-note-type')).toHaveText('Private');

    await clickConfirmAction(sendPopup, CONFIRM_TESTID.transactionApprove, 15_000);
    const sent = await sendCall;

    expect(sent.message).toBe('');
    expect(sent.ok).toBe(true);

    // `initiateSendTransaction` writes the queued row before any proving, so
    // this is readable with no chain (the later prove/submit fails, which is
    // fine — nothing below depends on it). Exactly one row: an approval that
    // enqueued nothing, or enqueued twice, fails here.
    await expect
      .poll(() => readQueuedTransactions(walletPage).then(rows => rows.filter(row => row.type === 'send').length), {
        timeout: 20_000,
        intervals: [250, 500, 1000]
      })
      .toBe(1);

    const queued = (await readQueuedTransactions(walletPage)).filter(row => row.type === 'send');
    const sendRow = queued[0];
    if (!sendRow) {
      throw new Error('queued send row disappeared between the poll and the read');
    }
    // The untruncated half of the screen-vs-queued check.
    expect(sendRow.recipient).toBe(REQUESTED.recipient);
    expect(sendRow.faucetId).toBe(REQUESTED.faucetId);
    expect(sendRow.amount).toBe(String(REQUESTED.amountBaseUnits));
    // The security-relevant half of the note-visibility check: the preview and
    // the queued row are built from two different reads of `noteType`, so they
    // can disagree. Fails if the approval path hands `initiateSendTransaction`
    // anything other than what the screen said — a note approved as private and
    // broadcast as public leaks its contents to everyone.
    expect(sendRow.noteType).toBe(REQUESTED.noteType);
    // Closes the last link in the screen -> queued -> returned chain. Fails if
    // the response resolves without a transaction id, which leaves every dApp
    // that tracks the send by the value it awaits holding `undefined`.
    expect(sent.transactionId).toBe(sendRow.id);
  });

  /**
   * Budget, itemised (same rule as above — the timeout must exceed the sum):
   *
   *   onboarding                380s
   *   readWalletAddress          40s
   *   openFixtureDapp            60s
   *   connect popup + form       35s
   *   approve click              15s
   *   sign popup + form          35s
   *   sign-origin assertion      10s
   *   disclosure click           15s
   *   digest assertion           10s
   *   decline click              15s
   *   quiet watch                20s
   *   re-prompt popup + form     35s
   *   re-prompt origin           10s
   *   approve click              15s
   *                            -----
   *                             695s
   *
   * Plus one product timeout that this test can legitimately hit: if a repeat
   * connect DOES prompt but opens after the 20s quiet watch, the connect call
   * then sits until `AUTODECLINE_AFTER` (120s in `dapp.ts`) before rejecting.
   * The budget covers that tail so the failure surfaces as the postcondition
   * assertion below rather than as a bare "Test timeout" — 695 + 120 = 815s.
   */
  test('sign preview, typed decline, and revocation re-prompt', async ({ extensionContext, extensionId }) => {
    test.setTimeout(960_000);

    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const walletPage = await extensionContext.newPage();
    await completeSeedImportOnboarding(walletPage, fullpageUrl);

    // Ground truth for every address this test compares. Without it the three
    // address comparisons below would each be `provider.address` against
    // `provider.address` — and `pageConnect` coerces a missing address to `''`,
    // so dropping `accountId` from the permission response would leave every
    // one of them comparing `''` to `''` and passing.
    const walletAddress = await readWalletAddress(walletPage, fullpageUrl, 20_000);
    const dapp = await openFixtureDapp(extensionContext);

    const connectPopupPromise = waitForConfirmPopup(extensionContext, 20_000);
    const connectCall = dapp.evaluate(pageConnect);
    const connectPopup = await waitForConfirmForm(await connectPopupPromise, CONFIRM_TESTID.connectApprove, 15_000);
    await clickConfirmAction(connectPopup, CONFIRM_TESTID.connectApprove, 15_000);
    const connected = await connectCall;
    expect(connected.message).toBe('');
    expect(connected.ok).toBe(true);
    expect(connected.address).toBe(walletAddress);

    // ── the signing prompt, and declining it ───────────────────────────────
    const signPopupPromise = waitForConfirmPopup(extensionContext, 20_000);
    const declinedCall = dapp.evaluate(pageSignBytes, SIGN_WORD_BYTES);
    const signPopup = await waitForConfirmForm(await signPopupPromise, CONFIRM_TESTID.signDecline, 15_000);

    await expect(signPopup.getByTestId('confirm-request-origin')).toHaveText(FIXTURE_DAPP_ORIGIN);

    // The digest on screen must be the digest the dApp asked to have signed.
    // Expanded from the "Raw value" disclosure; the expected hex is computed
    // here from the same bytes the page sent, via the SDK directly, so a
    // wallet-side mix-up (wrong payload rendered, or a stale request's digest
    // shown for this one) fails.
    const sdk = await loadMidenSdk();
    const expectedWordHex = sdk.Word.deserialize(new Uint8Array(SIGN_WORD_BYTES)).toHex();
    await signPopup.getByTestId('advanced-details-toggle').click({ timeout: 15_000 });
    await expect(signPopup.getByTestId('advanced-details-content')).toHaveText(expectedWordHex);

    await clickConfirmAction(signPopup, CONFIRM_TESTID.signDecline, 15_000);
    const declined = await declinedCall;

    expect(declined.ok).toBe(false);
    // `MidenWalletError` IMPLEMENTS Error rather than extending it, so
    // `instanceof Error` is false in the page and dApps must branch on the
    // NAME. That contract is the load-bearing one here: losing it (an opaque
    // "An unknown error occured", or a differently-named error class) silently
    // breaks every dApp's "user cancelled" path.
    expect(declined.name).toBe('NotGrantedMidenWalletError');
    // WHAT THIS SECOND ASSERTION PINS, exactly: the raw WIRE code, not a
    // user-facing string. `createError` in `lib/adapter/client.ts` overwrites
    // the class's friendly default ("Permission Not Granted") with the payload
    // string whenever one is present, so today the page sees the wire code
    // verbatim. This is pinned because dApps in the wild branch on it — NOT
    // because surfacing a raw code is the desirable end state. Making the
    // message human-readable is a deliberate contract change: update this line
    // with it, do not read a red test here as proof the change was wrong.
    expect(declined.message).toBe('NOT_GRANTED');

    // ── revocation ─────────────────────────────────────────────────────────
    // Baseline first: while the session EXISTS, a repeat connect is answered
    // from storage with no prompt at all. Without this half, "a popup opened
    // after disconnect" would prove nothing — the wallet might always prompt.
    //
    // ONLY a genuine timeout counts as "no popup". Any other rejection (context
    // teardown, a throw from the predicate) is rethrown rather than folded into
    // the passing value, so a broken watcher cannot pass for a quiet wallet.
    // The window is well above a service-worker cold start; the postconditions
    // immediately after are what catch a prompt that opens later still.
    const quietWatch = waitForConfirmPopup(extensionContext, 20_000).then(
      () => 'popup',
      (e: unknown) => {
        if (e instanceof errors.TimeoutError) return 'no-popup';
        throw e;
      }
    );
    const silentReconnect = dapp.evaluate(pageConnect);
    expect(await quietWatch).toBe('no-popup');
    // Positive postcondition: the silent path did not merely stay quiet, it
    // resolved, and it resolved to the same account the wallet displays.
    const silent = await silentReconnect;
    expect(silent.message).toBe('');
    expect(silent.ok).toBe(true);
    expect(silent.address).toBe(walletAddress);

    const disconnected = await dapp.evaluate(pageDisconnect);
    expect(disconnected.message).toBe('');
    expect(disconnected.ok).toBe(true);

    // Now the same call must prompt again. Fails if `disconnect` leaves the
    // stored session behind — a revoked dApp that silently re-connects with no
    // user interaction at all.
    const rePromptPromise = waitForConfirmPopup(extensionContext, 20_000);
    const reconnectCall = dapp.evaluate(pageConnect);
    const rePrompt = await waitForConfirmForm(await rePromptPromise, CONFIRM_TESTID.connectApprove, 15_000);
    await expect(rePrompt.getByTestId('connect-origin')).toHaveText(FIXTURE_DAPP_ORIGIN);

    await clickConfirmAction(rePrompt, CONFIRM_TESTID.connectApprove, 15_000);
    const reconnected = await reconnectCall;
    expect(reconnected.message).toBe('');
    expect(reconnected.ok).toBe(true);
    expect(reconnected.address).toBe(walletAddress);
  });
});

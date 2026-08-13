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
 * LIMIT OF THIS CHECK: the wallet resolves the faucet's decimals through
 * `getTokenMetadata`, and no faucet in a chainless run resolves to anything but
 * the 6-decimal default. So this pins the 6-decimal case only — it proves the
 * amount is scaled and signed (a send is an outflow), NOT that a 9-decimal
 * faucet would render correctly. It DOES fail if the amount is shown raw in
 * base units, which is what mobile and desktop used to show.
 */
const EXPECTED_AMOUNT_ROW = '-1.5';
/** `truncateAddress` on a bech32 with no underscore is `truncateHash(addr, 6, 4)`. */
const EXPECTED_RECIPIENT_ROW = `${REQUESTED.recipient.slice(0, 6)}…${REQUESTED.recipient.slice(-4)}`;

type ConnectOutcome = {
  ok: boolean;
  name: string;
  message: string;
  address: string;
  publicKey: number[];
};

type SignOutcome = {
  ok: boolean;
  name: string;
  message: string;
  signature: number[];
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
    const { signature } = await provider.signBytes(new Uint8Array(bytes), 'word');
    return { ok: true, name: '', message: '', signature: Array.from(signature) };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, name: err?.name ?? '', message: err?.message ?? '', signature: [] };
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
   * Budget: the waits below sum to roughly 330s worst case (onboarding 5x30s,
   * provider page 30+30s, address 20s, two approvals at 20+15+15s each, four
   * screen assertions at 10s, IDB poll 20s). The test budget must exceed that
   * sum, otherwise a stuck step reports a bare "Test timeout" instead of the
   * wait's own diagnostic. Every individual popup interaction stays well under
   * `AUTODECLINE_AFTER` (120s in `dapp.ts`).
   */
  test('connect and requestSend: the screen matches what gets queued', async ({ extensionContext, extensionId }) => {
    test.setTimeout(420_000);

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
    // The account handed to the dApp must be the one the user is looking at.
    // Fails if the permission response returns the wrong field — the session
    // carries BOTH an `accountId` and a `publicKey` commitment, and the request
    // types name them inconsistently — or simply the wrong account.
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
    // Note visibility is a security-relevant field the dApp chooses and the
    // user approves — a private note silently sent as public is a real leak.
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
  });

  /**
   * Budget: roughly 340s of waits worst case (onboarding 150s, provider page
   * 60s, connect 50s, sign screen 50s + 2x10s assertions, quiet watch 8s,
   * re-prompt 50s).
   */
  test('sign preview, typed decline, and revocation re-prompt', async ({ extensionContext, extensionId }) => {
    test.setTimeout(420_000);

    const fullpageUrl = `chrome-extension://${extensionId}/fullpage.html`;
    const walletPage = await extensionContext.newPage();
    await completeSeedImportOnboarding(walletPage, fullpageUrl);

    const dapp = await openFixtureDapp(extensionContext);

    const connectPopupPromise = waitForConfirmPopup(extensionContext, 20_000);
    const connectCall = dapp.evaluate(pageConnect);
    const connectPopup = await waitForConfirmForm(await connectPopupPromise, CONFIRM_TESTID.connectApprove, 15_000);
    await clickConfirmAction(connectPopup, CONFIRM_TESTID.connectApprove, 15_000);
    const connected = await connectCall;
    expect(connected.message).toBe('');
    expect(connected.ok).toBe(true);

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
    // name. That contract is what is pinned here: losing it (an opaque
    // "An unknown error occured", or the raw intercom error leaking through)
    // silently breaks every dApp's "user cancelled" path.
    expect(declined.name).toBe('NotGrantedMidenWalletError');
    expect(declined.message).toBe('NOT_GRANTED');

    // ── revocation ─────────────────────────────────────────────────────────
    // Baseline first: while the session EXISTS, a repeat connect is answered
    // from storage with no prompt at all. Without this half, "a popup opened
    // after disconnect" would prove nothing — the wallet might always prompt.
    const quietWatch = waitForConfirmPopup(extensionContext, 8_000)
      .then(() => 'popup')
      .catch(() => 'none');
    const silentReconnect = dapp.evaluate(pageConnect);
    expect(await quietWatch).toBe('none');
    const silent = await silentReconnect;
    expect(silent.message).toBe('');
    expect(silent.ok).toBe(true);
    expect(silent.address).toBe(connected.address);

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
    expect(reconnected.address).toBe(connected.address);
  });
});

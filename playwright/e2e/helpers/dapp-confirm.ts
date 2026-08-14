/**
 * Helpers for driving the dApp provider surface end to end:
 * a real https:// page -> `window.midenWallet` -> content script -> intercom ->
 * service worker -> `browser.windows.create('confirm.html')` -> the approval
 * popup -> back to the page's promise.
 *
 * None of this needs a chain. Every approval payload the provider builds is a
 * pure function of what the dApp asked for plus what is already in the vault,
 * so the whole journey runs on the cheap mocked build (`MIDEN_USE_MOCK_CLIENT`)
 * in `playwright/tests/`.
 *
 * The confirm surface has no product-owned selectors other than the two
 * `data-testid`s added alongside this file (`ConfirmPage.tsx`) — the
 * `ConfirmPageSelectors` enum is an ANALYTICS event-name list that
 * `FormSubmitButton` passes to `trackEvent`, never to the DOM. The enum values
 * are reused verbatim as the testids so there is still one name per action.
 */
import type { BrowserContext, Page } from '@playwright/test';

/**
 * A reserved-invalid host, so the fixture page can never accidentally hit the
 * network. `context.route` fulfils it locally; the manifest's https content
 * scripts matcher still fires anyway, because matching is URL-based.
 */
export const FIXTURE_DAPP_ORIGIN = 'https://miden-dapp-fixture.invalid';

/**
 * Mirrors the `ConfirmPageSelectors` values that reach the DOM, which are not
 * importable from a Playwright spec. Only the actions currently driven are
 * listed — an unused selector here would be dead weight, not documentation.
 */
export const CONFIRM_TESTID = {
  connectApprove: 'ConfirmPage/ConnectAction/ConnectButton',
  signDecline: 'ConfirmPage/SignData/RejectButton',
  transactionApprove: 'ConfirmPage/TransactionAction/AcceptButton'
} as const;

/** One queued row from the wallet's own Dexie DB (`TridentMain` / `transactions`). */
export type QueuedTransactionRow = {
  id: string;
  type: string;
  amount: string;
  faucetId: string;
  recipient: string;
  /**
   * `SendTransaction.noteType` — the visibility the wallet is about to broadcast
   * with. Read back so the approval screen's "Note Type" row can be checked
   * against what was actually queued, not just against itself.
   */
  noteType: string;
};

/**
 * Ceiling for a single interaction (a fill, a click, a navigation) inside these
 * helpers. @playwright/test defaults `actionTimeout` and `navigationTimeout` to
 * 0 — unbounded — so without this a step that never settles silently eats the
 * whole test budget and the run reports a bare "Test timeout" naming no step.
 * Every one of these actions runs against an element the caller has already
 * waited for, so seconds is generous.
 */
const ACTION_TIMEOUT = 10_000;

/**
 * Serves a minimal dApp page at {@link FIXTURE_DAPP_ORIGIN} and waits until the
 * extension has injected the provider. Resolving `window.midenWallet` here (and
 * not in every spec) means a spec that later times out is failing on ITS OWN
 * step, not on injection.
 */
export async function openFixtureDapp(context: BrowserContext, timeoutMs = 30_000): Promise<Page> {
  await context.route(`${FIXTURE_DAPP_ORIGIN}/**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!DOCTYPE html><html><head><title>Miden dApp fixture</title></head><body><h1>fixture</h1></body></html>'
    })
  );

  const page = await context.newPage();
  await page.goto(`${FIXTURE_DAPP_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  // contentScript.js runs at document_start and appends addToWindow.js, which
  // defines window.midenWallet asynchronously.
  await page.waitForFunction(() => typeof (window as unknown as { midenWallet?: unknown }).midenWallet === 'object', {
    timeout: timeoutMs
  });

  return page;
}

/**
 * Resolves with the approval popup opened by `dapp.ts`
 * (`browser.windows.create({ url: 'confirm.html#?id=…' })`).
 *
 * MUST be called BEFORE the provider call that opens it — `waitForEvent` only
 * sees pages created after it starts listening. The URL predicate is what makes
 * this deterministic: the context also holds the dApp page and the wallet
 * fullpage, and a bare `waitForEvent('page')` would race whichever appears
 * first. Never sleep here; a sleep would go green on `retries: 2` and hide the
 * race it was papering over.
 */
export function waitForConfirmPopup(context: BrowserContext, timeoutMs = 30_000): Promise<Page> {
  return context.waitForEvent('page', {
    timeout: timeoutMs,
    predicate: async candidate => {
      // A brand-new page can still be on about:blank when the event fires.
      await candidate.waitForLoadState('domcontentloaded').catch(() => undefined);
      return candidate.url().includes('confirm.html');
    }
  });
}

/**
 * Asserts the popup opened by {@link waitForConfirmPopup} has actually rendered
 * the approval form (not the Unlock screen, not a Suspense spinner) and returns
 * it. Establishes only that: the named action button exists and is attached —
 * it says nothing about the payload rows, which each spec asserts itself.
 */
export async function waitForConfirmForm(popup: Page, approveTestId: string, timeoutMs = 30_000): Promise<Page> {
  await popup.getByTestId(approveTestId).waitFor({ state: 'visible', timeout: timeoutMs });
  return popup;
}

/**
 * Clicks an approve/decline button on the confirm popup. The popup window is
 * closed by the background script once the request resolves, so the click is
 * the last thing that touches this page.
 */
export async function clickConfirmAction(popup: Page, testId: string, timeoutMs = 30_000): Promise<void> {
  await popup.getByTestId(testId).click({ timeout: timeoutMs });
}

/**
 * Runs the wallet's real seed-import onboarding to the "Open wallet" handoff,
 * which is gated on the store reaching Ready — i.e. on the vault being created
 * and unlocked in the service worker. That unlocked vault is the precondition
 * for every dApp approval (`withUnlocked` in `dapp.ts`), so specs must not skip
 * it. Mirrors `playwright/tests/popup-smoke.spec.ts`.
 *
 * Every navigation, fill and click carries an explicit timeout — see
 * {@link ACTION_TIMEOUT}. A wedged step must name itself, not silently consume
 * the caller's whole budget.
 */
export async function completeSeedImportOnboarding(page: Page, fullpageUrl: string, timeoutMs = 30_000): Promise<void> {
  await page.goto(fullpageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  await page.getByTestId('onboarding-welcome').waitFor({ timeout: timeoutMs });
  await page.locator('#import-link').click({ timeout: ACTION_TIMEOUT });
  await page.getByTestId('import-seed-phrase').waitFor({ timeout: timeoutMs });

  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
    ' '
  );
  for (let i = 0; i < words.length; i++) {
    await page.locator(`#seed-phrase-input-${i}`).fill(words[i]!, { timeout: ACTION_TIMEOUT });
  }
  await page.getByRole('button', { name: /continue/i }).click({ timeout: ACTION_TIMEOUT });

  await page.locator('input[placeholder="Enter password"]').first().fill('Password123!', { timeout: ACTION_TIMEOUT });
  await page
    .locator('input[placeholder="Enter password again"]')
    .first()
    .fill('Password123!', { timeout: ACTION_TIMEOUT });
  await page.getByRole('button', { name: /continue/i }).click({ timeout: ACTION_TIMEOUT });

  await page.getByTestId('import-recovery-method').waitFor({ timeout: timeoutMs });
  await page.getByText(/import public account/i).click({ timeout: ACTION_TIMEOUT });
  await page.getByRole('button', { name: /continue/i }).click({ timeout: ACTION_TIMEOUT });

  await page.getByTestId('onboarding-confirmation').waitFor({ timeout: timeoutMs });
  await page.getByTestId('onboarding-confirmation-submit').click({ timeout: ACTION_TIMEOUT });

  // "Open wallet" only renders once the store is Ready — deliberately NOT
  // clicked: it hands off to the Chrome side panel and closes this tab.
  await page.getByRole('button', { name: /open wallet/i }).waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * The untruncated address the wallet UI itself shows the user, read from the
 * Receive screen's `receive-address-full` node.
 *
 * WHAT THIS ESTABLISHES, precisely. It is read through the wallet's own UI and
 * not from anything the dApp bridge returned, so comparing a bridge-returned
 * address against it proves the bridge resolved AN address and that it is the
 * identifier the wallet displays. It does NOT prove account selection: Receive
 * renders `useAccount().publicKey` and ConfirmPage hands the service worker
 * that same `account.publicKey`, so in a single-account wallet there is no
 * second account for the bridge to pick by mistake. The failure modes it does
 * catch are a bridge response missing the field entirely (the page-side
 * `provider.address ?? ''` coerces that to `''`) and a response carrying the
 * wrong one of the session's two identifiers (`accountId` vs `publicKey`).
 *
 * The node is `sr-only`, so it is awaited ATTACHED rather than visible. An
 * attached-but-unpopulated node would silently yield `''` and make every later
 * comparison against it meaningless, so an empty read throws here instead.
 */
export async function readWalletAddress(page: Page, fullpageUrl: string, timeoutMs = 30_000): Promise<string> {
  await page.goto(`${fullpageUrl}#/receive`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const node = page.getByTestId('receive-address-full');
  await node.waitFor({ state: 'attached', timeout: timeoutMs });
  const address = (await node.innerText()).trim();
  if (address === '') {
    throw new Error('the Receive screen rendered an empty address — the account never hydrated');
  }
  return address;
}

/**
 * Loads the Miden SDK in the Node test process, so a spec can compute an
 * expected value (a digest, a commitment) from primitives instead of reading it
 * back off the screen it is supposed to be checking.
 *
 * Two non-obvious requirements:
 *  - The `/lazy` (WASM) entry, NOT the package root. Under Node, the root
 *    resolves to the napi build, whose compat shim normalizes every
 *    `Uint8Array` argument to a plain `Array` and then fails inside the native
 *    binding with "Failed to get Buffer pointer and length" — so every
 *    `X.deserialize(bytes)` call is unusable there.
 *  - A `file:` fetch shim, because the WASM entry loads its `.wasm` through
 *    `fetch` and Node's fetch refuses `file:` URLs. Same shim as
 *    `playwright/fixtures/mockWebClient.ts`, where it is already proven.
 *
 * The shim is installed on the Node test process's `globalThis` and is RESTORED
 * in a `finally` as soon as the WASM is up. `workers: 1` + `fullyParallel:
 * false` means every later spec file in this worker shares that global, and a
 * helper has no business leaving a patched `fetch` behind it.
 *
 * Memoized — WASM init is expensive and a second one is wasted work.
 */
let sdkPromise: Promise<typeof import('@miden-sdk/miden-sdk/lazy')> | null = null;
export function loadMidenSdk(): Promise<typeof import('@miden-sdk/miden-sdk/lazy')> {
  sdkPromise ??= (async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.protocol === 'file:') {
        const { readFile } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const buffer = await readFile(fileURLToPath(url));
        return new Response(new Uint8Array(buffer), { headers: { 'Content-Type': 'application/wasm' } });
      }
      return originalFetch(input, init);
    };

    try {
      const sdk = await import('@miden-sdk/miden-sdk/lazy');
      await sdk.MidenClient.ready();
      return sdk;
    } finally {
      globalThis.fetch = originalFetch;
    }
  })();
  return sdkPromise;
}

/**
 * Reads the wallet's queued-transaction rows straight out of IndexedDB.
 *
 * This is the "what actually got signed" side of the screen-vs-signed check:
 * `initiateSendTransaction` writes the row before any proving happens, so the
 * row is readable without a chain even though the later prove/submit will fail.
 * Must run on a page in the extension origin — IndexedDB is origin-scoped and
 * the service worker shares the extension's partition.
 *
 * `amount` is stringified in-page: the stored value is a BigInt.
 */
export async function readQueuedTransactions(page: Page): Promise<QueuedTransactionRow[]> {
  return page.evaluate(
    () =>
      new Promise<QueuedTransactionRow[]>((resolve, reject) => {
        const request = indexedDB.open('TridentMain');
        request.onerror = () => reject(new Error('could not open TridentMain'));
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('transactions')) {
            resolve([]);
            return;
          }
          const store = db.transaction('transactions', 'readonly').objectStore('transactions');
          const all = store.getAll();
          all.onerror = () => reject(new Error('could not read transactions'));
          all.onsuccess = () => {
            const rows: QueuedTransactionRow[] = [];
            for (const row of all.result as Array<Record<string, unknown>>) {
              rows.push({
                id: String(row.id ?? ''),
                type: String(row.type ?? ''),
                amount: String(row.amount ?? ''),
                faucetId: String(row.faucetId ?? ''),
                recipient: String(row.secondaryAccountId ?? ''),
                noteType: String(row.noteType ?? '')
              });
            }
            resolve(rows);
          };
        };
      })
  );
}

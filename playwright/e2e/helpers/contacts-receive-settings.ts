/**
 * Drivers for the three wallet surfaces that no E2E has ever touched: the
 * Settings **address book**, the send flow's **contact picker**, the **receive**
 * QR/copy surface, and the **general settings** toggles.
 *
 * Everything here is a driver with a POSTCONDITION. A helper that navigates,
 * clicks and returns is indistinguishable from one that navigated nowhere — so
 * each of these confirms the thing it was asked to do actually happened and
 * throws a diagnostic naming what it saw versus what it expected. The headline
 * `expect()`s stay in the specs; the throws here exist so a broken step fails at
 * the step, not three screens later.
 *
 * Deliberately a separate module (not methods on `wallet-page.ts`) so parallel
 * work on the shared POM cannot conflict with it.
 *
 * ── Traps this module encodes, each of which costs a debugging cycle ──────────
 *
 *  1. `navigateTo('/settings/address-book')` SILENTLY DOES NOTHING USEFUL.
 *     `Settings.tsx`'s `activeTab` lookup is `allTabs.find(t => t.slug === tabSlug
 *     && !t.isDrawer)`, and both address-book and general-settings are
 *     `isDrawer: true` — so a direct hash nav falls back to the Settings ROOT
 *     list and the spec then times out on drawer content that was never asked
 *     for. These tabs are only reachable by CLICKING their menu row.
 *     (`wallet-page.ts:805-817` documents the same trap for guardian-settings.)
 *
 *  2. `AddressBook/AddNewContact` is a PHANTOM selector. It is written as
 *     `testID` on `FormSubmitButton`, but `FormSubmitButton` destructures
 *     `testID` out and only uses it for `trackEvent` — it never renders it. Grep
 *     finds it; the DOM does not have it. This module uses the raw
 *     `address-book-add-contact` data-testid instead. The same is true of every
 *     `General Settings/*Toggle` string, which is why `ToggleSwitch` now emits
 *     its `testID` as a data-testid too.
 *
 *  3. Contact identity is ADDRESS-KEYED and self-healing:
 *     `use-filtered-contacts.hook.ts` silently deletes (during render!) any
 *     address-book entry whose address matches one of the wallet's OWN accounts.
 *     A contact must therefore point at the OTHER wallet, and `addContact`
 *     PREPENDS — so nothing here may assume list ordering.
 *
 *  4. Deleting a contact goes through `useConfirm()`, i.e. the app-wide
 *     ConfirmationModal, and only rows with `accountInWallet === false` are
 *     clickable at all. "Click the first row" is a no-op on a wallet's own
 *     account row.
 */
import { type Locator, type Page } from '@playwright/test';

import type { ChromeWalletPageApi } from './wallet-page';

// ── Settings drawers ────────────────────────────────────────────────────────

/** The two Settings tabs this module drives, and the menu row that opens each. */
const SETTINGS_TAB_BUTTON = {
  'address-book': 'Settings/AddressBookButton',
  'general-settings': 'Settings/GeneralButton'
} as const;

export type SettingsDrawerName = keyof typeof SETTINGS_TAB_BUTTON;

/**
 * Reload the wallet page for real (a new document), and wait for the app to
 * paint. `navigateTo` is a HASH navigation and never reloads the document — so
 * anything that must survive a genuine page load (e.g. `initTheme()` re-applying
 * the persisted theme at module scope) has to be checked after this, not after a
 * hash nav.
 */
export async function reloadWallet(wallet: ChromeWalletPageApi, timeoutMs = 60_000): Promise<void> {
  await wallet.page.reload({ waitUntil: 'domcontentloaded' });
  await wallet.page.waitForSelector('#root > *', { timeout: timeoutMs });
}

/**
 * Open one of the drawer-backed Settings tabs THE ONLY WAY IT CAN BE OPENED:
 * by navigating to the Settings root and clicking its menu row (see trap 1).
 *
 * Bounces through home FIRST, deliberately. `navigateTo` is a hash navigation,
 * so going straight to `/settings` while already ON `/settings` remounts
 * nothing: the drawer would still be open and its content would still be
 * showing whatever component-local state it had, which makes "reopen it and see
 * what it re-reads" a vacuous check. Leaving the route unmounts `Settings`
 * (a routed FullScreenPage), so the drawer is genuinely re-created and its
 * content re-runs the real getters at mount.
 *
 * @returns a locator for the drawer's content root, already confirmed visible.
 */
export async function openSettingsDrawer(
  wallet: ChromeWalletPageApi,
  drawer: SettingsDrawerName,
  timeoutMs = 30_000
): Promise<Locator> {
  const buttonTestId = SETTINGS_TAB_BUTTON[drawer];
  await wallet.navigateTo('/');
  await wallet.page.getByTestId('explore-page').waitFor({ state: 'visible', timeout: timeoutMs });
  await wallet.navigateTo('/settings');

  const button = wallet.page.getByTestId(buttonTestId);
  try {
    await button.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `openSettingsDrawer("${drawer}"): the Settings root never rendered a ` +
        `[data-testid="${buttonTestId}"] row within ${timeoutMs}ms. ` +
        `Rows present: ${JSON.stringify(await listSettingsRows(wallet.page))}. ` +
        `URL: ${wallet.page.url()}`
    );
  }
  await button.click();

  const content = wallet.page.getByTestId(drawer);
  try {
    await content.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `openSettingsDrawer("${drawer}"): clicked [data-testid="${buttonTestId}"] but no ` +
        `[data-testid="${drawer}"] drawer content appeared within ${timeoutMs}ms. ` +
        `URL: ${wallet.page.url()}. Note a direct hash nav to /settings/${drawer} would ALSO ` +
        `show nothing — drawer tabs are excluded from Settings' activeTab lookup.`
    );
  }
  return content;
}

/** Every Settings menu row currently in the DOM, for failure diagnostics. */
async function listSettingsRows(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="Settings/"]')
    .evaluateAll(els => els.map(el => el.getAttribute('data-testid') ?? '<no testid>'));
}

// ── Address book ────────────────────────────────────────────────────────────

const CONTACT_ROW_PREFIX = 'address-book-contact-';

export interface ContactInput {
  name: string;
  address: string;
}

/**
 * Add a contact from the OPEN address-book drawer and confirm its row rendered.
 *
 * Postcondition: a row keyed by `contact.address` exists AND carries
 * `contact.name`. Both matter — the row appearing under a different name would
 * mean the form dropped the name field, and the settings write is asynchronous
 * (it round-trips through the backend), so this waits rather than reads once.
 */
export async function addContact(
  wallet: ChromeWalletPageApi,
  contact: ContactInput,
  timeoutMs = 30_000
): Promise<Locator> {
  const book = wallet.page.getByTestId('address-book');
  await book.waitFor({ state: 'visible', timeout: timeoutMs });

  await book.getByTestId('address-book-name-input').fill(contact.name);
  await book.getByTestId('address-book-address-input').fill(contact.address);

  const submit = book.getByTestId('address-book-add-contact');
  try {
    await submit.waitFor({ state: 'visible', timeout: timeoutMs });
    await submit.click({ timeout: timeoutMs });
  } catch {
    throw new Error(
      `addContact("${contact.name}"): could not click [data-testid="address-book-add-contact"] ` +
        `within ${timeoutMs}ms — the Add Contact button stays disabled until BOTH name and address ` +
        `are non-empty. Drawer text: ${await safeText(book)}`
    );
  }

  const row = wallet.page.getByTestId(`${CONTACT_ROW_PREFIX}${contact.address}`);
  try {
    await row.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `addContact("${contact.name}", ${contact.address}): no contact row appeared within ${timeoutMs}ms. ` +
        `Addresses in the book: ${JSON.stringify(await listAddressBookContacts(wallet.page))}. ` +
        `Drawer text (carries any validation message): ${await safeText(book)}`
    );
  }

  const renderedName = (await row.textContent())?.trim() ?? '';
  if (!renderedName.includes(contact.name)) {
    throw new Error(
      `addContact: the row for ${contact.address} rendered without the contact name ` +
        `"${contact.name}". Row text: ${JSON.stringify(renderedName)}`
    );
  }
  return row;
}

/**
 * Delete a contact from the OPEN address-book drawer, going through the real
 * confirmation modal (see trap 4).
 *
 * Postcondition: the row for `address` is gone from the DOM.
 */
export async function deleteContact(wallet: ChromeWalletPageApi, address: string, timeoutMs = 30_000): Promise<void> {
  const row = wallet.page.getByTestId(`${CONTACT_ROW_PREFIX}${address}`);
  try {
    await row.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `deleteContact(${address}): no such row to delete. ` +
        `Addresses in the book: ${JSON.stringify(await listAddressBookContacts(wallet.page))}`
    );
  }
  await row.click();

  const confirmButton = wallet.page.getByTestId('confirmation-modal-confirm');
  try {
    await confirmButton.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(
      `deleteContact(${address}): clicking the contact row did not open the confirmation modal. ` +
        `Only rows with accountInWallet === false are clickable — a wallet's OWN account row is inert, ` +
        `so this address is probably one of this wallet's accounts rather than an external contact.`
    );
  }
  // Bounded, and verified by its POSTCONDITION rather than by the click
  // returning. Two things went wrong here before:
  //   1. unbounded, so an unsettled actionability check hung for the whole test
  //      budget and failed with a closed-context error naming nothing;
  //   2. a blind `force: true` retry, which "succeeded" while the delete never
  //      happened — the run then failed 30s later with the row still present.
  // The modal DISAPPEARING is the proof the click was handled (`useConfirm`
  // unmounts it in the same tick it resolves), so retry against that rather
  // than against the click resolving.
  const confirmClickLanded = async (opts: { force: boolean }): Promise<boolean> => {
    await confirmButton.click({ timeout: 15_000, force: opts.force }).catch(() => {});
    return confirmButton
      .waitFor({ state: 'detached', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  };
  if (!(await confirmClickLanded({ force: false })) && !(await confirmClickLanded({ force: true }))) {
    throw new Error(
      `deleteContact(${address}): clicked the confirmation modal's Confirm button but the modal stayed ` +
        `open, so the delete was never dispatched. The button is present and visible — something is ` +
        `swallowing the click (an overlay, or a modal still animating in).`
    );
  }

  try {
    await row.waitFor({ state: 'detached', timeout: timeoutMs });
  } catch {
    throw new Error(
      `deleteContact(${address}): confirmed the delete but the row is still in the DOM after ${timeoutMs}ms. ` +
        `Addresses in the book: ${JSON.stringify(await listAddressBookContacts(wallet.page))}`
    );
  }
}

/** Addresses of every contact row currently rendered in the address book. */
export async function listAddressBookContacts(page: Page): Promise<string[]> {
  return page
    .locator(`[data-testid^="${CONTACT_ROW_PREFIX}"]`)
    .evaluateAll(
      (els, prefix) => els.map(el => (el.getAttribute('data-testid') ?? '').slice(prefix.length)),
      CONTACT_ROW_PREFIX
    );
}

// ── Send flow: contact picker ───────────────────────────────────────────────

const PICKER_ROW_PREFIX = 'send-contact-';

export interface PickerContact {
  name: string;
  address: string;
}

/**
 * Navigate to `/send` and open the recipient step's Address Book bottom sheet.
 *
 * @returns a locator for the picker list, already confirmed visible. The sheet
 *          is PORTALED out of the send-flow container, so it is page-scoped.
 */
export async function openSendContactPicker(wallet: ChromeWalletPageApi, timeoutMs = 30_000): Promise<Locator> {
  await wallet.navigateTo('/send');
  const sendFlow = wallet.page.getByTestId('send-flow');
  await sendFlow.waitFor({ state: 'visible', timeout: timeoutMs });

  const addressBookButton = sendFlow.getByTestId('send-address-book-icon');
  try {
    await addressBookButton.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `openSendContactPicker: the recipient step never rendered the Address Book button ` +
        `([data-testid="send-address-book-icon"]) within ${timeoutMs}ms. URL: ${wallet.page.url()}`
    );
  }
  await addressBookButton.click();

  const list = wallet.page.getByTestId('send-contacts-list');
  try {
    await list.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `openSendContactPicker: clicked the Address Book button but the contacts sheet ` +
        `([data-testid="send-contacts-list"]) never opened within ${timeoutMs}ms.`
    );
  }
  return list;
}

/**
 * Every row of the OPEN contact picker, as `{ name, address }`. The name is the
 * CardItem title; the address comes off the row's testid, so this reports the
 * name→address mapping the user is actually choosing between.
 */
export async function listSendPickerContacts(page: Page): Promise<PickerContact[]> {
  return page.locator(`[data-testid^="${PICKER_ROW_PREFIX}"]`).evaluateAll(
    (els, prefix) =>
      els.map(el => ({
        address: (el.getAttribute('data-testid') ?? '').slice(prefix.length),
        name: (el.querySelector('p')?.textContent ?? '').trim()
      })),
    PICKER_ROW_PREFIX
  );
}

/**
 * Pick a contact from the OPEN picker BY NAME — the way a user does — and prove
 * the name resolved to the address it was saved under.
 *
 * Postconditions, all three of which have to hold for "picked by name" to mean
 * anything: exactly ONE row carries that name; that row's address is
 * `expectedAddress`; and after the click the recipient step renders the contact
 * NAME (`send-recipient-name` — the only surface in the whole send flow where a
 * contact name is displayed) with the address loaded into the recipient field.
 */
export async function pickContactByName(
  wallet: ChromeWalletPageApi,
  name: string,
  expectedAddress: string,
  timeoutMs = 30_000
): Promise<void> {
  // `openSendContactPicker` only waits for the sheet CONTAINER, which mounts one
  // commit before its rows. Enumerating straight away is a one-shot read that can
  // sample an empty list on a perfectly healthy wallet, so wait for the row first.
  const expectedRow = wallet.page.getByTestId(`${PICKER_ROW_PREFIX}${expectedAddress}`);
  try {
    await expectedRow.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `pickContactByName("${name}"): the picker never rendered a row for ${expectedAddress} within ${timeoutMs}ms. ` +
        `Picker rows: ${JSON.stringify(await listSendPickerContacts(wallet.page))}`
    );
  }

  const rows = await listSendPickerContacts(wallet.page);
  const matches = rows.filter(row => row.name === name);
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new Error(
      `pickContactByName("${name}"): expected exactly 1 picker row with that name, found ${matches.length}. ` +
        `Picker rows: ${JSON.stringify(rows)}`
    );
  }
  if (match.address !== expectedAddress) {
    throw new Error(
      `pickContactByName("${name}"): the contact shown as "${name}" resolves to ${match.address}, ` +
        `but it was saved for ${expectedAddress}. Picking a contact by name would send to the wrong ` +
        `account. Picker rows: ${JSON.stringify(rows)}`
    );
  }

  await expectedRow.click({ timeout: timeoutMs });

  const nameEl = wallet.page.getByTestId('send-recipient-name');
  try {
    await nameEl.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `pickContactByName("${name}"): picked the row but the recipient step never rendered the contact ` +
        `name ([data-testid="send-recipient-name"]) within ${timeoutMs}ms. SendManager resolves the name ` +
        `by matching the recipient address against the merged contact list, so a missing name means the ` +
        `pick did not populate the address, or it populated a differently-cased/whitespaced address.`
    );
  }

  const renderedName = (await nameEl.textContent())?.trim() ?? '';
  if (renderedName !== name) {
    throw new Error(`pickContactByName("${name}"): recipient step shows "${renderedName}" instead.`);
  }

  const filled = await wallet.page.getByTestId('send-recipient-input').inputValue();
  if (filled.trim() !== expectedAddress) {
    throw new Error(
      `pickContactByName("${name}"): recipient field holds ${JSON.stringify(filled)}, expected ${expectedAddress}.`
    );
  }
}

// ── Send flow: completing a send that started from the contact picker ────────

export interface AdvanceToReviewParams {
  /** Token symbol as the picker lists it, e.g. "TST". */
  tokenSymbol: string;
  /** Human amount typed into the amount field, e.g. "500". */
  amount: string;
  isPrivate: boolean;
}

/** What the review route received, for the caller to assert on before submitting. */
export interface SendReviewState {
  /** Query params of `#/send/review?amount=…&to=…&tokenId=…`. */
  params: Record<string, string>;
  /** Full visible text of the review screen. */
  text: string;
}

/**
 * Carry a send that is sitting on the recipient step (with a contact already
 * picked) through to the review screen: confirm recipient → token → amount →
 * review, and force the note type.
 *
 * This does NOT reuse `WalletPage.sendTokens`, because that helper starts by
 * navigating to `/send` and typing the address straight into the recipient
 * field — precisely the path these specs exist to avoid.
 *
 * NOTE for callers: the review screen renders the raw ADDRESS, never the
 * contact name — `ReviewTransaction` parses `to` off the query string and does
 * no contact lookup at all. "The contact name survives to review" is not a
 * property this product has; the name is checked on the recipient step instead
 * (see `pickContactByName`).
 *
 * @returns the review route's params and on-screen text, so the SPEC owns the
 *          assertion about which recipient actually reached review.
 */
export async function advanceToSendReview(
  wallet: ChromeWalletPageApi,
  params: AdvanceToReviewParams
): Promise<SendReviewState> {
  const STEP_TIMEOUT_MS = 30_000;
  const page = wallet.page;
  const sendFlow = page.getByTestId('send-flow');

  await sendFlow.getByTestId('send-recipient-confirm').click({ timeout: STEP_TIMEOUT_MS });

  // Token picker: a bottom sheet portaled outside the send-flow container.
  await sendFlow.getByTestId('send-token-selector').click({ timeout: STEP_TIMEOUT_MS });
  await page.getByTestId('send-token-search').waitFor({ timeout: STEP_TIMEOUT_MS });
  const tokenRow = page.getByTestId(`send-token-${params.tokenSymbol}`);
  try {
    await tokenRow.first().click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    const available = await page
      .locator('[data-testid^="send-token-"]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-testid') ?? ''));
    throw new Error(
      `advanceToSendReview: no "${params.tokenSymbol}" row in the token picker. ` +
        `Rows present: ${JSON.stringify(available)}`
    );
  }

  await sendFlow.getByTestId('send-amount-input').fill(params.amount);
  await sendFlow.getByTestId('send-amount-confirm').click({ timeout: STEP_TIMEOUT_MS });

  // Review is a routed full-screen page that installs this hook on mount; the
  // public/private choice has no UI control any more.
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __TEST_SET_SHARE_PRIVATELY__?: (v: boolean) => void })
        .__TEST_SET_SHARE_PRIVATELY__ === 'function',
    undefined,
    { timeout: STEP_TIMEOUT_MS }
  );
  await page.evaluate(
    value =>
      (window as unknown as { __TEST_SET_SHARE_PRIVATELY__?: (v: boolean) => void }).__TEST_SET_SHARE_PRIVATELY__?.(
        value
      ),
    params.isPrivate
  );

  const submit = page.getByTestId('send-review-submit');
  try {
    await submit.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  } catch {
    throw new Error(
      `advanceToSendReview: never reached the review screen ([data-testid="send-review-submit"]) ` +
        `within ${STEP_TIMEOUT_MS}ms. URL: ${page.url()}`
    );
  }

  return { params: await readRouteParams(page), text: (await page.locator('body').textContent()) ?? '' };
}

/** Query params of the current hash route (`#/send/review?amount=…&to=…`). */
export async function readRouteParams(page: Page): Promise<Record<string, string>> {
  const hash = await page.evaluate(() => window.location.hash);
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) {
    throw new Error(`readRouteParams: the current route has no query string (hash: ${JSON.stringify(hash)})`);
  }
  return Object.fromEntries(new URLSearchParams(hash.slice(queryStart + 1)));
}

// ── Receive: QR payload + clipboard ─────────────────────────────────────────

/** `miden:` — the URI scheme `lib/qr/format.ts` prefixes every encoded address with. */
export const MIDEN_URI_PREFIX = 'miden:';

export interface ReceiveSurface {
  /** The untruncated address rendered in the sr-only span. */
  addressText: string;
  /** The payload the QR encoder was last repainted with (`miden:<address>`). */
  qrPayload: string;
  /** How many <svg> elements the QR container actually painted. */
  qrSvgCount: number;
}

/**
 * Read the Receive screen's address surfaces.
 *
 * On the QR: the repo has no QR *decoder* (`qr-code-styling` is an encoder;
 * `qrcode`/`qrcode-generator` are transitive-only; `sharp` rasterizes), and the
 * rendered SVG's centre modules are deliberately punched out for the logo, so a
 * hand-rolled decoder would need Reed-Solomon recovery to read it back. Rather
 * than add a decode dependency, `QRCode` mirrors the payload onto
 * `data-qr-payload` FROM INSIDE the effect that repaints the encoder, so the
 * attribute tracks that the repaint COMPLETED with this payload rather than what
 * the component merely computed. It does not prove the bitmap encodes it.
 *
 * The attribute is therefore absent until that repaint runs — hence waiting on
 * `[data-qr-payload]` rather than reading the attribute once.
 */
export async function readReceiveSurface(wallet: ChromeWalletPageApi, timeoutMs = 30_000): Promise<ReceiveSurface> {
  const page = wallet.page;
  await page.getByTestId('receive-page').waitFor({ state: 'visible', timeout: timeoutMs });

  const qr = page.getByTestId('qr-code');
  try {
    await qr.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(
      `readReceiveSurface: the Receive screen rendered but its QR container ` +
        `([data-testid="qr-code"]) never appeared within ${timeoutMs}ms.`
    );
  }

  try {
    await page.locator('[data-testid="qr-code"][data-qr-payload]').waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    throw new Error(
      `readReceiveSurface: the QR container rendered but never mirrored a data-qr-payload within ${timeoutMs}ms. ` +
        `That attribute is written by the same effect that calls qrCode.update(), so a missing one means the ` +
        `encoder was never (re)painted — whatever picture is on screen is not this account's.`
    );
  }
  const qrPayload = (await qr.getAttribute('data-qr-payload')) ?? '';

  const addressText = (await page.getByTestId('receive-address-full').textContent())?.trim() ?? '';
  if (!addressText) {
    throw new Error('readReceiveSurface: [data-testid="receive-address-full"] rendered empty.');
  }

  return { addressText, qrPayload, qrSvgCount: await qr.locator('svg').count() };
}

/**
 * Record every `navigator.clipboard.writeText` call into a page global.
 *
 * Reading the real clipboard is not an option here: the two-wallets fixture
 * launches TWO headed persistent contexts and never grants `clipboard-read`, and
 * at most one of them holds OS focus — `navigator.clipboard.readText()` needs
 * both. Recording the write is the same fact without the flake.
 *
 * Must be installed BEFORE the navigation whose clicks are being recorded
 * (`addInitScript` runs on each new document).
 */
export async function installClipboardRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const patched = window as unknown as { __TEST_CLIPBOARD_WRITES__: string[]; __TEST_CLIPBOARD_PATCHED__: boolean };
    const writes: string[] = [];
    patched.__TEST_CLIPBOARD_WRITES__ = writes;
    patched.__TEST_CLIPBOARD_PATCHED__ = false;
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    const original = clipboard.writeText?.bind(clipboard);
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      writable: true,
      value: (text: string) => {
        writes.push(String(text));
        // Still perform the real write so the product's own behaviour is unchanged;
        // swallow rejections (a headless/unfocused context may refuse it).
        return original ? original(String(text)).catch(() => undefined) : Promise.resolve();
      }
    });
    patched.__TEST_CLIPBOARD_PATCHED__ = true;
  });
}

/** Everything `installClipboardRecorder` has captured on the current document. */
export async function readClipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __TEST_CLIPBOARD_WRITES__?: string[] }).__TEST_CLIPBOARD_WRITES__ ?? []
  );
}

/**
 * Click the Receive screen's copy button and wait for the clipboard write it is
 * supposed to make.
 *
 * `useCopyToClipboard` latches `copied` for 2s and makes a second click within
 * that window a NO-OP, so this never re-clicks — it waits on the first write.
 *
 * @returns every write recorded so far, so the caller can assert the FIRST one
 *          and that there was exactly one.
 */
export async function copyReceiveAddress(wallet: ChromeWalletPageApi, timeoutMs = 15_000): Promise<string[]> {
  const page = wallet.page;
  const before = (await readClipboardWrites(page)).length;
  await page.getByTestId('receive-copy-address').click({ timeout: timeoutMs });
  try {
    await page.waitForFunction(
      count =>
        ((window as unknown as { __TEST_CLIPBOARD_WRITES__?: string[] }).__TEST_CLIPBOARD_WRITES__ ?? []).length >
        count,
      before,
      { timeout: timeoutMs }
    );
  } catch {
    const recorderInstalled = await page.evaluate(
      () => (window as unknown as { __TEST_CLIPBOARD_PATCHED__?: boolean }).__TEST_CLIPBOARD_PATCHED__ === true
    );
    throw new Error(
      `copyReceiveAddress: clicked [data-testid="receive-copy-address"] but no ` +
        `navigator.clipboard.writeText call was recorded within ${timeoutMs}ms. ` +
        `Recorder patched navigator.clipboard: ${recorderInstalled} (false means installClipboardRecorder ` +
        `ran before the navigation but navigator.clipboard was unavailable — a harness problem, not a ` +
        `product one). Writes so far: ${JSON.stringify(await readClipboardWrites(page))}.`
    );
  }
  return readClipboardWrites(page);
}

// ── General settings: toggles + persistence surfaces ────────────────────────

/** `lib/settings/constants.ts` THEME_STORAGE_KEY — `setThemeSetting` writes the raw enum value. */
export const THEME_SETTING_KEY = 'theme_setting';

/** Raw `localStorage` value for a settings key — `null` when never written. */
export async function readLocalStorageItem(page: Page, key: string): Promise<string | null> {
  return page.evaluate(k => window.localStorage.getItem(k), key);
}

/** Current value of a setting in the chrome.storage mirror the SW reads. */
export async function readMirroredSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate(
    k =>
      new Promise<unknown>(resolve => {
        chrome.storage.local.get([k], items => resolve(items?.[k] ?? null));
      }),
    key
  );
}

/**
 * Wait for a setting to reach `expected` in the chrome.storage mirror.
 *
 * This is the genuinely independent observable effect of flipping a toggle:
 * `mirrorSetting()` writes it fire-and-forget, the extension SERVICE WORKER (which
 * has no `localStorage`) reads it, and nothing about the localStorage write
 * guarantees it. Throws naming the last value it saw rather than returning quietly.
 */
export async function waitForMirroredSetting(
  page: Page,
  key: string,
  expected: boolean,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = '<never read>';
  while (Date.now() < deadline) {
    last = await readMirroredSetting(page, key);
    if (last === expected) return;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `waitForMirroredSetting("${key}"): chrome.storage.local never reached ${expected} within ${timeoutMs}ms ` +
      `(last value: ${JSON.stringify(last)}). This mirror — not localStorage — is what the extension ` +
      `service worker reads, so a setting that only lands in localStorage is invisible to background work.`
  );
}

/**
 * Click a ToggleSwitch in the OPEN general-settings drawer and confirm it flipped.
 *
 * `testID` is the `GeneralSettingsSelectors` value (e.g.
 * `'General Settings/AutoConsumeToggle'`), which `ToggleSwitch` now emits as a
 * data-testid on its invisible `<input>`.
 *
 * @returns the checked state after the click.
 */
export async function clickSettingToggle(
  wallet: ChromeWalletPageApi,
  testID: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const input = wallet.page.getByTestId(testID);
  try {
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const present = await wallet.page
      .locator('[data-testid^="General Settings/"]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-testid') ?? ''));
    throw new Error(
      `clickSettingToggle("${testID}"): no such toggle within ${timeoutMs}ms. ` +
        `Toggles present: ${JSON.stringify(present)}. (HapticFeedbackToggle only renders on mobile.)`
    );
  }

  const before = await input.isChecked();
  await input.click({ timeout: timeoutMs });
  try {
    await wallet.page.waitForFunction(
      ({ id, want }) => {
        const el = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
        return !!el && el.checked === want;
      },
      { id: testID, want: !before },
      { timeout: timeoutMs }
    );
  } catch {
    throw new Error(
      `clickSettingToggle("${testID}"): clicked the toggle but its checked state stayed ${before} ` +
        `after ${timeoutMs}ms — the click did not reach the input.`
    );
  }
  return !before;
}

/** Whether `<html>` currently carries the `.dark` class `applyTheme` toggles. */
export async function isDarkThemeApplied(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains('dark'));
}

/**
 * Click a theme tab in the OPEN general-settings drawer and wait for the theme
 * to actually be applied to `<html>`.
 *
 * `setTheme` both persists the choice and calls `applyTheme`, which adds/removes
 * `.dark` on the document element — the one settings control in the extension
 * with a real, immediately visible effect.
 *
 * `'system'` has no predictable class outcome (it resolves through
 * `prefers-color-scheme`), so that branch waits on the PERSISTED value instead,
 * which is deterministic. It never returns without a postcondition: a click that
 * missed, a disabled tab, or an off-by-one in `handleThemeTabChange`'s
 * index→theme map all have to surface here, not in whatever runs next.
 */
export async function selectTheme(
  wallet: ChromeWalletPageApi,
  theme: 'system' | 'light' | 'dark',
  timeoutMs = 15_000
): Promise<void> {
  const tab = wallet.page.getByTestId(`theme-${theme}`);
  try {
    await tab.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const present = await wallet.page
      .locator('[data-testid^="theme-"]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-testid') ?? ''));
    throw new Error(
      `selectTheme("${theme}"): no theme tab within ${timeoutMs}ms. Tabs present: ${JSON.stringify(present)}`
    );
  }
  await tab.click({ timeout: timeoutMs });

  if (theme === 'system') {
    try {
      await wallet.page.waitForFunction(key => window.localStorage.getItem(key) === 'system', THEME_SETTING_KEY, {
        timeout: timeoutMs
      });
    } catch {
      throw new Error(
        `selectTheme("system"): clicked the tab but localStorage["${THEME_SETTING_KEY}"] is ` +
          `${JSON.stringify(await readLocalStorageItem(wallet.page, THEME_SETTING_KEY))} after ${timeoutMs}ms — ` +
          `setTheme was never called, so the click never reached the tab.`
      );
    }
    return;
  }

  const wantDark = theme === 'dark';
  try {
    await wallet.page.waitForFunction(want => document.documentElement.classList.contains('dark') === want, wantDark, {
      timeout: timeoutMs
    });
  } catch {
    throw new Error(
      `selectTheme("${theme}"): clicked the tab but <html> still ` +
        `${wantDark ? 'lacks' : 'carries'} the "dark" class after ${timeoutMs}ms — ` +
        `the theme was persisted without being applied, or the tab click never landed.`
    );
  }
}

/** textContent that never throws, for use inside error messages. */
async function safeText(locator: Locator): Promise<string> {
  const text = await locator.textContent().catch(() => null);
  return JSON.stringify((text ?? '<unreadable>').slice(0, 400));
}

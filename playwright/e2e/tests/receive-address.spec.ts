/**
 * Receive screen: the QR and the copy button must both carry EXACTLY the
 * current account's address.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES
 *
 * `WalletPage.getAccountAddress` reads `receive-address-full` only as a DOM
 * FALLBACK after the store read succeeds, so on the happy path no spec ever even
 * opens `/receive`. Nothing asserts the QR, and nothing asserts the copy button.
 * A wallet that rendered a QR for a stale account, or copied the truncated
 * display string instead of the address, would pass the whole suite today —
 * and both bugs cost the user real money, because the QR and the copy button are
 * how an address gets handed to a sender.
 *
 * HOW THE QR IS CHECKED, AND WHY NOT A BITMAP DECODE
 *
 * There is no QR decoder in this repo: `qr-code-styling` is an encoder,
 * `qrcode`/`qrcode-generator` are transitive-only (not declared), `sharp` is a
 * rasterizer. A hand-rolled decoder is not viable either — the rendered SVG has
 * its centre modules punched out for the logo (`hideBackgroundDots`), so reading
 * it back needs Reed-Solomon recovery, not just module extraction.
 *
 * Rather than take a decode dependency, `components/QRCode.tsx` mirrors the
 * payload onto `data-qr-payload` from INSIDE the effect that calls
 * `qrCode.update(options)` — the only thing that ever repaints the encoder,
 * which is created once and never re-created. So the attribute reports that the
 * repaint effect RAN TO COMPLETION with this payload, not merely what the
 * component computed: drop the effect, or make `update()` throw, and the
 * attribute goes stale or absent instead of silently agreeing with a picture
 * nobody refreshed.
 *
 * Be precise about the limit, because the header above is easy to over-read:
 * if `update()` itself no-ops while the effect still completes, the attribute is
 * fresh and the picture is stale, and this spec is green. Decoding the bitmap is
 * the only thing that would close that gap, and it needs a decoder dependency.
 *
 * The payload is `miden:<address>`, NOT the bare address — `lib/qr/format.ts`
 * prefixes the BIP21-style scheme. Asserting `payload === publicKey` would fail
 * on a perfectly working wallet.
 */
import { expect, test } from '../fixtures/two-wallets';
import { ACCOUNT_ID_RE } from '../helpers/account-id';
import {
  MIDEN_URI_PREFIX,
  copyReceiveAddress,
  installClipboardRecorder,
  readReceiveSurface
} from '../helpers/contacts-receive-settings';

test.describe('Receive address surface', () => {
  test.describe.configure({ mode: 'serial' });

  test('QR encodes miden:<publicKey> and the copy button writes the bare publicKey', async ({ walletA, steps }) => {
    let publicKey: string;

    await steps.step('create_wallet', async () => {
      const { address } = await walletA.createNewWallet();
      publicKey = address;
      expect(publicKey).toMatch(ACCOUNT_ID_RE);
    });

    await steps.step('open_receive', async () => {
      // The recorder patches navigator.clipboard.writeText on every new document,
      // so it has to be installed BEFORE the navigation whose clicks it records.
      // Reading the real clipboard is not an option: the fixture launches two
      // headed contexts and grants no clipboard-read permission, and at most one
      // of them holds OS focus.
      await installClipboardRecorder(walletA.page);
      await walletA.navigateTo('/receive');
      await expect(walletA.page.getByTestId('receive-flow')).toBeVisible({ timeout: 30_000 });
    });

    await steps.step(
      'qr_and_address_match_the_account',
      async () => {
        const surface = await readReceiveSurface(walletA);

        // The sr-only untruncated address is the account address, exactly.
        expect(surface.addressText).toBe(publicKey!);
        // The QR payload is the BIP21-style URI over that same address, exactly.
        expect(surface.qrPayload).toBe(`${MIDEN_URI_PREFIX}${publicKey!}`);
        // …and the encoder actually painted. Exactly one SVG, not "at least one":
        // a re-render that appended a second QR is a bug too.
        expect(surface.qrSvgCount).toBe(1);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('copy_button_writes_the_address', async () => {
      const writes = await copyReceiveAddress(walletA);

      // The FIRST write, and only one: useCopyToClipboard latches `copied` for 2s
      // and makes a second click inside that window a no-op, so a spec that
      // re-clicked would assert against a write that never happened.
      expect(writes).toHaveLength(1);
      // The bare address — NOT the miden: URI (that is the QR's format) and NOT
      // the truncated string the button displays.
      expect(writes[0]).toBe(publicKey!);
    });
  });
});

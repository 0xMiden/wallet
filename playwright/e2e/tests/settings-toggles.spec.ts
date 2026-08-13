/**
 * General Settings: flipping a control must PERSIST and must have an
 * OBSERVABLE EFFECT.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES
 *
 * No spec has ever touched a settings toggle through the UI. The one place the
 * suite changes a setting — `send-public-local-prove.spec.ts` via
 * `setDelegateProofEnabled` — writes `localStorage` DIRECTLY, deliberately
 * bypassing the screen. So the toggle's click path, and `mirrorSetting()`'s
 * write into the chrome.storage mirror, are both untested. That mirror matters:
 * the extension SERVICE WORKER has no `localStorage`, so it reads background
 * settings (auto-consume, delegated proving) exclusively from the mirror. A
 * toggle that updated `localStorage` and not the mirror would look correct on
 * screen while background work kept using the old value — invisible to a user
 * and to every existing test.
 *
 * TWO CONTROLS, TWO KINDS OF EVIDENCE:
 *
 *   1. Auto-consume (a real ToggleSwitch). Persisted value = `localStorage`
 *      + the chrome.storage mirror; observable effect = the drawer, closed and
 *      genuinely remounted, renders the new state — which forces a fresh
 *      `isAutoConsumeEnabled()` read rather than the toggle's own local state.
 *   2. Theme. Persisted value = `localStorage['theme_setting']`; observable
 *      effect = the `dark` class `applyTheme` puts on `<html>`, and the fact
 *      that a reload re-applies it via `initTheme()`. This is the only settings
 *      control in the extension with a true visual consequence — the haptics
 *      toggle is mobile-only, and delegated proving / auto-consume only show up
 *      minutes later inside a transaction.
 */
import { expect, test } from '../fixtures/two-wallets';
import {
  clickSettingToggle,
  isDarkThemeApplied,
  openSettingsDrawer,
  readLocalStorageItem,
  reloadWallet,
  selectTheme,
  waitForMirroredSetting
} from '../helpers/contacts-receive-settings';

// GeneralSettingsSelectors.AutoConsumeToggle — an analytics label until
// ToggleSwitch started emitting `testID` as a data-testid too.
const AUTO_CONSUME_TOGGLE = 'General Settings/AutoConsumeToggle';
// lib/settings/constants.ts
const AUTO_CONSUME_KEY = 'auto_consume_setting';
const THEME_KEY = 'theme_setting';

test.describe('General Settings toggles', () => {
  test.describe.configure({ mode: 'serial' });

  test('auto-consume toggle persists to localStorage AND the service-worker mirror', async ({ walletA, steps }) => {
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    const toggle = () => walletA.page.getByTestId(AUTO_CONSUME_TOGGLE);

    await steps.step('toggle_starts_on', async () => {
      await openSettingsDrawer(walletA, 'general-settings');
      // DEFAULT_AUTO_CONSUME is true and nothing else in the app writes this key,
      // so a fresh wallet must render it enabled.
      await expect(toggle()).toBeChecked();
    });

    await steps.step(
      'turning_it_off_persists_both_ways',
      async () => {
        const nowChecked = await clickSettingToggle(walletA, AUTO_CONSUME_TOGGLE);
        expect(nowChecked).toBe(false);
        await expect(toggle()).not.toBeChecked();

        // setSetting() stores JSON, so the raw cell is the string "false".
        expect(await readLocalStorageItem(walletA.page, AUTO_CONSUME_KEY)).toBe('false');
        // The independent surface: what the service worker actually reads.
        await waitForMirroredSetting(walletA.page, AUTO_CONSUME_KEY, false);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('reopening_the_drawer_still_reads_off', async () => {
      // openSettingsDrawer bounces through home first, so Settings genuinely
      // unmounts and GeneralSettings re-runs isAutoConsumeEnabled() at mount.
      // Without that bounce this would just be re-reading the ToggleSwitch's own
      // component-local state, which flips on click whether or not anything was
      // persisted.
      await openSettingsDrawer(walletA, 'general-settings');
      await expect(toggle()).not.toBeChecked();
    });

    await steps.step('turning_it_back_on_persists_both_ways', async () => {
      const nowChecked = await clickSettingToggle(walletA, AUTO_CONSUME_TOGGLE);
      expect(nowChecked).toBe(true);

      expect(await readLocalStorageItem(walletA.page, AUTO_CONSUME_KEY)).toBe('true');
      await waitForMirroredSetting(walletA.page, AUTO_CONSUME_KEY, true);

      await openSettingsDrawer(walletA, 'general-settings');
      await expect(toggle()).toBeChecked();
    });
  });

  test('theme selector applies the dark class and survives a reload', async ({ walletA, steps }) => {
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    await steps.step(
      'choosing_dark_applies_and_persists',
      async () => {
        await openSettingsDrawer(walletA, 'general-settings');
        await selectTheme(walletA, 'dark');

        expect(await isDarkThemeApplied(walletA.page)).toBe(true);
        // setThemeSetting writes the raw enum value, not JSON.
        expect(await readLocalStorageItem(walletA.page, THEME_KEY)).toBe('dark');
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('dark_survives_a_full_page_load', async () => {
      // A REAL document reload, not a hash nav: fullpage.tsx calls initTheme() at
      // module scope, so only a new document proves the choice was persisted
      // rather than merely painted onto the live DOM.
      await reloadWallet(walletA);
      expect(await isDarkThemeApplied(walletA.page)).toBe(true);
      expect(await readLocalStorageItem(walletA.page, THEME_KEY)).toBe('dark');
    });

    await steps.step('choosing_light_removes_it_again', async () => {
      await openSettingsDrawer(walletA, 'general-settings');
      await selectTheme(walletA, 'light');

      expect(await isDarkThemeApplied(walletA.page)).toBe(false);
      expect(await readLocalStorageItem(walletA.page, THEME_KEY)).toBe('light');

      await reloadWallet(walletA);
      expect(await isDarkThemeApplied(walletA.page)).toBe(false);
      expect(await readLocalStorageItem(walletA.page, THEME_KEY)).toBe('light');
    });
  });
});

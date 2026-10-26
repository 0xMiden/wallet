import type { TestInfo } from '@playwright/test';

import { HarnessFault } from './dapp-cells';
import type { CommandServer, CommandResult } from './dapp-command-server';
import type { MobileSurface, NativeKeyboardControls, NativeKeyboardLayout } from './dapp-mobile-device';

const INPUT_LABEL = 'Keyboard input';
const INPUT_VALUE = 'Native typing 1837';
const KEYBOARD_STABILITY_MS = 1_000;
const KEYBOARD_WAIT_ATTEMPTS = 12;
const PAGE_STATE_TIMEOUT_MS = 15_000;
const TYPED_VALUE_WAIT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type NativeKeyboardDevice = NativeKeyboardControls;
type PageCommandSender = Pick<CommandServer, 'send'>;
type ScreenshotWallet = { screenshot(options: { path: string }): Promise<void> };

export interface NativeKeyboardJourneyInput {
  surface: MobileSurface;
  device: NativeKeyboardDevice;
  page: PageCommandSender;
  wallet: ScreenshotWallet;
  testInfo: Pick<TestInfo, 'outputPath' | 'attach'>;
}

function assertFieldAboveKeyboard(layout: NativeKeyboardLayout): void {
  const { fieldFrame: field, webViewFrame: webView, keyboardTop } = layout;
  if (field === null || webView === null || keyboardTop === null) {
    throw new HarnessFault(`native keyboard geometry is incomplete: ${JSON.stringify(layout)}`);
  }
  const fieldRight = field.x + field.width;
  const fieldBottom = field.y + field.height;
  const webViewRight = webView.x + webView.width;
  const webViewBottom = webView.y + webView.height;
  const insideWebView =
    field.x >= webView.x && field.y >= webView.y && fieldRight <= webViewRight && fieldBottom <= webViewBottom;
  if (!insideWebView || fieldBottom > keyboardTop) {
    throw new HarnessFault(`the focused input is not fully visible above the keyboard: ${JSON.stringify(layout)}`);
  }
}

function formState(result: CommandResult): { activeField: unknown; inputValue: unknown; viewport: unknown } {
  if (result.status !== 'ok') {
    throw new HarnessFault(
      result.status === 'error'
        ? `the dApp page state command failed: ${result.error.name}: ${result.error.message}`
        : 'the dApp page state command timed out'
    );
  }
  const value = result.value;
  const form = typeof value === 'object' && value !== null ? Reflect.get(value, 'form') : undefined;
  const viewport = typeof value === 'object' && value !== null ? Reflect.get(value, 'viewport') : undefined;
  return {
    activeField: typeof form === 'object' && form !== null ? Reflect.get(form, 'activeField') : undefined,
    inputValue: typeof form === 'object' && form !== null ? Reflect.get(form, 'inputValue') : undefined,
    viewport
  };
}

async function waitForKeyboard(device: NativeKeyboardDevice): Promise<NativeKeyboardLayout> {
  let latest: NativeKeyboardLayout | undefined;
  for (let attempt = 0; attempt < KEYBOARD_WAIT_ATTEMPTS; attempt += 1) {
    latest = await device.keyboardLayout('A', INPUT_LABEL);
    if (latest.fieldFrame === null) {
      throw new HarnessFault(`native accessibility did not expose the ${INPUT_LABEL} field`);
    }
    if (latest.keyboardVisible) {
      assertFieldAboveKeyboard(latest);
      return latest;
    }
    await sleep(250);
  }
  throw new HarnessFault(`the keyboard did not become visible: ${JSON.stringify(latest)}`);
}

/** Android delivers `input text` key events after the command returns, so the page can still be mid-string. */
async function waitForTypedValue(page: PageCommandSender): Promise<void> {
  const deadline = Date.now() + TYPED_VALUE_WAIT_MS;
  for (;;) {
    const state = formState(await page.send('A', 'one', '__state', {}, PAGE_STATE_TIMEOUT_MS));
    if (state.activeField === INPUT_LABEL && state.inputValue === INPUT_VALUE) return;
    if (Date.now() >= deadline) {
      throw new HarnessFault(
        `native typing did not reach the focused dApp input: ${JSON.stringify({ ...state, expectedValue: INPUT_VALUE })}`
      );
    }
    await sleep(500);
  }
}

async function waitForKeyboardDismissed(device: NativeKeyboardDevice): Promise<NativeKeyboardLayout> {
  let latest: NativeKeyboardLayout | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    latest = await device.keyboardLayout('A', INPUT_LABEL);
    if (!latest.keyboardVisible) return latest;
    await sleep(250);
  }
  throw new HarnessFault(`the keyboard remained visible after dismissal: ${JSON.stringify(latest)}`);
}

async function attachFailureScreenshot(input: NativeKeyboardJourneyInput): Promise<string | null> {
  const screenshotPath = input.testInfo.outputPath(`dapp-keyboard-${input.surface}-failure.png`);
  try {
    await input.wallet.screenshot({ path: screenshotPath });
    await input.testInfo.attach(`dApp keyboard ${input.surface} failure`, {
      path: screenshotPath,
      contentType: 'image/png'
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runNativeKeyboardJourney(input: NativeKeyboardJourneyInput): Promise<void> {
  let tapped = false;
  let dismissed = false;
  let latest: NativeKeyboardLayout | undefined;
  try {
    await input.device.tapAccessibilityLabel('A', INPUT_LABEL);
    tapped = true;
    latest = await waitForKeyboard(input.device);
    await sleep(KEYBOARD_STABILITY_MS);
    latest = await input.device.keyboardLayout('A', INPUT_LABEL);
    if (!latest.keyboardVisible)
      throw new HarnessFault('the keyboard did not remain visible during the stability wait');
    assertFieldAboveKeyboard(latest);

    await input.device.typeText('A', INPUT_VALUE);
    await waitForTypedValue(input.page);
    latest = await input.device.keyboardLayout('A', INPUT_LABEL);
    if (!latest.keyboardVisible) throw new HarnessFault('the keyboard became hidden while typing');
    assertFieldAboveKeyboard(latest);

    const focusedPath = input.testInfo.outputPath(`dapp-keyboard-${input.surface}-focused.png`);
    await input.wallet.screenshot({ path: focusedPath });
    await input.testInfo.attach(`dApp keyboard ${input.surface} focused`, {
      path: focusedPath,
      contentType: 'image/png'
    });

    await input.device.dismissKeyboard('A');
    latest = await waitForKeyboardDismissed(input.device);
    dismissed = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const screenshotError = await attachFailureScreenshot(input);
    if (tapped && !dismissed) await input.device.dismissKeyboard('A').catch(() => undefined);
    const diagnostics = latest === undefined ? '' : ` Native layout: ${JSON.stringify(latest)}.`;
    const screenshot = screenshotError === null ? '' : ` Screenshot capture failed: ${screenshotError}.`;
    throw new HarnessFault(`native keyboard journey failed on ${input.surface}: ${reason}.${diagnostics}${screenshot}`);
  }
}

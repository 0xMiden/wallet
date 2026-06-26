import { useEffect, useState } from 'react';

import { isExtension } from 'lib/platform';

/**
 * Onboarding → side panel handoff.
 *
 * At the end of onboarding the user clicks "Get started", which kicks off a
 * multi-second `registerWallet()` (WASM account creation). We want to drop the
 * finished wallet into the Chrome side panel and close the fullscreen
 * onboarding tab — and make the side panel the primary action surface going
 * forward (same `sidepanel_mode` the Header "maximise view" toggle uses).
 *
 * The catch: `chrome.sidePanel.open()` only works inside a live user gesture,
 * and the gesture dies across `await register()`. So we open the panel
 * synchronously in the click (`beginSidePanelHandoff`) BEFORE the slow await,
 * leaving a `onboarding_handoff` flag so the freshly-opened panel shows a
 * "Setting up…" screen instead of its own Welcome (see useOnboardingHandoff +
 * PageRouter). Once the account is Ready we close the onboarding tab
 * (`finishSidePanelHandoff`).
 */

const HANDOFF_FLAG = 'onboarding_handoff';
const SIDEPANEL_MODE_FLAG = 'sidepanel_mode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChromeApi = any;

function getChrome(): ChromeApi | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromeApi = (globalThis as any).chrome;
  return chromeApi;
}

/** True when this build can hand off onboarding to a Chrome side panel. */
export function canHandoffToSidePanel(): boolean {
  const chromeApi = getChrome();
  return Boolean(isExtension() && chromeApi?.sidePanel?.open && chromeApi?.windows?.getLastFocused);
}

/**
 * Open the side panel for the focused window and enable side-panel mode — must
 * be called synchronously within the final "Get started" click so the user
 * gesture is still live. Returns true if the panel was opened (Chrome), false
 * otherwise (caller should fall back to in-tab navigation).
 */
export async function beginSidePanelHandoff(): Promise<boolean> {
  const chromeApi = getChrome();
  if (!canHandoffToSidePanel()) return false;

  try {
    // Flag first so the panel reads it the moment it boots (before Ready).
    await chromeApi.storage.local.set({ [HANDOFF_FLAG]: true, [SIDEPANEL_MODE_FLAG]: true });
    // Route the toolbar icon to the side panel from now on (primary surface).
    await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    chromeApi.action.setPopup({ popup: '' });
    // Open it now, while the click's user activation is still valid.
    const win = await chromeApi.windows.getLastFocused();
    await chromeApi.sidePanel.open({ windowId: win.id });
    return true;
  } catch (err) {
    console.warn('[side-panel-handoff] begin failed, reverting to in-tab onboarding:', err);
    await abortSidePanelHandoff();
    return false;
  }
}

/**
 * Clear the handoff flag and close the onboarding tab now that the wallet is
 * Ready. Returns true if the tab was closed; false if it was the window's last
 * tab (closing it would also close the side panel) — the caller should then
 * navigate the tab to the wallet home instead.
 */
export async function finishSidePanelHandoff(): Promise<boolean> {
  const chromeApi = getChrome();
  if (!chromeApi?.tabs) return false;

  try {
    await chromeApi.storage.local.set({ [HANDOFF_FLAG]: false });
    const current = await chromeApi.tabs.getCurrent();
    if (!current?.id) return false;
    // Don't orphan the window: closing the last tab would close the side panel
    // with it. Leave the tab for the caller to repurpose in that rare case.
    const tabsInWindow = await chromeApi.tabs.query({ windowId: current.windowId });
    if (Array.isArray(tabsInWindow) && tabsInWindow.length <= 1) return false;
    await chromeApi.tabs.remove(current.id);
    return true;
  } catch (err) {
    console.warn('[side-panel-handoff] finish failed:', err);
    return false;
  }
}

/**
 * Undo a handoff: clear the flag and restore popup mode. Used when account
 * creation fails after the panel was already opened, so the user isn't left
 * with an empty side panel and a popup-less toolbar icon.
 */
export async function abortSidePanelHandoff(): Promise<void> {
  const chromeApi = getChrome();
  if (!chromeApi?.storage) return;

  try {
    await chromeApi.storage.local.set({ [HANDOFF_FLAG]: false, [SIDEPANEL_MODE_FLAG]: false });
    chromeApi.action?.setPopup?.({ popup: 'popup.html' });
    chromeApi.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
  } catch (err) {
    console.warn('[side-panel-handoff] abort failed:', err);
  }
}

/**
 * Read the `onboarding_handoff` flag reactively. The side panel uses this to
 * show a "Setting up…" screen instead of its own Welcome while the onboarding
 * tab finishes creating the account. Returns false outside the extension.
 */
export function useOnboardingHandoff(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const chromeApi = getChrome();
    if (!isExtension() || !chromeApi?.storage?.local) return;

    let cancelled = false;
    chromeApi.storage.local.get(HANDOFF_FLAG, (res: Record<string, unknown>) => {
      if (!cancelled) setActive(Boolean(res?.[HANDOFF_FLAG]));
    });

    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string): void => {
      if (areaName === 'local' && HANDOFF_FLAG in changes) {
        setActive(Boolean(changes[HANDOFF_FLAG]?.newValue));
      }
    };
    chromeApi.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chromeApi.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return active;
}

/** Best-effort clear of the handoff flag (e.g. once the panel reaches Ready). */
export function clearOnboardingHandoff(): void {
  const chromeApi = getChrome();
  chromeApi?.storage?.local?.set?.({ [HANDOFF_FLAG]: false });
}

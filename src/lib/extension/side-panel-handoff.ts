import { isExtension } from 'lib/platform';

/**
 * Onboarding → side panel handoff (Chrome).
 *
 * The wallet is created first (the onboarding tab spins through
 * `registerWallet()`), and only once it's Ready does the final "Open wallet"
 * click open the side panel onto the finished wallet and close the onboarding
 * tab. Opening the panel from that post-Ready click keeps it inside a live user
 * gesture — `chrome.sidePanel.open()` requires one, and creating the wallet
 * first means there's no multi-second await between the click and the open to
 * outlive the gesture. The side panel also becomes the primary surface (the
 * same `sidepanel_mode` the Header "maximise view" toggle uses), so clicking
 * the toolbar icon opens it instead of the popup.
 */

const SIDEPANEL_MODE_FLAG = 'sidepanel_mode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChromeApi = any;

function getChrome(): ChromeApi | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

/**
 * True when this build should hand onboarding off to a Chrome side panel.
 * Disabled under E2E so the test harness keeps the classic in-tab flow (its
 * onboarding driver clicks "Get started" and expects an in-tab wallet, not a
 * panel that closes the tab).
 */
export function canHandoffToSidePanel(): boolean {
  if (process.env.MIDEN_E2E_TEST === 'true') return false;
  const chromeApi = getChrome();
  return Boolean(isExtension() && chromeApi?.sidePanel?.open && chromeApi?.windows?.getLastFocused);
}

/**
 * Open the side panel onto the (already-Ready) wallet and make it the primary
 * action surface. MUST be called synchronously within the user gesture of the
 * final "Open wallet" click. Returns true if the panel opened; false (with
 * popup mode restored) on failure so the caller can fall back to in-tab nav.
 */
export async function openSidePanelToWallet(): Promise<boolean> {
  const chromeApi = getChrome();
  if (!canHandoffToSidePanel()) return false;

  try {
    await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    chromeApi.action.setPopup({ popup: '' });
    await chromeApi.storage.local.set({ [SIDEPANEL_MODE_FLAG]: true });
    const win = await chromeApi.windows.getLastFocused();
    await chromeApi.sidePanel.open({ windowId: win.id });
    return true;
  } catch (err) {
    console.warn('[side-panel-handoff] open failed, falling back to in-tab:', err);
    // Roll back the primary-surface switch so the toolbar icon still works.
    try {
      chromeApi.action?.setPopup?.({ popup: 'popup.html' });
      await chromeApi.storage?.local?.set?.({ [SIDEPANEL_MODE_FLAG]: false });
      chromeApi.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
    } catch {
      // best-effort rollback
    }
    return false;
  }
}

/**
 * Close the onboarding tab once the side panel has taken over. Returns false if
 * it's the window's last tab (closing it would also close the panel) so the
 * caller can navigate that tab to the wallet home instead.
 */
export async function closeOnboardingTab(): Promise<boolean> {
  const chromeApi = getChrome();
  if (!chromeApi?.tabs) return false;

  try {
    const current = await chromeApi.tabs.getCurrent();
    if (!current?.id) return false;
    const tabsInWindow = await chromeApi.tabs.query({ windowId: current.windowId });
    if (Array.isArray(tabsInWindow) && tabsInWindow.length <= 1) return false;
    await chromeApi.tabs.remove(current.id);
    return true;
  } catch (err) {
    console.warn('[side-panel-handoff] close tab failed:', err);
    return false;
  }
}

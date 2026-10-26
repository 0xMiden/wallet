import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

import { isIOS, isMobile } from 'lib/platform';
import { isHapticFeedbackEnabled } from 'lib/settings/helpers';

/**
 * Haptic feedback utilities for mobile.
 * All functions are safe to call on non-mobile platforms (they no-op).
 */

/**
 * Light impact - for button taps, selections
 */
export const hapticLight = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Medium impact - for toggles, significant actions
 */
export const hapticMedium = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Heavy impact - for destructive actions, important confirmations
 */
export const hapticHeavy = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy });
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Success notification - for completed transactions, successful operations
 */
export const hapticSuccess = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Warning notification - for warnings, requires attention
 */
export const hapticWarning = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.notification({ type: NotificationType.Warning });
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Error notification - for failed operations, errors
 */
export const hapticError = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    await Haptics.notification({ type: NotificationType.Error });
  } catch {
    // Ignore errors on unsupported devices
  }
};

// Both native plugins ignore selectionChanged until selectionStart, but only iOS is started here:
// Android's selection effect is a 100 ms vibration, so Android is left as it was on purpose.
// Set after the start resolves so a failure retries.
let selectionStarted = false;

/**
 * Selection changed - for picker changes, list selections
 */
export const hapticSelection = async () => {
  if (!isMobile() || !isHapticFeedbackEnabled()) return;
  try {
    if (isIOS() && !selectionStarted) {
      await Haptics.selectionStart();
      selectionStarted = true;
    }
    await Haptics.selectionChanged();
  } catch {
    // Ignore errors on unsupported devices
  }
};

/**
 * Semantic aliases for the dApp browser drag/bubble interactions.
 * These map to existing impact styles but communicate intent at the call site.
 */

/**
 * Drag-to-minimize crosses the commit threshold — the drag is now committed to a snap.
 */
export const hapticDragSnap = hapticMedium;

/**
 * Floating bubble lands on a corner after a drag (magnetic snap).
 */
export const hapticBubbleAttach = hapticMedium;

/**
 * Floating bubble released into the discard zone (about to close).
 */
export const hapticBubbleRelease = hapticHeavy;

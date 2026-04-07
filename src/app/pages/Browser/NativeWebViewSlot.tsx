/**
 * Invisible HTML element whose bounding rect tells the native dApp webview
 * where to render. The `useDappWebView` hook reads `slotRef.current.getBoundingClientRect()`
 * and forwards it to `InAppBrowser.updateDimensions` whenever the rect changes.
 *
 * The slot itself doesn't render any pixels — it's a layout placeholder. The
 * actual dApp content is drawn by the native WKWebView/WebView at the slot's
 * coordinates, sitting visually "underneath" the React capsule and tabbar.
 *
 * Pointer events are disabled so taps in the slot area fall through to the
 * native webview underneath via the plugin's PassThroughView (iOS) and
 * FLAG_NOT_TOUCH_MODAL (Android).
 */

import React, { forwardRef } from 'react';

interface NativeWebViewSlotProps {
  className?: string;
}

export const NativeWebViewSlot = forwardRef<HTMLDivElement, NativeWebViewSlotProps>(({ className }, ref) => {
  return (
    <div
      ref={ref}
      className={className}
      style={{
        flex: 1,
        // Don't draw anything; let the native webview show through.
        pointerEvents: 'none'
      }}
      aria-hidden="true"
    />
  );
});

NativeWebViewSlot.displayName = 'NativeWebViewSlot';

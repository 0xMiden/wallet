# Android Navbar Overlay

Android port of `packages/dapp-browser/ios/Sources/InAppBrowserPlugin/WKWebViewController.swift:MidenNavbarOverlayWindow`. Renders the wallet's bottom navigation as a native floating pill that sits above both the Capacitor WebView and every `WebViewDialog` (foreground dApp).

## Why a two-instance architecture

On iOS, `MidenNavbarOverlayWindow` is a `UIWindow` at `windowLevel = .normal + 200`. iOS z-orders windows automatically, so the pill always sits above the dApp's UIWindow (also `.normal`) without any intervention.

Android has no equivalent "layered window" primitive that works across Dialogs:
- `TYPE_APPLICATION_OVERLAY` — requires `SYSTEM_ALERT_WINDOW` permission, user-facing consent, reserved for whole-system overlays. Not acceptable.
- `TYPE_APPLICATION_PANEL` / `_SUB_PANEL` — sub-window types that stack above their parent window, but the parent is a token reference. When a new Dialog opens with its own token, the sub-window stays attached to the Activity and is covered by the Dialog.
- Moving a single View between Activity DecorView and Dialog DecorView — technically possible but re-parenting mid-frame can flicker and leaves observers in an inconsistent intermediate state.

The architecture that actually works reliably: **two View instances sharing a single state holder**. One NavbarView lives in the Activity DecorView; another fresh NavbarView is created and attached to each WebViewDialog's DecorView at show-time, then destroyed on dismiss. Both instances observe the same `NavbarStateHolder` so a single plugin mutation propagates to whichever instance is currently frontmost. `NavbarOverlayManager.refreshVisibility()` arbitrates which instance is `VISIBLE` and which is `GONE` based on a dialog stack.

## File layout

| File | Role |
|---|---|
| `NavbarState.java` | Immutable state snapshot. POJOs for Item, Action, and the top-level state holder. Produced via `with...` copy helpers. |
| `NavbarStateHolder.java` | Observer-pattern wrapper around a `NavbarState`. Mutations call `setState()`, which broadcasts to every attached observer. |
| `NavbarOverlayManager.java` | Top-level coordinator. Owns the state holder, lazily creates the Activity view, manages the Dialog-view stack via `onDialogShown()` / `onDialogDismissed()`, and forwards button taps back to the plugin via the `TapCallback` interface. |
| `NavbarView.java` | The actual FrameLayout hierarchy. Subscribes to the state holder on construction, unsubscribes on detach. Handles window insets, spring animations, and the compact-mode layout flip. |
| `NavbarButton.java` | Main-row button (Home/Activity/Browser). Fixed 60dp height. Flips between default mode (icon + label stacked) and compact mode (icon-only, larger). |
| `NavbarSecondaryButton.java` | Secondary-row button (Send/Receive/Settings). 32dp height, inline icon + label. Pale slate active background. |
| `NavbarActionButton.java` | Compact-mode primary action (e.g. Continue). 34dp visible pill height via 13dp top/bottom inset inside the 60dp cell — this matches the compact-mode icon height so the action pill and icons read as the same row size. |

## State flow

```
┌──────────────────────────────────────────────────────┐
│                InAppBrowserPlugin                    │
│  @PluginMethod showNativeNavbar / setNavbarAction    │
│  / setNavbarSecondaryRow / morphNavbarOut / …        │
└──────────────────┬───────────────────────────────────┘
                   │ manager.show() / setAction() / …
                   ▼
┌──────────────────────────────────────────────────────┐
│              NavbarOverlayManager                    │
│  - owns NavbarStateHolder                            │
│  - owns activityView + dialogStack                   │
│  - stateHolder.setState(newState) on each mutation   │
└──────────────────┬───────────────────────────────────┘
                   │ observer fanout
                   ▼
┌──────────────────────────────────────────────────────┐
│      NavbarView (1 per Activity/Dialog)              │
│  - onStateChanged(state) rebuilds main row,          │
│    secondary row, action button, morph state         │
│  - Only one instance is VISIBLE at a time            │
└──────────────────────────────────────────────────────┘
```

Taps flow the other direction: `NavbarButton.onClickListener` → `manager.dispatchItemTap(id)` → `TapCallback.onItemTap(id)` → `InAppBrowserPlugin.notifyListeners("nativeNavbarTap", {id})` → JS listeners in `DappBrowserProvider.tsx`.

## Gotchas

1. **Don't use `MATCH_PARENT` children in `WRAP_CONTENT` FrameLayouts for backgrounds.** The measure pass inflates the parent to the ancestor's AT_MOST (screen size), producing buttons ~1900px tall. Use `setBackground(drawable)` on the button itself instead — commit `64145d74` details. `NavbarButton.setActive()` toggles the background drawable; no child view needed.

2. **`Dialog.getWindow().setLayout(MATCH_PARENT, MATCH_PARENT)` must run AFTER `setContentView()`.** Otherwise the default `wrap_content center` wins and the Dialog renders as a tiny centered blob. Also set `WindowManager.LayoutParams.width/height` directly as belt-and-suspenders.

3. **Android's `setRenderEffect(createBlurEffect(...))` blurs the view's OWN contents, not what's behind it.** There's no clean backdrop-blur primitive for a decor-view child. We accept the platform difference and use a solid translucent pill — reads as a native Android Material surface.

4. **Elevation needs an outline.** The shadow is rendered from the view's outline provider, which defaults to the background drawable's shape. `shadowWrap` has no background so its elevation does nothing — the elevation has to live on `blurContainer` (which has the rounded-pill background). `shadowWrap` still needs `setClipChildren(false)` + `setClipToPadding(false)` or the shadow is cropped by its own bounds.

5. **`NavbarButton` is pinned to 60dp.** `setMinimumHeight(60dp)` is critical — without it, compact mode's center-pinned 32dp icon + still-present label constraints would push the button to 92dp, growing the whole toolbar when Continue kicks in. Matches the iOS fix documented at `WKWebViewController.swift:NavbarButton.buttonHeight = 60`.

6. **Compact mode state survives rebuilds.** `rebuildMainRow()` creates fresh NavbarButton instances (default = not compact). If the state changes while already in compact mode (e.g. `setNavbarAction({enabled:false})` while Continue is showing), the fresh buttons would revert unless we carry the flag. `rebuildMainRow` now reads `this.compactMode` and applies it to each new button.

7. **Icon name mapping.** The JS side sends iOS `sfSymbol` names (e.g. `house.fill`). Both `NavbarButton` and `NavbarSecondaryButton` have a `resolveIconResource()` switch that maps each SF Symbol name to a bundled Material Icons vector drawable in `res/drawable/nav_*.xml`.

## Testing patterns

End-to-end testing via ADB + a CDP bridge to the Android WebView works well:

```bash
# Forward Android WebView devtools port
PID=$(adb shell ps | grep com.miden.wallet | awk '{print $2}')
adb forward tcp:9334 localabstract:webview_devtools_remote_${PID}
curl -s http://localhost:9334/json  # list inspectable pages
```

Then drive plugin methods directly from JS via a CDP daemon (see `/tmp/cdp-daemon-android.mjs` during the original port). This bypasses the wallet's route gating, so you can test the plugin API without onboarding the wallet.

See also: `android logcat -t 100 | grep Navbar` — every major state transition logs to logcat at Debug level.

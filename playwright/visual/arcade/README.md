# Arcade sheet layout regression

The fixture renders the real `ArcadeLanding`, `Drawer`, `DetailCard`, `Notice`, and `Button`,
with synthetic catalog data and the shipped fonts, theme tokens, and translations.
Only navigation, native back/navbar hooks, haptics, and error telemetry are replaced.
The Open game callback is inert; no wallet, connection, or transaction is involved.

`yarn playwright test --config playwright.arcade-visual.config.ts` checks equal horizontal
button margins, the shared 370px cap, 48px height, footer clearance, and screenshots at
320, 360, 402, 440, and 768px in both themes with short and wrapping content. This runs in
PR CI. Local web review uses the laptop's existing default Chrome connection.

The previous layout has 16px left / 54px right margins at 440px. The fixed layout has
35px on both sides. At 320px it remains 288px wide with 16px margins.

Native validation uses these built fixture assets inside the repository's Capacitor iOS
shell on a fresh simulator, through `playwright/e2e/ios/helpers/cdp-bridge.ts` and `simctl`
screenshots. The native matrix varies the WKWebView viewport across the same widths,
checks both themes/content lengths, and verifies the retained bottom safe-area padding.
This verifies layout rather than wallet or game-launch integration.

`native-after.png` contains only synthetic fixture state on iPhone 17 Pro / iOS 26.5.

# Bridge route availability previews

Fixture-based Chromium renders at 390 × 844 CSS pixels (2× scale), using the real Route component, wallet CSS, fonts and English localization. `before.png` uses main at 8c6a705fc; `after.png` uses this change. Both select Agglayer with Epoch disabled. `both-unavailable-dark.png` disables both routes and Continue.

The local render harness mocks wallet state, native boundaries, animation hooks and SVG imports. The shell heading and preview label are fixture scaffolding; the route cards, notice and Continue button are production components. These images verify presentation only, not Mainnet acceptance or transaction execution. No transactions were submitted.

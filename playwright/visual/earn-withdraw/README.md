# Earn withdrawal visual fixture

This fixture renders the production position, amount, review and withdrawal status components with mocked positions, quotes and transaction rows. It cannot sign or submit transactions. Confirm only changes the local route. Bread components and production CSS supply the visuals.

Build and serve the fixture from the wallet worktree (the extension SVG plugin supports the build pipeline):

```sh
yarn vite build --config playwright/visual/earn-withdraw/vite.config.mts
yarn vite preview --config playwright/visual/earn-withdraw/vite.config.mts --host 127.0.0.1 --port 5189 --strictPort
```

Routes:

- `/earn/positions/position-1`: position detail
- `/earn/positions/position-1/withdraw`: amount entry and Max
- `/earn/positions/position-1/withdraw/review?amount=2.25`: partial review; the unsigned fixture quote expires after 60 seconds
- Add `&quoteError` to review for a quote failure
- `/earn/withdraw-status/fixture-withdrawal?phase=prepared`: checking
- Status phases `redeeming`, `delivering`, `received` and `failed` display the other mocked states
- Add `?remaining` to position or amount entry to display the mocked residual 7.873456789012345678 USDC
- Add `dark` to the query to enable dark appearance on page load

Browser captures are in `../evidence/screenshots` relative to the wallet worktree. `index.html` is the full-resolution gallery; `manifest.json` records viewports. Captures include 393×852 iPhone-sized, 360×800 Android-sized and 360×640 extension-sized views, light and dark. Long amounts retain all digits in the horizontally scrollable canonical input; review wraps the exact value.

These are browser viewport checks using local mocked services. They do not establish native keyboard/safe-area behavior, native iOS/Android simulator acceptance or live end-to-end transaction acceptance. No native simulator or other worktree was operated.

UX follow-up: the fixture now uses production FullScreenPage and AwaitFonts (Inter and Nunito, with the app antialiasing classes). Revised captures are in ../evidence/screenshots-ux; prior captures are retained as historical comparisons. Fonts are verified in screenshots-ux/fonts.json. Main review is receipt first with a collapsed canonical DetailDisclosure. Max displays a readable amount plus an explicit full-balance label; submission retains its exact snapshot.

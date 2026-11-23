# One Click visual fixture

This fixture renders production transaction and bridge review components with fixed data. It has no wallet provider, signer, quote service, or transaction capability. It no longer has 1Click screens: the 1Click route left Swap, and its Receive tab has no capture here yet.

The transaction routes render the production `DappConfirmationModal`, `TransactionAssetView` and raw-details disclosure with a fixed note flow. The main case shows zero inputs and three outputs: a fee note, P2ID and PSWAP. The partial case shows one readable input of two, a custom script and storage slot changes. The asset view is constrained to 380 CSS pixels to exercise the extension popup width. Each route captures its top and scrolled bottom in mobile and desktop light and dark themes; the raw disclosure has a separate capture. Faucet metadata comes from a fixture module; the route cannot submit a transaction.

Run the visual capture in CI with:

```sh
yarn playwright test --config playwright.one-click-visual.config.ts
```

Screenshots are saved under `test-results/one-click-visual`. The fixed viewport is 393×852 CSS pixels. This fixture checks browser layout and copy; it does not establish native keyboard, safe-area, or live settlement behavior.

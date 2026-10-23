# One Click visual fixture

This fixture renders the production amount and review components with fixed wallet data and a signed-quote-shaped fixture. It has no wallet provider, signer, quote service, or transaction capability. The amount screenshot also checks that a saved contact for another network is hidden.

Run the visual capture in CI with:

```sh
yarn playwright test --config playwright.one-click-visual.config.ts
```

Screenshots are saved under `test-results/one-click-visual`. The fixed viewport is 393×852 CSS pixels. This fixture checks browser layout and copy; it does not establish native keyboard, safe-area, or live settlement behavior.

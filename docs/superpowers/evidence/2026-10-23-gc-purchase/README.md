# Coins purchase-entry UI evidence

These are labeled browser fixtures rendering the actual Coins card, shared page frame and footer,
with a fictional 10-GC balance. They show no personal account or simulator data and perform no network
writes. They are not proof of a live balance, registration gift, purchase or native-device behavior.

- [Light, 393 × 852](coins-light.png)
- [Dark, 320 × 640](coins-dark-narrow.png)

Observed: balance/network label, disabled Buy more GC, unavailable explanation and Browse games footer
and fixed 1-USDCx/1,000-GC package remain visible without horizontal overflow. No weekly allowance, claim/reset or countdown appears.

215 focused Jest tests across 18 suites passed, including a persisted ordinary network choice,
custom/mid-read endpoint refusal, wrong-network/unread balance, known empty vault and real-format
Bech32 issuer row. Saved-choice and Bech32 regressions were reproduced before their fixes. These checks
cover balance display and retained protocol regression, not a live purchase route.

The full noncoverage Jest attempt was stopped before completion while adjusting the branch base;
it is not counted as a passing full suite. Current-head CI remains a separate gate. No local coverage
run was performed. Native/extension interactive purchase acceptance is absent; local Android remains
skipped. No simulator reinstall or transaction occurred for this UI change.

TypeScript, changed-file lint, i18n lint, 14-locale flat/source consistency and mobile/extension
background/UI Vite builds passed. Independent source review found one saved-network-choice issue,
now fixed and regression-tested, with no remaining P1/P2 findings.

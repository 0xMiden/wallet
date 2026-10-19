# Minimum burn review visual proof

This isolated CI fixture renders production ReviewTransaction, FullScreenPage, AwaitFonts, i18n, CSS and fonts from the accepted corrected candidate. It keeps useBurnMinimum, the burn reader, timeout/retry, validation and DetailRow real. Only the resolved RPC client boundary supplies controlled proof responses.

- Pending read: amount 6, minimum 5, no review error, enabled submit.
- Resolve the same read: minimum 8, exact minimum 8 error, disabled submit.
- Fresh mount, reject both real timeout-wrapper attempts: fallback 5, no review error, enabled submit.
- Additional amount 4 assertion: minimum 5 error and disabled submit.
- All states run in light and dark. Three screenshots per theme use a 393x1000 viewport at scale 1; PNG dimensions are checked immediately against the 1800 ceiling.
- Account, balances, native metadata and loaded bridge configuration are fixed fixture data. Submission functions throw and record any call. Every browser request outside the exact localhost fixture origin is blocked and rejects acceptance.

Fixture files are copied only into the disposable CI checkout as an untracked subtree. They are excluded from its candidate tree identity. Candidate and production hashes are recorded separately from fixture hashes and rechecked after capture. The accepted 531-test proof remains unchanged on its original branch.

This proves the rendered states in a headless web viewport. It does not prove a native-device layout, live RPC result, payout, submission, final PR review or merge readiness.

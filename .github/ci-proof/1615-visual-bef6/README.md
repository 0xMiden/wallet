# Current-source minimum burn visual proof

Renders production ReviewTransaction, useBurnMinimum, readUsdcxMinimumBurn, timeout/retry, validator, CSS, i18n and fonts from exact source 44071b792f171e977b691656910a272dbee0b5ce. No archived patch or bootstrap is applied.

- Amount 6 with pending read: minimum 5, no error, submit enabled.
- Same read resolves 8: exact error "Send at least 8 USDCx.", submit disabled.
- Fresh mount rejects both real timeout-wrapper attempts: fallback 5, no error, submit enabled.
- Additional amount 4 assertion: exact error "Send at least 5 USDCx.", submit disabled.
- Light and dark each produce three fresh PNGs at 393x1000, scale 1. Each PNG is immediately checked against the hard 1800 ceiling and exact dimensions.

Only RPC responses and account/configuration/action boundaries are controlled. Submission functions record and throw. External network, WebSockets and non-GET requests are blocked and fail acceptance. The fixture remains untracked only inside the disposable exact-source CI checkout. All tracked source, tests, modes and tree identity stay unchanged before and after.

CI retains build output, required HTML/CSS/font/WASM hashes, browser console/page errors/network events, state/submit counters and failure evidence. Root must inspect all six actual CI PNGs before a visual claim. This is a headless Chromium web viewport proof, with no native device or live network acceptance.

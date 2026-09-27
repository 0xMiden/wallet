/**
 * The E2E harness's own fixture faucet symbol, and the exact dollar rate it prices at.
 *
 * The live feed can never price a symbol the harness invents on the fly for a throwaway devnet
 * faucet, so without this an E2E spending-limit cap could never be breached - every spend of the
 * fixture token would count as zero, no matter what the suite configured, and the enforcement
 * path this exists to test would be permanently unverifiable end to end. $1.00 per whole unit is
 * arbitrary but exact, so a spec's existing native-unit figures convert to identical dollar
 * figures with no rescaling. Confined to `MIDEN_E2E_TEST` builds - no App Store or Play Store
 * submission is built with it, though `store-listing:capture:build` (package.json) does build
 * real mobile and Chrome bundles with the flag set, for store-screenshot capture only.
 *
 * Deliberately narrow: this shortcuts only `isCoveredSymbol`/`getPriceMicro` for the one fixture
 * symbol, so `readCache`, the freshness window and a covered asset's
 * `SpendingLimitPriceUnavailableError` refusal stay entirely unexercised by an E2E run. Widening
 * it to cover those too would mean seeding the price cache across realms (a frontend write the
 * backend reads) instead of a same-process short-circuit, and that seeded entry would go stale at
 * `PRICE_MAX_AGE_SECONDS` (600s) partway through a long journey - trading this gap for a flakier
 * one.
 */
export const E2E_FIXTURE_SYMBOL = 'TST';
export const isE2eFixtureSymbol = (symbol: string): boolean =>
  process.env.MIDEN_E2E_TEST === 'true' && symbol === E2E_FIXTURE_SYMBOL;

export const KNOWN_SYMBOLS: Record<string, string> = {
  ETH: 'ETHUSD',
  BTC: 'BTCUSD',
  USDC: 'USDCUSD'
};

/**
 * Whether a swap order's expiry has lapsed at `nowSeconds`. An order with no `expiresAt` (persisted
 * before the stamp existed, or read back as `null`) never lapses on its own: fabricating one would
 * deem every such order instantly expired. The settlement tick, the Cancel write and the receipt all
 * read expiry through this, so none of them can disagree about an order.
 */
export const swapOrderExpired = (expiresAt: number | null | undefined, nowSeconds: number): boolean =>
  expiresAt != null && nowSeconds >= expiresAt;

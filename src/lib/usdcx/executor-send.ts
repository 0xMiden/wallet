/**
 * The burn of an executor-route deposit from a deposit address. The user sends a fixed amount to the address, and
 * Circle's fee comes out of it: the burn is the send amount less the fee that Circle quoted for the send amount, and
 * the fee entry point pulls the burn plus its own fee. Circle's fee does not go up when the amount goes down, so the
 * burn and its fee fit in the send amount. What the fee of the smaller burn leaves stays at the deposit address.
 *
 * No runtime import: the Node suites load this folder (see `executor.ts`).
 */

/** What a send amount pays on Circle's executor route, in USDC base units. */
export interface ExecutorSendSplit {
  /** What is burned, and what arrives as USDCx (1:1). */
  burnUnits: bigint;
  /** Circle's fee for the send amount: what is taken out of it. */
  feeUnits: bigint;
}

/**
 * The burn of `sendUnits` when Circle quoted `feeUnits` for that amount, or null when the fee takes the whole amount
 * (or a value is not valid): no burn fits, and the screen shows that no quote fits.
 */
export function executorSendSplit(sendUnits: bigint, feeUnits: bigint): ExecutorSendSplit | null {
  if (sendUnits <= 0n || feeUnits < 0n || feeUnits >= sendUnits) return null;
  return { burnUnits: sendUnits - feeUnits, feeUnits };
}

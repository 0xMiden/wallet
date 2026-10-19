/** Reserve 0.1 USDCx for the claim and 0.1 USDCx for the burn and sponsorship fees. Check the actual balance before sending. */
export const ROUNDTRIP_FEE_RESERVE = 100_000n;
export const ROUNDTRIP_BURN_UNITS = 2_000_000n;
export const ROUNDTRIP_DEPOSIT_UNITS = ROUNDTRIP_BURN_UNITS + 2n * ROUNDTRIP_FEE_RESERVE;

export function roundtripBurnUnits(vault: bigint, receivedGrant: boolean): bigint {
  const amount = ROUNDTRIP_BURN_UNITS + (receivedGrant ? 1_000_000n : 0n);
  if (vault < amount + ROUNDTRIP_FEE_RESERVE) {
    throw new Error(`Round-trip balance ${vault} cannot cover burn ${amount} and fee reserve ${ROUNDTRIP_FEE_RESERVE}`);
  }
  return amount;
}

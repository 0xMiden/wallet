// Miden-side collateral token (the wallet's USDC faucet) and its decimals. A leaf module, so the
// price lookup (`priceSymbolFor`) can name the faucet without pulling in the Earn flow.
export const MIDEN_USDC_FAUCET = '0x537c15a622074e91188aa894456c52';

// E2E-only collateral-faucet override. The fixed `MIDEN_USDC_FAUCET` testnet id
// can't exist on a local e2e node, and the CLI-minted faucet id is only known at
// test time, so the harness injects it at runtime via `setEarnCollateralFaucetForTest`
// (mirrors `setAgglayerSenderForE2E`). Unset in production, so `getEarnCollateralFaucet()`
// returns `MIDEN_USDC_FAUCET` and behavior is byte-identical.
let earnCollateralFaucetOverride: string | undefined;

export function setEarnCollateralFaucetForTest(faucetHex: string | undefined): void {
  earnCollateralFaucetOverride = faucetHex;
}

export function getEarnCollateralFaucet(): string {
  return earnCollateralFaucetOverride ?? MIDEN_USDC_FAUCET;
}

import type { ChromeWalletPageApi } from './wallet-page';

const HOOK_READY_TIMEOUT_MS = 60_000;

export async function hexFaucetToBech32(wallet: ChromeWalletPageApi, faucetHex: string): Promise<string> {
  try {
    await wallet.page.waitForFunction(
      () =>
        typeof (window as never as { __TEST_HEX_TO_BECH32_FAUCET__?: unknown }).__TEST_HEX_TO_BECH32_FAUCET__ ===
        'function',
      undefined,
      { timeout: HOOK_READY_TIMEOUT_MS }
    );
  } catch (error) {
    throw new Error(
      `__TEST_HEX_TO_BECH32_FAUCET__ was not ready within ${HOOK_READY_TIMEOUT_MS}ms: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  return wallet.page.evaluate(
    hex =>
      (
        window as never as {
          __TEST_HEX_TO_BECH32_FAUCET__: (hex: string) => string;
        }
      ).__TEST_HEX_TO_BECH32_FAUCET__(hex),
    faucetHex
  );
}

import { _setSwapTokensForTest, type SwapToken } from './tokens';

/** Installs swap E2E hooks on globalThis. Caller MUST guard with MIDEN_E2E_TEST. */
export function installSwapTestHooks(): void {
  (globalThis as any).__TEST_SET_SWAP_TOKENS__ = (tokens: SwapToken[]) => _setSwapTokensForTest(tokens);
  // __TEST_PSWAP_CONSUME__ / __TEST_PSWAP_CANCEL__ added in Task 2.1.
}

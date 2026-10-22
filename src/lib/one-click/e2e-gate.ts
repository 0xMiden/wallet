export function isOneClickLocalE2EEnabled(): boolean {
  return (
    process.env.MIDEN_E2E_ONE_CLICK_TESTNET === 'true' &&
    process.env.MIDEN_E2E_TEST === 'true' &&
    process.env.MIDEN_NETWORK === 'localhost'
  );
}

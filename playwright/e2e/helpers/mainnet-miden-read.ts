export async function readMainnetMidenBlock(_rpcUrl: string): Promise<number> {
  throw new Error('Native mainnet block reader is not implemented');
}

export async function readMainnetFaucetMetadata(
  _faucetId: string, _rpcUrl: string
): Promise<{ symbol: string; decimals: number }> {
  throw new Error('Native mainnet faucet reader is not implemented');
}

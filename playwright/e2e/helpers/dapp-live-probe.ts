import path from 'node:path';

import { describeFailure, markInfraAbort } from './dapp-cells';
import { loadMidenSdk } from './dapp-confirm';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import { getEnvironmentConfig } from '../config/environments';

const OUT_DIR = path.resolve(__dirname, '../../../test-results/dapp-cells');

/**
 * One real grant before any journey funds itself. A healthy /pow has coexisted with hours of /get_tokens 502s
 * (KB public-faucet-outage-probe), so the probe asks for tokens for a throwaway account. A refused grant writes
 * INFRA_ABORT: every journey then records its cells blocked by infrastructure without touching the faucet, and the
 * judge fails the job with that one line. Only the grant is the faucet's: an SDK that cannot load or build the account
 * rejects, so Playwright reports it as the run's own error. A network with no public faucet is left to startJourney,
 * which refuses it.
 */
export async function probePublicFaucet(outDir: string): Promise<void> {
  const env = getEnvironmentConfig();
  const faucet = publicFaucetApiUrl(env.name);
  if (faucet === undefined) return;
  const sdk = await loadMidenSdk();
  const { account } = new sdk.AccountBuilder(crypto.getRandomValues(new Uint8Array(32)))
    .withNoAuthComponent()
    .withBasicWalletComponent()
    .build();
  const network = env.name === 'testnet' ? sdk.NetworkId.testnet() : sdk.NetworkId.devnet();
  const address = sdk.Address.fromAccountId(account.id(), 'BasicWallet').toBech32(network);
  try {
    await mintFromPublicFaucet(faucet, address);
  } catch (error) {
    markInfraAbort(outDir, `Public faucet probe failed on ${env.name}: ${describeFailure(error)}`);
  }
}

// Playwright calls a global setup with its config; the probe takes the records directory instead.
export default function globalSetup(): Promise<void> {
  return probePublicFaucet(OUT_DIR);
}

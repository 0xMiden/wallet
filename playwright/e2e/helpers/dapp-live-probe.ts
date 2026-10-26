import path from 'node:path';

import { describeFailure, infraAborted, markInfraAbort } from './dapp-cells';
import { loadMidenSdk } from './dapp-confirm';
import { nodeHeight } from './dapp-node-calls';
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

/**
 * One real gRPC-web call to the node before any device minutes (spike plan change 13): a GET answering 200 shows only
 * the HTTP front end. A node that does not answer writes INFRA_ABORT, as a refused grant does.
 */
export async function probeNode(outDir: string): Promise<void> {
  const env = getEnvironmentConfig();
  try {
    await nodeHeight(env.rpcUrl, 60_000);
  } catch (error) {
    markInfraAbort(outDir, `Node probe failed on ${env.name}: ${describeFailure(error)}`);
  }
}

/** The mobile legs' setup: the grant probe, then the node's own answer unless the faucet already stopped the run. */
export async function probeMobileLegs(outDir: string = OUT_DIR): Promise<void> {
  await probePublicFaucet(outDir);
  if (infraAborted(outDir) === null) await probeNode(outDir);
}

// Playwright calls a global setup with its config; the probe takes the records directory instead.
export default function globalSetup(): Promise<void> {
  return probePublicFaucet(OUT_DIR);
}

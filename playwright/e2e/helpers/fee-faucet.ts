import type { ClientOptions, MidenClient } from '@miden-sdk/miden-sdk';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The query runs as an untyped string in a child process. Its SDK names are checked against
// the SDK's types here, so a rename fails `yarn ts` rather than every public-network fixture.
const sdk = {
  create: 'create' satisfies keyof typeof MidenClient,
  rpcUrl: 'rpcUrl' satisfies keyof ClientOptions,
  autoSync: 'autoSync' satisfies keyof ClientOptions,
  syncChain: 'syncChain' satisfies keyof MidenClient,
  feeFaucetId: 'feeFaucetId' satisfies keyof MidenClient,
  terminate: 'terminate' satisfies keyof MidenClient
};

const query = `
import { MidenClient } from '@miden-sdk/miden-sdk';
const client = await MidenClient.${sdk.create}({ ${sdk.rpcUrl}: process.argv[1], ${sdk.autoSync}: false });
try {
  await client.${sdk.syncChain}();
  console.log((await client.${sdk.feeFaucetId}()).toString());
} finally {
  client.${sdk.terminate}();
}
`;

/**
 * Read the node's synced protocol configuration, without a bootstrap fee override.
 * `sdkRoot` is where the child resolves `@miden-sdk/miden-sdk` from.
 */
export async function discoverFeeFaucetId(
  rpcUrl: string,
  sdkRoot = path.resolve(__dirname, '../../..')
): Promise<string> {
  // The native SDK keeps SQLite handles open until process exit. Own both the process
  // and its temporary directory so discovery never shares or leaks a test's store.
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-fee-faucet-'));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', query, rpcUrl],
        {
          cwd: sdkRoot,
          env: { ...process.env, TMPDIR: storeRoot, TMP: storeRoot, TEMP: storeRoot },
          timeout: 45_000
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      );
    });
    const id = output.trim();
    if (!/^0x[0-9a-f]+$/i.test(id)) throw new Error('Node discovery returned no canonical fee faucet ID');
    return id;
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

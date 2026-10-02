import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const query = `
import { MidenClient } from '@miden-sdk/miden-sdk';
const client = await MidenClient.create({ rpcUrl: process.argv[1], autoSync: false });
try {
  await client.syncChain();
  console.log((await client.feeFaucetId()).toString());
} finally {
  client.terminate();
}
`;

/** Read the node's synced protocol configuration, without a bootstrap fee override. */
export async function discoverFeeFaucetId(rpcUrl: string): Promise<string> {
  // The native SDK keeps SQLite handles open until process exit. Own both the process
  // and its temporary directory so discovery never shares or leaks a test's store.
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-fee-faucet-'));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', query, rpcUrl],
        {
          cwd: path.resolve(__dirname, '../../..'),
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

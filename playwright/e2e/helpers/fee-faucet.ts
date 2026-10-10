import type { BlockHeader, ClientOptions, Endpoint, MidenClient, RpcClient } from '@miden-sdk/miden-sdk';
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
import { writeFileSync } from 'node:fs';
import { MidenClient } from '@miden-sdk/miden-sdk';
const client = await MidenClient.${sdk.create}({ ${sdk.rpcUrl}: process.argv[1], ${sdk.autoSync}: false });
try {
  await client.${sdk.syncChain}();
  writeFileSync(process.env.FEE_FAUCET_ID_PATH, (await client.${sdk.feeFaucetId}()).toString());
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
    const resultPath = path.join(storeRoot, 'fee-faucet-id');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', query, rpcUrl],
        {
          cwd: sdkRoot,
          env: { ...process.env, TMPDIR: storeRoot, TMP: storeRoot, TEMP: storeRoot, FEE_FAUCET_ID_PATH: resultPath },
          timeout: 45_000
        },
        error => (error ? reject(error) : resolve())
      );
    });
    const id = fs.readFileSync(resultPath, 'utf8').trim();
    if (!/^0x[0-9a-f]+$/i.test(id)) {
      throw new Error(`Node discovery returned no canonical fee faucet ID: ${JSON.stringify(id)}`);
    }
    return id;
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

const headerSdk = {
  endpoint: 'Endpoint' satisfies typeof Endpoint.name,
  getBlockHeaderByNumber: 'getBlockHeaderByNumber' satisfies keyof RpcClient,
  verificationBaseFee: 'verificationBaseFee' satisfies keyof BlockHeader
};

const headerQuery = `
import { writeFileSync } from 'node:fs';
import { RpcClient, Endpoint } from '@miden-sdk/miden-sdk';
const header = await new RpcClient(new ${headerSdk.endpoint}(process.argv[1])).${headerSdk.getBlockHeaderByNumber}(undefined);
const baseFee = header.${headerSdk.verificationBaseFee}();
if (!Number.isSafeInteger(baseFee) || baseFee < 0) throw new Error('Invalid verification base fee');
writeFileSync(process.env.MIDEN_VERIFICATION_BASE_FEE_PATH, String(baseFee));
`;

/** Read the current protocol fee from the same RPC endpoint the wallet uses. */
export async function discoverVerificationBaseFee(
  rpcUrl: string,
  sdkRoot = path.resolve(__dirname, '../../..')
): Promise<number> {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-base-fee-'));
  const resultPath = path.join(storeRoot, 'verification-base-fee');
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--input-type=module', '--eval', headerQuery, rpcUrl],
        {
          cwd: sdkRoot,
          env: { ...process.env, MIDEN_VERIFICATION_BASE_FEE_PATH: resultPath },
          timeout: 45_000
        },
        error => (error ? reject(error) : resolve())
      );
    });
    const baseFee = Number(fs.readFileSync(resultPath, 'utf8').trim());
    if (!Number.isSafeInteger(baseFee) || baseFee < 0) {
      throw new Error('Node returned no valid verification base fee');
    }
    return baseFee;
  } finally {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
}

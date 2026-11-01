import type { Address, FetchedAccount, RpcClient, Word } from '@miden-sdk/miden-sdk';
import { execFile } from 'child_process';
import * as path from 'path';

const sdk = {
  getAccountDetails: 'getAccountDetails' satisfies keyof RpcClient,
  commitment: 'commitment' satisfies keyof FetchedAccount,
  isPrivate: 'isPrivate' satisfies keyof FetchedAccount,
  toHex: 'toHex' satisfies keyof Word,
  accountId: 'accountId' satisfies keyof Address
};

// A Node child, as public-note-commitment.ts runs its node query: the SDK's Node entry is ESM. The account's suffix is
// split off first, as accountRefToSdk does, since Address.fromBech32 rejects some.
const query = `
import { RpcClient, Endpoint, Address } from '@miden-sdk/miden-sdk';
const rpc = new RpcClient(new Endpoint(process.argv[1]));
const fetched = await rpc.${sdk.getAccountDetails}(Address.fromBech32(process.argv[2].split('_')[0]).${sdk.accountId}());
console.log(JSON.stringify({ commitment: fetched.${sdk.commitment}().${sdk.toHex}(), isPrivate: fetched.${sdk.isPrivate}() }));
`;

export type NodeAccount = {
  /** The account commitment the node holds: it moves with every transaction of the account. */
  commitment: string;
  isPrivate: boolean;
};

/** What the node holds for an account: its commitment, the only state it keeps for a private account. */
export async function nodeAccount(
  rpcUrl: string,
  address: string,
  attempts = 3,
  sdkRoot = path.resolve(__dirname, '../../..')
): Promise<NodeAccount> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readNodeAccount(rpcUrl, address, sdkRoot);
    } catch (error) {
      // One refused or timed-out RPC is not evidence about the account.
      if (attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
}

async function readNodeAccount(rpcUrl: string, address: string, sdkRoot: string): Promise<NodeAccount> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', query, rpcUrl, address],
      { cwd: sdkRoot, timeout: 60_000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`node account ${address}: ${stderr.trim() || error.message}`)) : resolve(stdout)
    );
  });
  const parsed: unknown = JSON.parse(output.trim().split('\n').pop() ?? '');
  const commitment: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'commitment') : null;
  const isPrivate: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'isPrivate') : null;
  if (typeof commitment !== 'string' || typeof isPrivate !== 'boolean') {
    throw new Error(`node account ${address}: no commitment in ${output}`);
  }
  return { commitment, isPrivate };
}

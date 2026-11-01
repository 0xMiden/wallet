import type { Account, Address, AssetVault, FetchedAccount, FungibleAsset, RpcClient } from '@miden-sdk/miden-sdk';
import { execFile } from 'child_process';
import * as path from 'path';

const sdk = {
  getAccountDetails: 'getAccountDetails' satisfies keyof RpcClient,
  account: 'account' satisfies keyof FetchedAccount,
  vault: 'vault' satisfies keyof Account,
  fungibleAssets: 'fungibleAssets' satisfies keyof AssetVault,
  faucetId: 'faucetId' satisfies keyof FungibleAsset,
  amount: 'amount' satisfies keyof FungibleAsset,
  accountId: 'accountId' satisfies keyof Address
};

// A Node child, as public-note-commitment.ts runs its node query: the SDK's Node entry is ESM. Faucets are keyed as the
// wallet keys them (getBech32AddressFromAccountId: a BasicWallet address on the network's prefix).
const query = `
import { RpcClient, Endpoint, Address, NetworkId } from '@miden-sdk/miden-sdk';
const rpc = new RpcClient(new Endpoint(process.argv[1]));
const network = NetworkId[process.argv[3]]();
const account = (await rpc.${sdk.getAccountDetails}(Address.fromBech32(process.argv[2]).${sdk.accountId}())).${sdk.account}();
if (!account) throw new Error('the node serves no public state for ' + process.argv[2]);
const vault = {};
for (const asset of account.${sdk.vault}().${sdk.fungibleAssets}()) {
  const amount = asset.${sdk.amount}();
  if (amount > 0n) vault[Address.fromAccountId(asset.${sdk.faucetId}(), 'BasicWallet').toBech32(network)] = amount.toString();
}
console.log(JSON.stringify(vault));
`;

/** The nonzero fungible assets the node holds for a public account, faucet to base units, keyed as the wallet keys them. */
export async function chainVault(
  rpcUrl: string,
  network: 'mainnet' | 'testnet' | 'devnet',
  address: string,
  timeoutMs = 60_000,
  sdkRoot = path.resolve(__dirname, '../../..')
): Promise<Record<string, string>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--input-type=module', '--eval', query, rpcUrl, address, network],
      { cwd: sdkRoot, timeout: timeoutMs },
      (error, stdout, stderr) =>
        error ? reject(new Error(`chain vault of ${address}: ${stderr.trim() || error.message}`)) : resolve(stdout)
    );
  });
  const parsed: unknown = JSON.parse(output.trim().split('\n').pop() ?? '');
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error(`chain vault of ${address}: no vault in ${output}`);
  return Object.fromEntries(Object.entries(parsed).map(([faucet, amount]) => [faucet, String(amount)]));
}

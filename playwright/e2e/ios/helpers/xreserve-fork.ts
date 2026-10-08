import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  zeroAddress
} from 'viem';
import { sepolia } from 'viem/chains';

import { getUsdcxContracts, USDCX_MIDEN_REMOTE_DOMAIN } from '../../../../src/lib/usdcx/constant';

/**
 * Prepares a local Anvil FORK of Sepolia for the USDCx bridge-in deposit, so the
 * wallet deposits into Circle's REAL xReserve contract code instead of a double.
 *
 * Why Sepolia and not Arc Testnet, the chain the wallet uses outside tests: Arc's
 * USDC is the chain's native token and its transfers call Arc precompiles (the
 * blocklist at 0x1800…0001). Anvil does not have them, so every USDC transfer
 * reverts on an Arc fork. Sepolia's USDC is a plain ERC-20, and Sepolia's xReserve
 * is the same contract at the same address. The e2e build picks Sepolia with
 * `MIDEN_E2E_USDCX_CHAIN=sepolia`.
 *
 * Circle has not registered the Miden domain on Sepolia's xReserve, so a deposit
 * there reverts with `RemoteDomainNotRegistered`. On the fork this helper does
 * what Circle did on Arc, through impersonated admin accounts:
 *   1. the registration manager registers the Miden domain and its remote token;
 *   2. the owner clears the domain's hook executor, as on Circle's own domains
 *      (a deposit calls the executor, and the placeholder is not a contract).
 * It also gives the depositor USDC by writing the token's balance slot.
 *
 * Every step was run by hand against a Sepolia fork before it was written here.
 */

const { usdc: SEPOLIA_USDC, xReserve: XRESERVE } = getUsdcxContracts(sepolia.id);

/**
 * The remote token the fork registers for the Miden domain: the faucet id Circle
 * registered on Arc Testnet's xReserve, in the bytes32 form. The deposit leg only
 * needs a registered value; a relayer leg would need the id of the faucet it mints from.
 */
export const DEFAULT_MIDEN_REMOTE_TOKEN: Hex = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';

// FiatToken keeps `balanceAndBlacklistStates` at storage slot 9.
const USDC_BALANCE_SLOT = 9n;
// xReserve refuses a signature threshold below 2 and a zero signature buffer delay.
const SIGNATURE_THRESHOLD = 2n;
const SIGNATURE_BUFFER_DELAY_SECONDS = 3600n;
// Placeholder attesters. Nothing on the fork checks an attestation: Circle's service does not see it.
const PLACEHOLDER_ATTESTERS: Address[] = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
];
const ONE_ETHER_HEX = '0xde0b6b3a7640000';

const XRESERVE_ADMIN_ABI = parseAbi([
  'function owner() view returns (address)',
  'function registrationManager() view returns (address)',
  'function isRemoteDomainRegistered(uint32 remoteDomain) view returns (bool)',
  'function getRemoteToken(uint32 remoteDomain, address localToken) view returns (bytes32)',
  'function getRemoteDomainHookExecutor(uint32 remoteDomain) view returns (address)',
  'function registerRemoteDomain(uint32 remoteDomain, address domainManager, address hookExecutor, address[] attesters, uint256 signatureThreshold, uint256 signatureBufferDelay, address feeRecipient)',
  'function registerRemoteToken(address localToken, uint32 remoteDomain, bytes32 remoteToken)',
  'function setRemoteDomainHookExecutor(uint32 remoteDomain, address hookExecutor)'
]);

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

interface JsonRpcResponse {
  result?: unknown;
  error?: { message?: string };
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const payload = (await res.json()) as JsonRpcResponse;
  if (payload.error) throw new Error(`RPC ${method} failed: ${payload.error.message ?? 'unknown'}`);
  return payload.result;
}

async function ethCall(rpcUrl: string, to: Address, data: Hex): Promise<Hex> {
  return (await rpc(rpcUrl, 'eth_call', [{ to, data }, 'latest'])) as Hex;
}

/** The address a 32-byte ABI word holds. */
const wordToAddress = (word: Hex): Address => `0x${word.slice(-40)}`;

/** Send a transaction from an impersonated account and wait for a successful receipt. */
async function sendAs(rpcUrl: string, from: Address, data: Hex, label: string): Promise<void> {
  await rpc(rpcUrl, 'anvil_impersonateAccount', [from]);
  await rpc(rpcUrl, 'anvil_setBalance', [from, ONE_ETHER_HEX]);
  const hash = (await rpc(rpcUrl, 'eth_sendTransaction', [{ from, to: XRESERVE, data }])) as Hex;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const receipt = (await rpc(rpcUrl, 'eth_getTransactionReceipt', [hash])) as { status?: string } | null;
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`xreserve-fork: ${label} reverted (${hash})`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`xreserve-fork: ${label} was not mined within 30s (${hash})`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** Read the depositor's USDC balance on the fork, in base units (6 decimals). */
export async function readForkUsdcBalance(rpcUrl: string, account: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [account] });
  return BigInt(await ethCall(rpcUrl, SEPOLIA_USDC, data));
}

/** Give `account` exactly `amount` USDC base units by writing the token's balance slot. */
export async function fundForkUsdc(rpcUrl: string, account: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, USDC_BALANCE_SLOT]));
  const value = `0x${amount.toString(16).padStart(64, '0')}`;
  await rpc(rpcUrl, 'anvil_setStorageAt', [SEPOLIA_USDC, slot, value]);
  const balance = await readForkUsdcBalance(rpcUrl, account);
  if (balance !== amount) {
    throw new Error(`xreserve-fork: USDC balance is ${balance} after funding, expected ${amount}`);
  }
}

/**
 * Register the Miden domain and its remote token on the fork's xReserve, and clear
 * the hook executor. Each step is skipped when the fork already has it, so the
 * helper stays correct after Circle registers the domain on Sepolia itself.
 */
export async function registerMidenDomainOnFork(
  rpcUrl: string,
  remoteToken: Hex = DEFAULT_MIDEN_REMOTE_TOKEN
): Promise<void> {
  const domain = USDCX_MIDEN_REMOTE_DOMAIN;
  const read = async (functionName: 'owner' | 'registrationManager'): Promise<Address> =>
    wordToAddress(await ethCall(rpcUrl, XRESERVE, encodeFunctionData({ abi: XRESERVE_ADMIN_ABI, functionName })));
  const registrationManager = await read('registrationManager');
  const owner = await read('owner');

  const registered = await ethCall(
    rpcUrl,
    XRESERVE,
    encodeFunctionData({ abi: XRESERVE_ADMIN_ABI, functionName: 'isRemoteDomainRegistered', args: [domain] })
  );
  if (BigInt(registered) === 0n) {
    await sendAs(
      rpcUrl,
      registrationManager,
      encodeFunctionData({
        abi: XRESERVE_ADMIN_ABI,
        functionName: 'registerRemoteDomain',
        args: [
          domain,
          registrationManager,
          registrationManager,
          PLACEHOLDER_ATTESTERS,
          SIGNATURE_THRESHOLD,
          SIGNATURE_BUFFER_DELAY_SECONDS,
          registrationManager
        ]
      }),
      'registerRemoteDomain'
    );
  }

  const currentToken = await ethCall(
    rpcUrl,
    XRESERVE,
    encodeFunctionData({ abi: XRESERVE_ADMIN_ABI, functionName: 'getRemoteToken', args: [domain, SEPOLIA_USDC] })
  );
  if (BigInt(currentToken) === 0n) {
    await sendAs(
      rpcUrl,
      registrationManager,
      encodeFunctionData({
        abi: XRESERVE_ADMIN_ABI,
        functionName: 'registerRemoteToken',
        args: [SEPOLIA_USDC, domain, remoteToken]
      }),
      'registerRemoteToken'
    );
  }

  const hookExecutor = wordToAddress(
    await ethCall(
      rpcUrl,
      XRESERVE,
      encodeFunctionData({ abi: XRESERVE_ADMIN_ABI, functionName: 'getRemoteDomainHookExecutor', args: [domain] })
    )
  );
  if (BigInt(hookExecutor) !== 0n) {
    await sendAs(
      rpcUrl,
      owner,
      encodeFunctionData({
        abi: XRESERVE_ADMIN_ABI,
        functionName: 'setRemoteDomainHookExecutor',
        args: [domain, zeroAddress]
      }),
      'setRemoteDomainHookExecutor'
    );
  }
}

export const FORK_XRESERVE_ADDRESS: Address = XRESERVE;
export const FORK_USDC_ADDRESS: Address = SEPOLIA_USDC;

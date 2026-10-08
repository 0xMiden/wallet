import { readFileSync } from 'node:fs';
import { encodeFunctionData, isAddress, parseAbi, type Address } from 'viem';
import { z } from 'zod';

import type { BatchCall } from './calibur.js';
import { ERC20_ABI } from './erc20.js';
import { MIDEN_ACCOUNT_HEX_PATTERN } from '../miden-account.js';

/**
 * The Agglayer bridge from Sepolia to Miden testnet. This is testnet code only: mainnet does not bridge through
 * Agglayer. The wallet twin of the calls is in `src/lib/onramp/buy-batch.ts`.
 * The arguments of the bridge call come from `config.json`. The wallet twin has the same values in its code,
 * and the wallet signs the batch that it builds. Thus a change of `config.json` also needs a new wallet build.
 */

/** `config.json` is in the backend directory, two levels above this module in `src/` and in `dist/`. */
const CONFIG_URL = new URL('../../config.json', import.meta.url);

const agglayerConfigSchema = z.object({
  'agglayer-testnet': z.object({
    bridgeAddress: z.custom<Address>(
      value => typeof value === 'string' && isAddress(value),
      'agglayer-testnet.bridgeAddress is not a valid EVM address'
    ),
    midenNetworkId: z.number().int().nonnegative().max(0xffffffff),
    forceUpdateGlobalExitRoot: z.boolean()
  })
});

/** Read and check `config.json`. Throw at start when the file is missing or a value is not valid. */
function loadAgglayerConfig() {
  let text: string;
  try {
    text = readFileSync(CONFIG_URL, 'utf8');
  } catch {
    throw new Error(`Cannot read ${CONFIG_URL.pathname}`);
  }
  const body: unknown = JSON.parse(text);
  return agglayerConfigSchema.parse(body)['agglayer-testnet'];
}

const agglayerConfig = loadAgglayerConfig();

// The Agglayer bridge on Sepolia and the Agglayer network ID of Miden testnet (not an EVM chain ID).
export const AGGLAYER_BRIDGE_ADDRESS = agglayerConfig.bridgeAddress;
export const MIDEN_AGGLAYER_NETWORK_ID = agglayerConfig.midenNetworkId;
export const AGGLAYER_FORCE_UPDATE_GLOBAL_EXIT_ROOT = agglayerConfig.forceUpdateGlobalExitRoot;

export const BRIDGE_ASSET_ABI = parseAbi([
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
]);

/**
 * The Agglayer destination address of a Miden account:
 * 4 zero bytes, the 15-byte account ID, 1 zero byte. Lower case.
 */
export function midenAccountHexToEvmAddress(midenAccountHex: string): Address {
  if (!MIDEN_ACCOUNT_HEX_PATTERN.test(midenAccountHex)) {
    throw new Error('midenAccountHex is not a 15-byte hex account ID');
  }
  return `0x${'00'.repeat(4)}${midenAccountHex.slice(2).toLowerCase()}00`;
}

/** Approve the Agglayer bridge, then bridge the token to the Miden account. */
export function agglayerBridgeCalls(token: Address, amount: bigint, midenAccountHex: string): BatchCall[] {
  return [
    {
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [AGGLAYER_BRIDGE_ADDRESS, amount]
      })
    },
    {
      to: AGGLAYER_BRIDGE_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: BRIDGE_ASSET_ABI,
        functionName: 'bridgeAsset',
        args: [
          MIDEN_AGGLAYER_NETWORK_ID,
          midenAccountHexToEvmAddress(midenAccountHex),
          amount,
          token,
          AGGLAYER_FORCE_UPDATE_GLOBAL_EXIT_ROOT,
          '0x'
        ]
      })
    }
  ];
}

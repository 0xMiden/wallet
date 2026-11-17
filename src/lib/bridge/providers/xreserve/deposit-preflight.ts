// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/deposit-preflight.ts (MIT).
import { parseAbi, type PublicClient } from 'viem';

import type { UsdcxSourceChain } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor } from 'lib/usdcx/deposit-target';
import { XRESERVE_ABI } from 'lib/usdcx/protocol';

const remoteTokenAbi = parseAbi(['function getRemoteToken(uint32,address) view returns (bytes32)']);
const pausedAbi = parseAbi(['function paused() view returns (bool)']);

export async function assertXReserveRouteAvailable(
  client: Pick<PublicClient, 'readContract'>, source: UsdcxSourceChain, faucetId: string
): Promise<void> {
  const target = source.route === 'xreserve' ? source : source.target;
  if (target.midenDomain === undefined) throw new Error('Circle remote domain unavailable');
  const registered = await client.readContract({ address: target.xReserve, abi: XRESERVE_ABI,
    functionName: 'isRemoteDomainRegistered', args: [target.midenDomain] });
  const token = await client.readContract({ address: target.xReserve, abi: remoteTokenAbi,
    functionName: 'getRemoteToken', args: [target.midenDomain, target.usdc] });
  if (!registered || token.toLowerCase() !== usdcxExpectedRemoteTokenFor(faucetId).toLowerCase())
    throw new Error('Circle remote deposit target changed');
  if (source.route === 'cctp-executor') {
    const executorPaused = await client.readContract({ address: source.target.executor, abi: pausedAbi, functionName: 'paused' });
    const handlerPaused = await client.readContract({ address: source.target.handler, abi: pausedAbi, functionName: 'paused' });
    if (executorPaused || handlerPaused) throw new Error('Circle executor route unavailable');
  }
}

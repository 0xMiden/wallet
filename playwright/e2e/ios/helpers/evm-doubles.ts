/**
 * On-chain doubles for the bridge-IN deposit harness, installed onto a local
 * Anvil via `anvil_setCode`.
 *
 * The AggLayer (PolygonZkEVM) unified bridge lives on public Sepolia and can't
 * run locally, so we place a minimal stand-in at the SAME address the wallet
 * calls (`AGGLAYER_CONTRACT_ADDRESS.get('sepolia')`). The stub implements the
 * real `bridgeAsset` selector + signature and the native-ETH `msg.value ==
 * amount` invariant, so a wrong-value / wrong-calldata deposit REVERTS on-chain
 * (the wallet then marks the row failed) instead of passing green against dead
 * code. Source: playwright/e2e/ios/helpers/contracts/MockAggLayerBridge.sol
 * (compiled with solc 0.8.35, optimizer 200 runs).
 */

/** Same address as `src/lib/agglayer/constant.ts` → AGGLAYER_CONTRACT_ADDRESS('sepolia'). */
export const AGGLAYER_BRIDGE_ADDRESS = '0x1348947e282138d8f377b467f7d9c2eb0f335d1f';

/** Same address as `src/lib/epoch/bridgeable-token.ts` → BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS (USDC). */
export const MOCK_USDC_ADDRESS = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';

/** Deployed (runtime) bytecode of MockAggLayerBridge — see file header. */
export const MOCK_AGGLAYER_BRIDGE_RUNTIME =
  '0x608060405260043610610028575f3560e01c80632dfdf0b51461002c578063cd58657914610060575b5f5ffd5b348015610037575f5ffd5b505f546100479063ffffffff1681565b60405163ffffffff909116815260200160405180910390f35b61007361006e3660046101bf565b610075565b005b6001600160a01b0384166100e2578434146100e25760405162461bcd60e51b815260206004820152602360248201527f4d6f636b4167674c617965724272696467653a2076616c756520213d20616d6f6044820152621d5b9d60ea1b606482015260840160405180910390fd5b5f805460408051838152602081018490526001600160a01b038881168284015263ffffffff8c81166060840152908b16608083015260a082018a905261010060c083018190528201949094529290911660e0830152517f501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b918190036101200190a15f805460019190819061017d90849063ffffffff1661028d565b92506101000a81548163ffffffff021916908363ffffffff16021790555050505050505050565b80356001600160a01b03811681146101ba575f5ffd5b919050565b5f5f5f5f5f5f5f60c0888a0312156101d5575f5ffd5b873563ffffffff811681146101e8575f5ffd5b96506101f6602089016101a4565b95506040880135945061020b606089016101a4565b93506080880135801515811461021f575f5ffd5b925060a088013567ffffffffffffffff81111561023a575f5ffd5b88015f80601f83018c1361024c575f5ffd5b50813567ffffffffffffffff811115610263575f5ffd5b6020830191508b602082850101111561027a575f5ffd5b989b979a50959850939692959293505050565b63ffffffff81811683821601908111156102b557634e487b7160e01b5f52601160045260245ffd5b9291505056fea26469706673582212209188fc9ed085dbee2fc1397a04c60624953e024be078596227dfa69adac8f17864736f6c63430008230033';

/**
 * Deployed (runtime) bytecode of MockUsdc — a getBalance/balanceOf stand-in so
 * the deposit screen's USDC balance eth_call decodes cleanly on Anvil (a bare
 * address returns "0x" → viem throws → the amount screen never renders).
 * Source: playwright/e2e/ios/helpers/contracts/MockUsdc.sol.
 */
export const MOCK_USDC_RUNTIME =
  '0x608060405234801561000f575f5ffd5b506004361061004a575f3560e01c8063313ce5671461004e57806370a0823114610062578063e30443bc14610098578063f8b2cb4f14610062575b5f5ffd5b604051601281526020015b60405180910390f35b61008a6100703660046100de565b6001600160a01b03165f9081526020819052604090205490565b604051908152602001610059565b6100c16100a63660046100fe565b6001600160a01b039091165f90815260208190526040902055565b005b80356001600160a01b03811681146100d9575f5ffd5b919050565b5f602082840312156100ee575f5ffd5b6100f7826100c3565b9392505050565b5f5f6040838503121561010f575f5ffd5b610118836100c3565b94602093909301359350505056fea2646970667358221220e31c8c916d48016a61bd8cb74127f4af7b226de20c94a5229525b5179077521d64736f6c63430008230033';

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

async function installCode(rpcUrl: string, address: string, runtime: string, label: string): Promise<void> {
  await rpc(rpcUrl, 'anvil_setCode', [address, runtime]);
  const code = (await rpc(rpcUrl, 'eth_getCode', [address, 'latest'])) as string;
  if (!code || code === '0x') {
    throw new Error(`${label}: no code at ${address} after anvil_setCode`);
  }
}

/** Place the MockAggLayerBridge runtime code at the bridge address on Anvil. */
export async function installAggLayerBridge(rpcUrl: string): Promise<void> {
  await installCode(rpcUrl, AGGLAYER_BRIDGE_ADDRESS, MOCK_AGGLAYER_BRIDGE_RUNTIME, 'installAggLayerBridge');
}

/** Place the MockUsdc runtime code at the bridgeable-USDC address on Anvil. */
export async function installMockUsdc(rpcUrl: string): Promise<void> {
  await installCode(rpcUrl, MOCK_USDC_ADDRESS, MOCK_USDC_RUNTIME, 'installMockUsdc');
}

/** Read the stub's deposit counter (increments once per successful bridgeAsset). */
export async function readBridgeDepositCount(rpcUrl: string): Promise<number> {
  // depositCount() selector = 0x2dfdf0b5
  const data = (await rpc(rpcUrl, 'eth_call', [
    { to: AGGLAYER_BRIDGE_ADDRESS, data: '0x2dfdf0b5' },
    'latest'
  ])) as string;
  return data && data !== '0x' ? parseInt(data, 16) : 0;
}

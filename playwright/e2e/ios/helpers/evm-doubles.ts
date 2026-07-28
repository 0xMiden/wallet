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

/** "The Compact" — same address as the Epoch SDK's COMPACT_ADDRESS (all chains). */
export const MOCK_COMPACT_ADDRESS = '0x00000000000000171ede64904551eeDF3C6C9788';

/** Deployed (runtime) bytecode of MockAggLayerBridge — see file header. */
export const MOCK_AGGLAYER_BRIDGE_RUNTIME =
  '0x608060405260043610610028575f3560e01c80632dfdf0b51461002c578063cd58657914610060575b5f5ffd5b348015610037575f5ffd5b505f546100479063ffffffff1681565b60405163ffffffff909116815260200160405180910390f35b61007361006e3660046101bf565b610075565b005b6001600160a01b0384166100e2578434146100e25760405162461bcd60e51b815260206004820152602360248201527f4d6f636b4167674c617965724272696467653a2076616c756520213d20616d6f6044820152621d5b9d60ea1b606482015260840160405180910390fd5b5f805460408051838152602081018490526001600160a01b038881168284015263ffffffff8c81166060840152908b16608083015260a082018a905261010060c083018190528201949094529290911660e0830152517f501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b918190036101200190a15f805460019190819061017d90849063ffffffff1661028d565b92506101000a81548163ffffffff021916908363ffffffff16021790555050505050505050565b80356001600160a01b03811681146101ba575f5ffd5b919050565b5f5f5f5f5f5f5f60c0888a0312156101d5575f5ffd5b873563ffffffff811681146101e8575f5ffd5b96506101f6602089016101a4565b95506040880135945061020b606089016101a4565b93506080880135801515811461021f575f5ffd5b925060a088013567ffffffffffffffff81111561023a575f5ffd5b88015f80601f83018c1361024c575f5ffd5b50813567ffffffffffffffff811115610263575f5ffd5b6020830191508b602082850101111561027a575f5ffd5b989b979a50959850939692959293505050565b63ffffffff81811683821601908111156102b557634e487b7160e01b5f52601160045260245ffd5b9291505056fea26469706673582212209188fc9ed085dbee2fc1397a04c60624953e024be078596227dfa69adac8f17864736f6c63430008230033';

/**
 * Deployed (runtime) bytecode of MockUsdc — a stateless ERC20-ish stand-in.
 * Serves the deposit screen's balance read (getBalance/balanceOf) AND the Epoch
 * SDK's deposit path: a MAX allowance makes the SDK skip `approve`, and
 * approve/transferFrom succeed so the Compact stub can pull funds.
 * Source: playwright/e2e/ios/helpers/contracts/MockUsdc.sol.
 */
export const MOCK_USDC_RUNTIME =
  '0x608060405234801561000f575f5ffd5b506004361061007a575f3560e01c806370a082311161005857806370a08231146100cf578063a9059cbb1461007e578063dd62ed3e146100f5578063f8b2cb4f146100cf575f5ffd5b8063095ea7b31461007e57806323b872dd146100a9578063313ce567146100c0575b5f5ffd5b61009461008c366004610126565b600192915050565b60405190151581526020015b60405180910390f35b6100946100b736600461014e565b60019392505050565b604051600681526020016100a0565b6100e76100dd366004610188565b5064e8d4a5100090565b6040519081526020016100a0565b6100e76101033660046101a8565b5f1992915050565b80356001600160a01b0381168114610121575f5ffd5b919050565b5f5f60408385031215610137575f5ffd5b6101408361010b565b946020939093013593505050565b5f5f5f60608486031215610160575f5ffd5b6101698461010b565b92506101776020850161010b565b929592945050506040919091013590565b5f60208284031215610198575f5ffd5b6101a18261010b565b9392505050565b5f5f604083850312156101b9575f5ffd5b6101c28361010b565b91506101d06020840161010b565b9050925092905056fea2646970667358221220d2c2905df0153b4ee213437a77eccccc9b18735056934e19e18061bb29e3691564736f6c63430008230033';

/**
 * Deployed (runtime) bytecode of MockCompact — "The Compact" stand-in.
 * getForcedWithdrawalStatus → (0=Disabled, 0) (solveIntent requires Disabled);
 * depositERC20AndRegister asserts the expected token, pulls it via transferFrom,
 * and counts the deposit. Source: playwright/e2e/ios/helpers/contracts/MockCompact.sol.
 */
export const MOCK_COMPACT_RUNTIME =
  '0x608060405234801561000f575f5ffd5b506004361061003f575f3560e01c8063144bd5b5146100435780632dfdf0b5146100775780633ddf74001461008d575b5f5ffd5b610059610051366004610257565b505f91829150565b6040805160ff90931683526020830191909152015b60405180910390f35b61007f5f5481565b60405190815260200161006e565b61007f61009b36600461027f565b5f6001600160a01b038616732bb4ffd7e2c6d432b697554efd77fa13bdbefd691461010d5760405162461bcd60e51b815260206004820152601d60248201527f4d6f636b436f6d706163743a20756e657870656374656420746f6b656e00000060448201526064015b60405180910390fd5b6040516323b872dd60e01b8152336004820152306024820152604481018590526001600160a01b038716906323b872dd906064016020604051808303815f875af115801561015d573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061018191906102d6565b6101cd5760405162461bcd60e51b815260206004820181905260248201527f4d6f636b436f6d706163743a207472616e7366657246726f6d206661696c65646044820152606401610104565b604080518581526001600160a01b0319871660208201526001600160a01b038816917f399ec9a0029be6b1879b3b1842acb620820f0ba7d22122d274eca4042e1ff696910160405180910390a260015f5f82825461022b91906102fc565b90915550505f549695505050505050565b80356001600160a01b0381168114610252575f5ffd5b919050565b5f5f60408385031215610268575f5ffd5b6102718361023c565b946020939093013593505050565b5f5f5f5f5f60a08688031215610293575f5ffd5b61029c8661023c565b945060208601356001600160a01b0319811681146102b8575f5ffd5b94979496505050506040830135926060810135926080909101359150565b5f602082840312156102e6575f5ffd5b815180151581146102f5575f5ffd5b9392505050565b8082018082111561031b57634e487b7160e01b5f52601160045260245ffd5b9291505056fea26469706673582212203752452fd9816bf706e9565bb0dca3d201c70b1a23e6f18c9408488ee908e31064736f6c63430008230033';

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

/** Place the MockCompact runtime code at The Compact's address on Anvil. */
export async function installMockCompact(rpcUrl: string): Promise<void> {
  await installCode(rpcUrl, MOCK_COMPACT_ADDRESS, MOCK_COMPACT_RUNTIME, 'installMockCompact');
}

/** Read the Compact stub's deposit counter (increments per depositERC20AndRegister). */
export async function readCompactDepositCount(rpcUrl: string): Promise<number> {
  // depositCount() selector = 0x2dfdf0b5
  const data = (await rpc(rpcUrl, 'eth_call', [{ to: MOCK_COMPACT_ADDRESS, data: '0x2dfdf0b5' }, 'latest'])) as string;
  return data && data !== '0x' ? parseInt(data, 16) : 0;
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

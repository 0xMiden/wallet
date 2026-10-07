/**
 * On-chain doubles for the bridge and Earn harnesses, installed onto a local
 * Anvil via `anvil_setCode`.
 *
 * The AggLayer (PolygonZkEVM) unified bridge lives on public Sepolia and can't
 * run locally, so we place a minimal stand-in at the address the served config
 * document names (`agglayer.l1Bridge`, see helpers/fake-bridge-config.ts). The
 * stub implements the real `bridgeAsset` selector + signature, the native-ETH
 * `msg.value == amount` invariant and `networkID()`, so a wrong-value or
 * wrong-calldata deposit REVERTS on-chain (the wallet then marks the row failed)
 * instead of passing green against dead code. Source:
 * playwright/e2e/ios/helpers/contracts/MockAggLayerBridge.sol (compiled with
 * solc 0.8.35, optimizer 200 runs; the recompile command is in the source).
 */

/** The Sepolia bridge's address; the served config document names it as `agglayer.l1Bridge`. */
export const AGGLAYER_BRIDGE_ADDRESS = '0x1348947e282138d8f377b467f7d9c2eb0f335d1f';

/** The Sepolia USDC's address; the served config document names it as `epoch.evmUsdc`. */
export const MOCK_USDC_ADDRESS = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';

/** "The Compact" — same address as the Epoch SDK's COMPACT_ADDRESS (all chains). */
export const MOCK_COMPACT_ADDRESS = '0x00000000000000171ede64904551eeDF3C6C9788';

/** Deployed (runtime) bytecode of MockAggLayerBridge — see file header. */
export const MOCK_AGGLAYER_BRIDGE_RUNTIME =
  '0x608060405260043610610033575f3560e01c80632dfdf0b514610037578063bab161bf1461006b578063cd5865791461007d575b5f5ffd5b348015610042575f5ffd5b505f546100529063ffffffff1681565b60405163ffffffff909116815260200160405180910390f35b348015610076575f5ffd5b505f610052565b61009061008b3660046101dc565b610092565b005b6001600160a01b0384166100ff578434146100ff5760405162461bcd60e51b815260206004820152602360248201527f4d6f636b4167674c617965724272696467653a2076616c756520213d20616d6f6044820152621d5b9d60ea1b606482015260840160405180910390fd5b5f805460408051838152602081018490526001600160a01b038881168284015263ffffffff8c81166060840152908b16608083015260a082018a905261010060c083018190528201949094529290911660e0830152517f501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b918190036101200190a15f805460019190819061019a90849063ffffffff166102aa565b92506101000a81548163ffffffff021916908363ffffffff16021790555050505050505050565b80356001600160a01b03811681146101d7575f5ffd5b919050565b5f5f5f5f5f5f5f60c0888a0312156101f2575f5ffd5b873563ffffffff81168114610205575f5ffd5b9650610213602089016101c1565b955060408801359450610228606089016101c1565b93506080880135801515811461023c575f5ffd5b925060a088013567ffffffffffffffff811115610257575f5ffd5b88015f80601f83018c13610269575f5ffd5b50813567ffffffffffffffff811115610280575f5ffd5b6020830191508b6020828501011115610297575f5ffd5b989b979a50959850939692959293505050565b63ffffffff81811683821601908111156102d257634e487b7160e01b5f52601160045260245ffd5b9291505056fea2646970667358221220239f5fcee21a600a37a6bb49ffda7590cf8ef8ee5d325690f62d200d37958e4b64736f6c63430008230033';

/**
 * Deployed (runtime) bytecode of MockUsdc, a stateless ERC20-ish stand-in.
 * Serves the deposit screen's balance read (getBalance/balanceOf), the Epoch
 * SDK's deposit path (a MAX allowance makes the SDK skip `approve`, and
 * approve/transferFrom succeed so the Compact stub can pull funds) and the
 * wallet's config derivation (`symbol()` USDC, `decimals()` 18, as the Sepolia
 * token answers). Source: playwright/e2e/ios/helpers/contracts/MockUsdc.sol.
 */
export const MOCK_USDC_RUNTIME =
  '0x608060405234801561000f575f5ffd5b5060043610610085575f3560e01c806395d89b411161005857806395d89b4114610105578063a9059cbb14610089578063dd62ed3e1461012b578063f8b2cb4f146100da575f5ffd5b8063095ea7b31461008957806323b872dd146100b4578063313ce567146100cb57806370a08231146100da575b5f5ffd5b61009f61009736600461015c565b600192915050565b60405190151581526020015b60405180910390f35b61009f6100c2366004610184565b60019392505050565b604051601281526020016100ab565b6100f76100e83660046101be565b5069d3c21bcecceda100000090565b6040519081526020016100ab565b60408051808201825260048152635553444360e01b602082015290516100ab91906101de565b6100f7610139366004610213565b5f1992915050565b80356001600160a01b0381168114610157575f5ffd5b919050565b5f5f6040838503121561016d575f5ffd5b61017683610141565b946020939093013593505050565b5f5f5f60608486031215610196575f5ffd5b61019f84610141565b92506101ad60208501610141565b929592945050506040919091013590565b5f602082840312156101ce575f5ffd5b6101d782610141565b9392505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b5f5f60408385031215610224575f5ffd5b61022d83610141565b915061023b60208401610141565b9050925092905056fea2646970667358221220f612eec8a2bc6f525246c3e11be49437dc3ef525b51320c39c7266a00007ffb464736f6c63430008230033';

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

/**
 * MetaMask Stateless-7702 delegate on Sepolia — the Epoch SDK's
 * `METAMASK_STATELESS_7702_IMPLEMENTATION[11155111]` (an approved 7702 impl).
 */
const METAMASK_7702_IMPL_SEPOLIA = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';

/**
 * Mark `owner` as already EIP-7702-delegated to Epoch's approved implementation
 * on Anvil, so the gasless withdraw's `ensureEpochSmartAccount` sees
 * `delegation === 'epoch'` and returns early (skips the relay enable — the fake
 * relay only acks `/relay-enable-delegation`, it can't broadcast the real 7702
 * authorization tx that would set this delegation code on-chain). The delegation
 * bytecode is `EIP7702_DELEGATION_PREFIX` (0xef0100) followed by the impl address.
 */
export async function installEpoch7702Delegation(rpcUrl: string, owner: string): Promise<void> {
  await installCode(rpcUrl, owner, `0xef0100${METAMASK_7702_IMPL_SEPOLIA.slice(2)}`, 'installEpoch7702Delegation');
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

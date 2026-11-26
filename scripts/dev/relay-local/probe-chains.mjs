// Read-only probe of the EVM chains of a wallet-config document for the deposit relay.
//
// For each chain of `supportedEvmChains` it lists the Agglayer and Epoch deposit tokens, and it checks with a public
// RPC:
//   1. the chain id of the RPC;
//   2. the code at each Calibur candidate: its size and keccak256, compared with the expected hash when one is given;
//   3. the Calibur ABI that the wallet signs for: the `execute` and `getSeq` selectors in the code, and
//      `eip712Domain()` on a throwaway address that has the Calibur code as a state override;
//   4. EIP-7702: an `eth_sendRawTransaction` of a type-4 transaction from a throwaway key with no funds. A chain with
//      the fork live refuses it for the funds; a chain without it refuses the type.
//
// The throwaway key exists only in this process. The script never prints it, and it sends no wallet data.
//
// Usage:
//   node scripts/dev/relay-local/probe-chains.mjs [--network testnet] [--calibur 0x<40 hex>[=0x<64 hex>]]...
//                                                 [--chain <key>]... [--config-url <base URL>]
// Env: RPC_URL_<chainId> replaces the public RPC of a chain. The script does not print that URL.
import { parseArgs } from 'node:util';
import {
  createPublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toFunctionSelector
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { CANONICAL_CALIBUR } from './lib.mjs';

const PUBLISHED_BASE_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';

// Free public RPCs of the test networks that the published documents name. Mainnet chains are not in this list:
// pass RPC_URL_<chainId> for them.
const PUBLIC_RPC = {
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  84532: 'https://sepolia.base.org',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
  5042002: 'https://rpc.testnet.arc.io'
};

// The two Calibur deployments that the repository names. `0x00000cAb…` is the pin of the Sepolia onramp prototype,
// with the hash in `src/lib/evm-relay/batch/testing.ts`. `0x000000009B1D…` is the address of the relay unit tests
// (`src/lib/evm-relay/testing.ts`), which pin no real hash; its expected hash here is the one that lib.mjs pins for
// the local test.
const DEFAULT_CALIBURS = [
  {
    address: '0x00000cabfc76478c1537dd418ab00967cbbe4ae6',
    runtimeHash: '0xd8f2157116f6901840d009511732cb247c1ced614af48351f1c1e5d52deea1eb'
  },
  { address: CANONICAL_CALIBUR.address, runtimeHash: CANONICAL_CALIBUR.runtimeHash }
];

const CALIBUR_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
]);
const RELAY_NONCE_KEY = BigInt(keccak256(stringToHex('miden.relay'))) >> 64n;

const { values } = parseArgs({
  options: {
    network: { type: 'string', default: 'testnet' },
    calibur: { type: 'string', multiple: true },
    chain: { type: 'string', multiple: true },
    'config-url': { type: 'string', default: PUBLISHED_BASE_URL }
  }
});

function calibursFromArgs() {
  if (!values.calibur) return DEFAULT_CALIBURS;
  return values.calibur.map(entry => {
    const [address, runtimeHash] = entry.split('=');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error(`--calibur: not an address: ${entry}`);
    if (runtimeHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(runtimeHash)) {
      throw new Error(`--calibur: not a 32-byte hash: ${entry}`);
    }
    return { address: address.toLowerCase(), runtimeHash: runtimeHash?.toLowerCase() ?? null };
  });
}

function short(error) {
  const text = error?.details ?? error?.shortMessage ?? error?.message ?? String(error);
  return String(text).split('\n')[0].slice(0, 160);
}

// A PUSH4 of the selector: how solc dispatches a function. Not a proof, a strong sign.
function hasSelector(code, selector) {
  return code.toLowerCase().includes(`63${selector.slice(2).toLowerCase()}`);
}

function tokensOf(bridge) {
  return bridge?.tokens
    ? Object.entries(bridge.tokens).map(([symbol, token]) => `${symbol} ${token.contractAddress}`)
    : [];
}

async function probeCalibur(client, chainId, calibur) {
  const code = await client.getCode({ address: calibur.address });
  if (!code || code === '0x') return { address: calibur.address, present: false };
  const hash = keccak256(code);
  const execute = toFunctionSelector(CALIBUR_ABI.find(item => item.name === 'execute'));
  const getSeq = toFunctionSelector(CALIBUR_ABI.find(item => item.name === 'getSeq'));
  // A throwaway address with the Calibur code, as the Worker's account read does.
  const probe = privateKeyToAccount(generatePrivateKey()).address;
  const override = [{ address: probe, code }];
  let domain = null;
  let sequence = null;
  try {
    const { data } = await client.call({
      to: probe,
      data: encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'eip712Domain' }),
      stateOverride: override
    });
    const [, name, version, domainChainId, verifyingContract, salt] = decodeFunctionResult({
      abi: CALIBUR_ABI,
      functionName: 'eip712Domain',
      data
    });
    domain = {
      name,
      version,
      chainIdMatches: Number(domainChainId) === chainId,
      verifyingContractIsProbe: verifyingContract.toLowerCase() === probe.toLowerCase(),
      saltNamesCalibur: salt.slice(-40).toLowerCase() === calibur.address.slice(2)
    };
    const seq = await client.call({
      to: probe,
      data: encodeFunctionData({ abi: CALIBUR_ABI, functionName: 'getSeq', args: [RELAY_NONCE_KEY] }),
      stateOverride: override
    });
    sequence = decodeFunctionResult({ abi: CALIBUR_ABI, functionName: 'getSeq', data: seq.data }).toString();
  } catch (error) {
    domain = { error: short(error) };
  }
  return {
    address: calibur.address,
    present: true,
    bytes: (code.length - 2) / 2,
    runtimeHash: hash,
    expectedHash: calibur.runtimeHash,
    hashMatches: calibur.runtimeHash === null ? null : calibur.runtimeHash === hash,
    executeSelector: hasSelector(code, execute),
    getSeqSelector: hasSelector(code, getSeq),
    domain,
    sequence
  };
}

async function probe7702(client, chainId, caliburAddress) {
  const account = privateKeyToAccount(generatePrivateKey());
  const authorization = await account.signAuthorization({ address: caliburAddress, chainId, nonce: 0 });
  const result = {};
  // A type-4 transaction from an address with no funds. Only the reason of the refusal matters. An `eth_call` with
  // an authorization list proves nothing here: the public nodes ignore the list and run no code (see the Worker
  // README, step 10 of the relay), so the Worker and this script use a state override for the Calibur reads.
  try {
    const fees = await client.estimateFeesPerGas();
    const raw = await account.signTransaction({
      type: 'eip7702',
      chainId,
      nonce: 0,
      to: account.address,
      gas: 100_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      authorizationList: [authorization]
    });
    await client.request({ method: 'eth_sendRawTransaction', params: [raw] });
    result.type4Broadcast = 'accepted (unexpected for an address with no funds)';
  } catch (error) {
    const reason = short(error);
    const live = /insufficient funds|gas \* price \+ value|balance/i.test(reason);
    result.type4Broadcast = `${live ? 'type 4 accepted, refused for funds' : 'refused'}: ${reason}`;
  }
  return result;
}

const caliburs = calibursFromArgs();
const base = values['config-url'].replace(/\/+$/, '');
const response = await fetch(`${base}/${values.network}.json`, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`The document read failed (${response.status})`);
const document = await response.json();
console.log(`Document ${values.network}.json version ${document.version}`);

for (const [key, chain] of Object.entries(document.supportedEvmChains ?? {})) {
  if (values.chain && !values.chain.includes(key)) continue;
  const chainId = chain.chainId;
  const bridges = chain.bridges ?? {};
  console.log(`\n== ${key} (chain ${chainId})`);
  console.log(`   routes: ${Object.keys(bridges).join(', ') || 'none'}`);
  console.log(`   agglayer tokens: ${tokensOf(bridges.agglayer).join('; ') || 'none'}`);
  console.log(`   epoch tokens: ${tokensOf(bridges.epoch).join('; ') || 'none'}`);
  const fromEnv = process.env[`RPC_URL_${chainId}`];
  const rpcUrl = fromEnv || PUBLIC_RPC[chainId];
  if (!rpcUrl) {
    console.log(`   no RPC: set RPC_URL_${chainId}`);
    continue;
  }
  console.log(`   rpc: ${fromEnv ? `RPC_URL_${chainId}` : rpcUrl}`);
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  try {
    const actual = await client.getChainId();
    if (actual !== chainId) {
      console.log(`   the RPC answers chain ${actual}, not ${chainId}: skipped`);
      continue;
    }
  } catch (error) {
    console.log(`   the RPC does not answer: ${short(error)}`);
    continue;
  }
  let live = null;
  for (const calibur of caliburs) {
    try {
      const found = await probeCalibur(client, chainId, calibur);
      console.log(`   calibur ${JSON.stringify(found)}`);
      if (found.present && live === null) live = calibur.address;
    } catch (error) {
      console.log(`   calibur ${calibur.address}: read failed: ${short(error)}`);
    }
  }
  if (live === null) {
    console.log('   eip7702: not probed (no Calibur code)');
    continue;
  }
  try {
    console.log(`   eip7702 ${JSON.stringify(await probe7702(client, chainId, live))}`);
  } catch (error) {
    console.log(`   eip7702: probe failed: ${short(error)}`);
  }
}

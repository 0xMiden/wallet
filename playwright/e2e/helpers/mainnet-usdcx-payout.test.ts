/**
 * @jest-environment node
 */
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  isHex,
  pad,
  type Address,
  type Hash,
  type Hex,
  type Log
} from 'viem';

import { XRESERVE_HARNESS_ABI } from './arc-usdcx';
import type { MainnetUsdcxDocument } from './mainnet-bridge-sources';
import { readMainnetGatewaySource, verifyMainnetPayout, type PayoutReadClient } from './mainnet-usdcx-payout';
import { ATTESTATION_USED_TOPIC } from './usdcx-constants';

const MINTER: Address = '0x2222222d7164433c4C09B0b0D809a9b52C04C205';
const DEPOSITOR: Address = '0xBf24D0DEe512f5C6c3337bB46c6f0386BFe2F1b8';
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KEY: Address = '0x5d2b7b0cc7cf4d8f2c2c3e7c2c4de0c0f1a2b3c4';
const NOTE_ID = '0x6a1f0c9e2b7d4a35c8e1f02b9d74c6a1e3b5f7d9c0a2e4b6d8f0a1c3e5b7d9f1';
const MINT: Hash = '0x9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';
const BURN_UNITS = 5_000_000n;

interface MintLog {
  address?: Address;
  token?: Address;
  sourceDomain?: number;
  depositor?: Address;
  value?: bigint;
}

function mintLog(overrides: MintLog = {}): Log {
  const data = encodeAbiParameters(
    [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
    [overrides.sourceDomain ?? 26, pad(overrides.depositor ?? DEPOSITOR), pad('0x01'), overrides.value ?? 4_990_000n]
  );
  return {
    address: overrides.address ?? MINTER,
    topics: [ATTESTATION_USED_TOPIC, pad(overrides.token ?? BASE_USDC), pad(KEY), pad('0x02')],
    data,
    blockHash: pad('0x03'),
    blockNumber: 38_000_000n,
    logIndex: 4,
    transactionHash: MINT,
    transactionIndex: 1,
    removed: false
  };
}

/** gatewayMint calldata: Circle's TransferSpec carries the burn note id as its salt. */
const MINT_INPUT: Hex = `0x2a3b4c5d${'00'.repeat(32)}${NOTE_ID.slice(2)}${'00'.repeat(16)}`;

function fakeClient(logs: Log[], input: Hex = MINT_INPUT): PayoutReadClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async getTransactionReceipt({ hash }) {
      asked.push(`receipt ${hash}`);
      return { logs };
    },
    async getTransaction({ hash }) {
      asked.push(`transaction ${hash}`);
      return { input };
    }
  };
}

const args = (client: PayoutReadClient, walletValue = 4_990_000n) => ({
  chainId: 8453,
  transactionHash: MINT,
  recipient: KEY,
  usdc: BASE_USDC,
  burnNoteId: NOTE_ID,
  burnUnits: BURN_UNITS,
  walletValue,
  gatewayMinter: MINTER,
  depositor: DEPOSITOR,
  client
});

describe('verifyMainnetPayout', () => {
  it('accepts the mint the wallet recorded', async () => {
    const client = fakeClient([mintLog()]);
    await expect(verifyMainnetPayout(args(client))).resolves.toEqual({ value: 4_990_000n, fee: 10_000n });
    expect(client.asked).toEqual([`receipt ${MINT}`, `transaction ${MINT}`]);
  });

  it('refuses a value the wallet did not record', async () => {
    const failure = verifyMainnetPayout(args(fakeClient([mintLog()]), 4_980_000n));
    await expect(failure).rejects.toThrow(/chain 8453/);
    await expect(failure).rejects.toThrow(NOTE_ID);
    await expect(failure).rejects.toThrow(/value 4990000, the wallet recorded 4980000/);
  });

  it('refuses a log from another minter', async () => {
    const other: Address = '0x1111111111111111111111111111111111111111';
    const failure = verifyMainnetPayout(args(fakeClient([mintLog({ address: other })])));
    await expect(failure).rejects.toThrow(NOTE_ID);
    await expect(failure).rejects.toThrow(
      /found 0 AttestationUsed logs from 0x2222222d7164433c4C09B0b0D809a9b52C04C205/
    );
  });

  it('refuses a transaction without the note id', async () => {
    const failure = verifyMainnetPayout(args(fakeClient([mintLog()], `0x2a3b4c5d${'00'.repeat(96)}`)));
    await expect(failure).rejects.toThrow(/chain 8453/);
    await expect(failure).rejects.toThrow(`calldata lacks the burn note id ${NOTE_ID}`);
  });

  it('refuses a mint of another token, source or depositor, and two mints in one transaction', async () => {
    const otherToken: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    await expect(verifyMainnetPayout(args(fakeClient([mintLog({ token: otherToken })])))).rejects.toThrow(
      /found 0 AttestationUsed logs/
    );
    await expect(verifyMainnetPayout(args(fakeClient([mintLog({ sourceDomain: 6 })])))).rejects.toThrow(
      /sourceDomain 6, expected 26/
    );
    await expect(verifyMainnetPayout(args(fakeClient([mintLog({ depositor: KEY })])))).rejects.toThrow(
      /sourceDepositor .* expected .*bf24d0dee512f5c6c3337bb46c6f0386bfe2f1b8/i
    );
    await expect(verifyMainnetPayout(args(fakeClient([mintLog(), mintLog()])))).rejects.toThrow(
      /found 2 AttestationUsed logs/
    );
  });

  it('refuses a zero mint and a mint above the burn, even when the wallet recorded it', async () => {
    await expect(verifyMainnetPayout(args(fakeClient([mintLog({ value: 0n })]), 0n))).rejects.toThrow(
      /value 0 is not between 1 and the burn's 5000000/
    );
    await expect(verifyMainnetPayout(args(fakeClient([mintLog({ value: 5_000_001n })]), 5_000_001n))).rejects.toThrow(
      /value 5000001 is not between 1 and the burn's 5000000/
    );
  });
});

describe('readMainnetGatewaySource', () => {
  const XRESERVE: Address = '0x8888888199b2Df864bf678259607d6D5EBb4e3Ce';
  const doc: MainnetUsdcxDocument = {
    'bridge-providers': {
      usdcx: { midenDomain: 10007, attestationUrl: 'https://attest.example', irisUrl: 'https://iris.example' },
      agglayer: { indexerUrl: 'https://indexer.example' }
    },
    supportedEvmChains: {
      arc: {
        chainId: 5042,
        bridges: {
          usdcx: {
            domain: 26,
            deposit: { route: 'xreserve', xReserve: XRESERVE },
            tokens: { USDC: { contractAddress: '0x3600000000000000000000000000000000000000' } }
          }
        }
      }
    }
  };

  it("reads the minter and Miden's depositor from the Arc xReserve in the mainnet document", async () => {
    const asked: string[] = [];
    const client = createPublicClient({
      cacheTime: 0,
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown }) {
            if (method !== 'eth_call' || !Array.isArray(params)) throw new Error(`unexpected ${method}`);
            const [request] = params;
            const to: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'to') : '';
            const data: unknown = request !== null && typeof request === 'object' ? Reflect.get(request, 'data') : '';
            if (!isHex(data)) throw new Error('eth_call without data');
            const call = decodeFunctionData({ abi: XRESERVE_HARNESS_ABI, data });
            asked.push(`${String(to).toLowerCase()} ${call.functionName}(${(call.args ?? []).map(String).join(',')})`);
            const answer = call.functionName === 'gatewayMinter' ? MINTER : DEPOSITOR;
            return encodeAbiParameters([{ type: 'address' }], [answer]);
          }
        },
        { retryCount: 0 }
      )
    });

    await expect(readMainnetGatewaySource(doc, client)).resolves.toEqual({
      gatewayMinter: MINTER,
      depositor: DEPOSITOR
    });
    expect(asked.sort()).toEqual([
      `${XRESERVE.toLowerCase()} gatewayMinter()`,
      `${XRESERVE.toLowerCase()} getRemoteDomainDepositor(10007)`
    ]);
  });
});

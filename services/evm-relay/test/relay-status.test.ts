/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import type { Hex } from 'viem';

import { bodyOf, chainEntry, createHarness, send, type Harness } from './harness';
import type { SubmitJob } from '../src/sender';

const CONFIG = JSON.stringify({ chains: { '8453': chainEntry(), '1': chainEntry(false) } });
const CALLER = { 'CF-Connecting-IP': '203.0.113.7' };
const ID_BASE: Hex = `0x${'b1'.repeat(32)}`;
const ID_MAINNET: Hex = `0x${'e1'.repeat(32)}`;
const UNKNOWN: Hex = `0x${'99'.repeat(32)}`;

function job(chainId: number, id: Hex): SubmitJob {
  return {
    id,
    chainId,
    evmAddress: `0x${'0a'.repeat(20)}`,
    data: '0xdeadbeef',
    gas: 240_000n,
    maxFeePerGas: 2_100_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    authorization: null,
    deadline: 1_900_000_000,
    chainNonce: 5
  };
}

/** A harness with one stored relay on chain 8453 and one on chain 1. Return their transaction hashes. */
async function stored(): Promise<{ harness: Harness; base: Hex; mainnet: Hex }> {
  const harness = createHarness({ relayConfig: CONFIG });
  const base = await harness.senders.senderOf(8453).submit(job(8453, ID_BASE));
  const mainnet = await harness.senders.senderOf(1).submit(job(1, ID_MAINNET));
  if (base.status !== 'job' || mainnet.status !== 'job') throw new Error('A relay was not stored');
  return { harness, base: base.job.txHash, mainnet: mainnet.job.txHash };
}

function status(harness: Harness, id: string, query = ''): Promise<Response> {
  return send(harness, `/v1/relay/${id}${query}`, { headers: CALLER });
}

describe('GET /v1/relay/{id}', () => {
  it('finds a relay on the first chain and on a later chain', async () => {
    const { harness, base, mainnet } = await stored();
    const first = await status(harness, ID_BASE);
    expect(first.status).toBe(200);
    await expect(bodyOf(first)).resolves.toEqual({ id: ID_BASE, state: 'pending', txHash: base });
    const later = await status(harness, ID_MAINNET.toUpperCase().replace('0X', '0x'));
    await expect(bodyOf(later)).resolves.toEqual({ id: ID_MAINNET, state: 'pending', txHash: mainnet });
    expect(harness.readLimit.keys).toEqual(['read:203.0.113.7', 'read:203.0.113.7']);
  });

  it('shows the state that the timer recorded', async () => {
    const { harness, base } = await stored();
    harness.senders.receipts.set(base, 'reverted');
    await harness.senders.tick(8453);
    await expect(bodyOf(await status(harness, ID_BASE))).resolves.toEqual({
      id: ID_BASE,
      state: 'reverted',
      txHash: base
    });
  });

  it('answers 404 not_found for an unknown id', async () => {
    const { harness } = await stored();
    const response = await status(harness, UNKNOWN);
    expect(response.status).toBe(404);
    await expect(bodyOf(response)).resolves.toEqual({ error: 'not_found', message: 'The relay does not exist.' });
  });

  it('asks only the chain of the chainId query', async () => {
    const { harness, mainnet } = await stored();
    await expect(bodyOf(await status(harness, ID_MAINNET, '?chainId=1'))).resolves.toEqual({
      id: ID_MAINNET,
      state: 'pending',
      txHash: mainnet
    });
    expect((await status(harness, ID_MAINNET, '?chainId=8453')).status).toBe(404);
  });

  it.each([
    ['an unknown chain', '?chainId=10', 'unsupported_chain'],
    ['a chainId that is not a number', '?chainId=base', 'invalid_request'],
    ['an empty chainId', '?chainId=', 'invalid_request']
  ])('answers 400 for %s', async (_name, query, code) => {
    const { harness } = await stored();
    const response = await status(harness, ID_BASE, query);
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe(code);
  });

  it('answers 404 for a malformed id without a charge', async () => {
    const { harness } = await stored();
    expect((await status(harness, ID_BASE.slice(0, -1))).status).toBe(404);
    expect(harness.readLimit.keys).toEqual([]);
  });

  it('refuses a caller over the read limit before it reads a Sender', async () => {
    const { harness } = await stored();
    harness.readLimit.allow(0);
    const response = await status(harness, ID_BASE);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });
});

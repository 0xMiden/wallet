import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import { CALIBUR_SEPOLIA_ADDRESS, SEPOLIA_CHAIN_ID } from './calibur.js';
import { createSepoliaChain } from './sepolia.js';

const relayerPrivateKey: Hex = `0x${'01'.repeat(32)}`;
const buyer = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const rpcSchema = z.object({ id: z.number(), method: z.string() });
const rawSchema = z.object({
  params: z.tuple([z.custom<Hex>(value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))])
});

describe('local relay signing', () => {
  for (const delegated of [false, true]) {
    it(`stores a reproducible ${delegated ? 'type-2' : 'type-4'} transaction before broadcast`, async () => {
      const methods: string[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          const { id, method } = rpcSchema.parse(JSON.parse(body));
          methods.push(method);
          if (method === 'eth_fillTransaction') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
            return;
          }
          function result() {
            switch (method) {
              case 'eth_estimateGas':
                return '0x186a0';
              case 'eth_getTransactionCount':
                return '0x3';
              case 'eth_chainId':
                return '0xaa36a7';
              case 'eth_getBlockByNumber':
                return { baseFeePerGas: '0x3b9aca00', transactions: [] };
              case 'eth_maxPriorityFeePerGas':
                return '0x3b9aca00';
              case 'eth_sendRawTransaction':
                return keccak256(rawSchema.parse(JSON.parse(body)).params[0]);
              default:
                throw new Error(`Unexpected RPC method: ${method}`);
            }
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id, result: result() }));
        });
      });
      server.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      try {
        const chain = createSepoliaChain({ rpcUrl: `http://127.0.0.1:${address.port}`, relayerPrivateKey });
        const authorization = delegated
          ? null
          : await buyer.signAuthorization({
              address: CALIBUR_SEPOLIA_ADDRESS,
              chainId: SEPOLIA_CHAIN_ID,
              nonce: 0
            });
        const prepared = await chain.prepareRelay({ to: buyer.address, data: '0x1234', authorization }, 8);
        assert.equal(methods.includes('eth_sendRawTransaction'), false);
        assert.equal(prepared.hash, keccak256(prepared.serializedTransaction));
        const transaction = parseTransaction(prepared.serializedTransaction);
        assert.equal(transaction.type, delegated ? 'eip1559' : 'eip7702');
        assert.equal(transaction.nonce, 8);
        assert.equal(transaction.gas, 120000n);
        assert.equal(transaction.data, '0x1234');
        assert.equal(await chain.broadcastRelay(prepared.serializedTransaction), prepared.hash);
        assert.equal(await chain.broadcastRelay(prepared.serializedTransaction), prepared.hash);
        assert.equal(methods.filter(method => method === 'eth_sendRawTransaction').length, 2);
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      }
    });
  }
});
